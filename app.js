const STORAGE_KEY = 'bossSplitLedger.v1';
const REMOTE_URL_KEY = 'bossSplitLedger.remoteUrl.v1';
const CLIENT_ID_KEY = 'bossSplitLedger.clientId.v1';
const APP_VERSION = '5.2.0';
const DEFAULT_REMOTE_URL = (window.BOSS_SPLIT_REMOTE_URL || '').trim() || 'https://script.google.com/macros/s/AKfycbwn3g81buXd0YFZsq3qdXFJxk6KCKfMlR1WXEdMffAUsoq3glf9PVr5zebCJvkrL7H2/exec'; // 기본 공유 저장소 URL

const statusMap = {
  waiting: { label: '정산대기', cls: 'waiting' },
  settling: { label: '정산대기', cls: 'waiting' },
  done: { label: '완료', cls: 'done' },
  draft: { label: '드랍등록', cls: 'draft' },
};

const defaultState = () => ({
  activeTab: 'home',
  detailId: null,
  settings: {
    feeMode: 'percent',
    feeValue: 5,
    roundingMode: 'floor_001',
    cashRatePerBillion: 0,
    bosses: ['하드 스우', '하드 데미안', '가디언 엔젤 슬라임', '진 힐라', '카오스 더스크', '듄켈', '검은 마법사', '세렌', '칼로스', '카링'],
  },
  parties: [
    { id: uid(), name: '기본 파티', members: ['하람', '예원', '민수', '준호'] },
  ],
  entries: [],
});

let state = loadState();
let toastTimer = null;
let remoteSaveTimer = null;
let remoteStatus = 'local';
let remoteUpdatedAt = localStorage.getItem('bossSplitLedger.remoteUpdatedAt.v1') || '';
let suppressRemoteSave = false;
let selectedEntryIds = new Set();
let lastBatchShareText = sessionStorage.getItem('bossSplit.lastBatchShare.v5') || '';
const clientId = getOrCreateClientId();

const $ = (selector) => document.querySelector(selector);
const app = $('#app');

init();

function init() {
  // 새로 열 때는 항상 홈에서 시작합니다. 마지막으로 열어둔 탭/상세 화면은 공유 데이터가 아니라 UI 상태입니다.
  state.activeTab = 'home';
  state.detailId = null;
  saveState({ localOnly: true });
  bindGlobalEvents();
  setTodayToEntryDialog();
  render();
  loadRemoteOnStart();
}


function bindGlobalEvents() {
  $('#quickAddBtn').addEventListener('click', function () { openBulkEntryDialog(); });
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.activeTab = btn.dataset.tab;
      state.detailId = null;
      saveState({ localOnly: true });
      render();
    });
  });
  document.querySelectorAll('[data-close-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function () { $('#entryDialog').close(); });
  });
  document.querySelectorAll('[data-close-sale-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function () { $('#saleDialog').close(); });
  });
  document.querySelectorAll('[data-close-party-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function () { $('#partyDialog').close(); });
  });

  $('#entryForm').addEventListener('submit', handleBulkEntrySubmit);
  $('#addEntryRowBtn').addEventListener('click', addBulkEntryRowFromPrevious);
  $('#entryRows').addEventListener('click', function (event) {
    const button = event.target.closest('[data-entry-row-action]');
    if (!button) return;
    const row = button.closest('tr[data-entry-row]');
    if (!row) return;
    if (button.dataset.entryRowAction === 'remove') {
      const rows = Array.from($('#entryRows').querySelectorAll('tr[data-entry-row]'));
      if (rows.length <= 1) {
        row.querySelector('[data-field="item"]').value = '';
        row.querySelector('[data-field="salePrice"]').value = '';
        row.querySelector('[data-field="recipient"]').value = '';
      } else {
        row.remove();
      }
      updateBulkEntrySubmitLabel();
    }
  });
  $('#entryRows').addEventListener('change', function (event) {
    const target = event.target;
    const row = target.closest('tr[data-entry-row]');
    if (target.matches('[data-field="partyId"]')) syncBulkEntryMembersFromParty(row);
    if (target.matches('[data-field="members"]')) syncBulkEntryRecipientOptions(row);
    updateBulkEntrySubmitLabel();
  });
  $('#entryRows').addEventListener('input', function (event) {
    const target = event.target;
    if (target.matches('[data-field="members"]')) syncBulkEntryRecipientOptions(target.closest('tr[data-entry-row]'));
    updateBulkEntrySubmitLabel();
  });

  $('#saleForm').addEventListener('submit', handleSaleSubmit);
  ['salePrice', 'feeMode', 'feeValue', 'excludeAmount', 'cashRatePerBillion', 'sellerName', 'roundingMode'].forEach(function (id) {
    const el = document.getElementById(id);
    el.addEventListener('input', renderCalcPreview);
    el.addEventListener('change', renderCalcPreview);
  });
  $('#feeMode').addEventListener('change', function () {
    $('#feeValueLabel').textContent = $('#feeMode').value === 'percent' ? '수수료 %' : '수수료 금액, 억 단위';
  });
  $('#partyForm').addEventListener('submit', handlePartySubmit);
  app.addEventListener('click', handleAppClick);
  app.addEventListener('change', handleAppChange);
}

function setTodayToEntryDialog() {}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

function normalizeState(data) {
  const fresh = defaultState();
  const next = {
    ...fresh,
    ...data,
    settings: { ...fresh.settings, ...(data.settings || {}) },
    parties: Array.isArray(data.parties) && data.parties.length ? data.parties : fresh.parties,
    entries: Array.isArray(data.entries) ? data.entries : [],
  };
  next.parties = next.parties.map((party) => ({
    id: party.id || uid(),
    name: party.name || '이름 없는 파티',
    members: Array.isArray(party.members) ? party.members.filter(Boolean) : [],
  }));
  next.entries = next.entries.map((entry) => ({
    id: entry.id || uid(),
    date: normalizeDateValue(entry.date) || new Date().toISOString().slice(0, 10),
    boss: entry.boss || '보스 미입력',
    partyName: entry.partyName || '임시 파티',
    members: Array.isArray(entry.members) ? entry.members.filter(Boolean) : [],
    item: entry.item || '아이템 미입력',
    expectedPrice: numberOrZero(entry.expectedPrice),
    memo: entry.memo || '',
    status: entry.status || 'waiting',
    createdAt: entry.createdAt || new Date().toISOString(),
    sale: entry.sale || null,
    payments: entry.payments || {},
  }));
  next.entries.forEach((entry) => {
    if (entry.sale) {
      entry.sale.cashRatePerBillion = numberOrZero(entry.sale.cashRatePerBillion);
      entry.sale.sellerName = entry.sale.sellerName || entry.members[0] || '';
      entry.sale.totalCash = numberOrZero(entry.sale.totalCash);
      entry.sale.perPersonCash = numberOrZero(entry.sale.perPersonCash);
      entry.sale.transferCash = numberOrZero(entry.sale.transferCash);
      if (entry.sale.cashRatePerBillion > 0 && (!entry.sale.totalCash || !entry.sale.perPersonCash)) {
        entry.sale.totalCash = roundWon(entry.sale.netAmount * entry.sale.cashRatePerBillion);
        entry.sale.perPersonCash = roundWon(entry.sale.perPerson * entry.sale.cashRatePerBillion);
        const receiverCount = Math.max(0, entry.members.filter((m) => m !== entry.sale.sellerName).length);
        entry.sale.transferCash = roundWon(entry.sale.perPersonCash * receiverCount);
      }
      if (entry.sale.sellerName) {
        entry.payments = entry.payments || {};
        entry.payments[entry.sale.sellerName] = true;
      }
    }
  });
  return next;
}

function saveState(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, detailId: state.detailId || null }));
  if (!options.localOnly && !suppressRemoteSave) queueRemoteSave();
}

function serializeSharedState() {
  return {
    appVersion: APP_VERSION,
    settings: state.settings,
    parties: state.parties,
    entries: state.entries,
    updatedAt: new Date().toISOString(),
    updatedBy: clientId,
  };
}

function getRemoteUrl() {
  return (localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL || '').trim();
}

function setRemoteUrl(url) {
  localStorage.setItem(REMOTE_URL_KEY, String(url || '').trim());
}

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

function updateSyncBadge() {
  const badge = $('#syncBadge');
  if (!badge) return;
  const url = getRemoteUrl();
  const labels = {
    local: url ? '연결됨' : '로컬',
    loading: '불러오는 중',
    saving: '저장 중',
    saved: '공유 저장됨',
    error: '동기화 확인',
  };
  badge.textContent = labels[remoteStatus] || (url ? '연결됨' : '로컬');
  badge.className = `sync-badge ${remoteStatus}`;
}

function setRemoteStatus(status, message = '') {
  remoteStatus = status;
  updateSyncBadge();
  if (message) showToast(message);
}

async function loadRemoteOnStart() {
  if (!getRemoteUrl()) {
    setRemoteStatus('local');
    return;
  }
  await pullRemoteState({ silent: true, initial: true });
}

function queueRemoteSave() {
  if (!getRemoteUrl()) {
    setRemoteStatus('local');
    return;
  }
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => pushRemoteState({ silent: true }), 700);
}

async function pushRemoteState({ silent = false } = {}) {
  const url = getRemoteUrl();
  if (!url) {
    if (!silent) showToast('설정에서 Apps Script 웹앱 URL을 먼저 입력하세요.');
    setRemoteStatus('local');
    return;
  }
  setRemoteStatus('saving');
  try {
    const result = await remoteRequest(url, 'save', { state: serializeSharedState(), clientId });
    if (!result?.ok) throw new Error(result?.message || 'remote save failed');
    remoteUpdatedAt = result.updatedAt || new Date().toISOString();
    localStorage.setItem('bossSplitLedger.remoteUpdatedAt.v1', remoteUpdatedAt);
    setRemoteStatus('saved', silent ? '' : '공유 저장소에 올렸습니다.');
  } catch (error) {
    console.warn(error);
    setRemoteStatus('error', silent ? '' : '공유 저장에 실패했습니다. URL/배포 권한을 확인하세요.');
  }
}

async function pullRemoteState({ silent = false, initial = false } = {}) {
  const url = getRemoteUrl();
  if (!url) {
    if (!silent) showToast('설정에서 Apps Script 웹앱 URL을 먼저 입력하세요.');
    setRemoteStatus('local');
    return;
  }
  setRemoteStatus('loading');
  try {
    const result = await remoteRequest(url, 'load');
    if (!result?.ok) throw new Error(result?.message || 'remote load failed');
    if (result.empty) {
      await pushRemoteState({ silent: true });
      if (!silent) showToast('공유 저장소가 비어 있어 현재 데이터를 올렸습니다.');
      return;
    }
    const keepTab = initial ? 'home' : (state.activeTab || 'home');
    const normalized = normalizeState(result.state || {});
    state = { ...normalized, activeTab: keepTab, detailId: null };
    remoteUpdatedAt = result.updatedAt || result.state?.updatedAt || '';
    localStorage.setItem('bossSplitLedger.remoteUpdatedAt.v1', remoteUpdatedAt);
    suppressRemoteSave = true;
    saveState({ localOnly: true });
    suppressRemoteSave = false;
    setRemoteStatus('saved', silent ? '' : '공유 데이터를 불러왔습니다.');
    render();
  } catch (error) {
    console.warn(error);
    setRemoteStatus('error', silent ? '' : '공유 데이터 불러오기에 실패했습니다.');
  }
}

async function remoteRequest(baseUrl, action, payload = null) {
  const url = normalizeRemoteUrl(baseUrl);
  if (action === 'load') {
    const queryUrl = `${url}?action=load&t=${Date.now()}`;
    try {
      const res = await fetch(queryUrl, { method: 'GET', cache: 'no-store', redirect: 'follow' });
      return await res.json();
    } catch (error) {
      return jsonpRequest(`${queryUrl}&callback=__bossSplitJsonp`);
    }
  }

  const body = JSON.stringify({ action, ...payload });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
    });
    return await res.json();
  } catch (error) {
    if (body.length > 90000) throw error;
    const fallbackUrl = `${url}?action=${encodeURIComponent(action)}&data=${encodeURIComponent(body)}&t=${Date.now()}&callback=__bossSplitJsonp`;
    return jsonpRequest(fallbackUrl);
  }
}

function normalizeRemoteUrl(url) {
  return String(url || '').trim().replace(/\?$/, '');
}

function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `__bossSplitJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const separator = url.includes('?') ? '&' : '?';
    script.src = url.replace('__bossSplitJsonp', callbackName) + (url.includes('callback=') ? '' : `${separator}callback=${callbackName}`);
    const timer = setTimeout(() => { cleanup(); reject(new Error('jsonp timeout')); }, 12000);
    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }
    window[callbackName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('jsonp failed')); };
    document.body.appendChild(script);
  });
}

function render() {
  updateNav();
  updateSyncBadge();
  if (state.detailId) {
    renderDetail(state.detailId);
    return;
  }
  const map = {
    home: renderHome,
    waiting: () => renderList('waiting'),
    settling: () => renderList('waiting'),
    done: () => renderDone(),
    settings: renderSettings,
  };
  (map[state.activeTab] || renderHome)();
}

function updateNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });
}


function renderHome() {
  const currentMonth = dateToYmd(new Date()).slice(0, 7);
  const summaryMonth = sessionStorage.getItem('bossSplit.summaryMonth') || currentMonth;
  const monthEntries = state.entries.filter(function (e) { return e.date.startsWith(currentMonth); });
  const pending = state.entries.filter(isPendingEntry).length;
  const doneThisMonth = monthEntries.filter(function (e) { return e.status === 'done'; }).length;
  const recent = state.entries.slice().sort(sortRecent).slice(0, 5);

  app.innerHTML = `
    <section class="card">
      <div class="summary-grid">
        <div class="stat"><span>정산대기</span><b>${pending}</b></div>
        <div class="stat"><span>이번 달 완료</span><b>${doneThisMonth}</b></div>
        <div class="stat"><span>전체 기록</span><b>${state.entries.length}</b></div>
      </div>
      <button class="big-action" data-action="new-entry">+ 정산 등록</button>
    </section>

    ${renderMonthlySummary(summaryMonth)}

    <div class="section-title">
      <h2>최근 정산</h2>
      <span class="sub">최신 5건</span>
    </div>
    ${recent.length ? `<div class="list">${recent.map(entryCard).join('')}</div>` : emptyState('아직 정산 기록이 없습니다', '판매된 아이템을 정산 등록하면 이곳에 표시됩니다.')}
  `;

  $('#summaryMonth')?.addEventListener('change', function (event) {
    sessionStorage.setItem('bossSplit.summaryMonth', event.target.value);
    renderHome();
  });
}

function renderList() {
  const list = state.entries.filter(isPendingEntry).sort(sortRecent);
  const validIds = new Set(list.map(function (e) { return e.id; }));
  selectedEntryIds = new Set(Array.from(selectedEntryIds).filter(function (id) { return validIds.has(id); }));
  const groups = getStoredGroups(list);
  const selected = getSelectedPendingEntries();
  const summary = getBatchSelectionSummary(selected);
  const targetOptions = groups.map(function (group) {
    return `<option value="${escapeHtml(group.id)}">${escapeHtml(getGroupLabel(group))}</option>`;
  }).join('');

  app.innerHTML = `
    <section class="card">
      <h2>정산대기</h2>
      <p class="item-sub">한 번에 등록한 행은 하나의 그룹입니다. 그룹에 항목을 더 넣거나, 따로 만든 항목을 기존 그룹으로 합칠 수 있습니다.</p>
      <button class="big-action" data-action="new-entry">+ 정산 등록</button>
    </section>

    <section class="batch-toolbar">
      <div class="batch-summary">
        <b>선택 ${selected.length}건</b>
        <span>${escapeHtml(summary)}</span>
      </div>
      <div class="batch-actions">
        <button class="ghost small" data-action="select-all-pending" ${list.length ? '' : 'disabled'}>전체 선택</button>
        <button class="ghost small" data-action="clear-selection" ${selected.length ? '' : 'disabled'}>선택 해제</button>
        <button class="primary batch-complete" data-action="complete-selected" ${selected.length ? '' : 'disabled'}>선택 그룹 정산 완료</button>
      </div>
      <div class="group-merge-row">
        <select id="mergeTargetGroup" ${groups.length ? '' : 'disabled'}>
          <option value="">편입할 대상 그룹 선택</option>
          ${targetOptions}
        </select>
        <button class="secondary" data-action="merge-selected-group" ${selected.length && groups.length ? '' : 'disabled'}>선택 항목을 그룹에 편입</button>
      </div>
    </section>

    <div class="section-title"><h2>정산 그룹</h2><span class="sub">${groups.length}그룹 · ${list.length}건</span></div>
    ${groups.length ? `<div class="group-list">${groups.map(pendingGroupCard).join('')}</div>` : emptyState('정산대기 기록이 없습니다', '정산을 등록하면 그룹 단위로 이곳에 표시됩니다.')}
  `;
}

function renderDone() {
  const keyword = sessionStorage.getItem('bossSplit.search') || '';
  const done = state.entries.filter(function (e) { return e.status === 'done'; });
  const filtered = filterEntries(done, keyword);
  const matchedGroupIds = new Set(filtered.map(getEntryGroupId));
  const visible = keyword ? done.filter(function (entry) { return matchedGroupIds.has(getEntryGroupId(entry)); }) : done;
  const groups = getStoredGroups(visible);

  app.innerHTML = `
    ${lastBatchShareText ? `
      <section class="card share-result">
        <div class="section-title" style="margin-top:0">
          <h2>방금 만든 통합 공유문</h2>
          <button class="primary small" data-action="copy-batch-share">복사</button>
        </div>
        <div class="copy-box share-preview">${escapeHtml(lastBatchShareText)}</div>
      </section>
    ` : ''}

    <section class="card">
      <h2>정산완료</h2>
      <p class="item-sub">완료 기록도 등록 당시 그룹을 그대로 유지합니다. 아이템 수령분까지 상계한 최종 송금 방향을 함께 표시합니다.</p>
    </section>
    <div class="section-title"><h2>완료 그룹</h2><span class="sub">${groups.length}그룹 · ${visible.length}건</span></div>
    <div class="search-row">
      <input id="doneSearch" type="search" value="${escapeHtml(keyword)}" placeholder="보스, 아이템, 참여자, 수령자 검색" />
      <button class="secondary" data-action="clear-search">초기화</button>
    </div>
    ${groups.length ? `<div class="group-list">${groups.map(completedGroupCard).join('')}</div>` : emptyState('검색 결과가 없습니다', '다른 보스명, 아이템명, 참여자명으로 검색해보세요.')}
  `;
  $('#doneSearch')?.addEventListener('input', function (event) {
    sessionStorage.setItem('bossSplit.search', event.target.value.trim());
    renderDone();
  });
}

function renderDetail(id) {
  const entry = findEntry(id);
  if (!entry) {
    state.detailId = null;
    render();
    return;
  }
  const calc = calculateEntry(entry);
  const pending = isPendingEntry(entry);
  const st = pending ? statusMap.waiting : statusMap.done;
  const rateLabel = entry.status === 'done' ? '완료 시세' : '현재 시세';
  const recipient = getEntryRecipient(entry);
  const category = getEntryCategory(entry);

  app.innerHTML = `
    <section class="item-card">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(entry.boss)} 정산</div>
          <div class="item-sub">${formatDate(entry.date)} · ${entry.members.length}인 · ${escapeHtml(category)}</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="kv-grid">
        <div class="kv"><span>정산 항목</span><b>${escapeHtml(entry.item)}</b></div>
        <div class="kv"><span>${recipient ? '아이템 가치' : '판매가'}</span><b>${formatAmount(calc.salePrice)}</b></div>
        <div class="kv"><span>1인 지분</span><b>${formatAmount(calc.perPerson)}${calc.cashRatePerBillion > 0 ? ` / ${formatWon(calc.perPersonCash)}` : ''}</b></div>
        <div class="kv"><span>${rateLabel}</span><b>${calc.cashRatePerBillion > 0 ? `억당 ${formatWon(calc.cashRatePerBillion)}` : '-'}</b></div>
        <div class="kv"><span>아이템 수령</span><b>${recipient ? escapeHtml(recipient) : '판매 정산'}</b></div>
        <div class="kv"><span>그룹</span><b>${escapeHtml(getEntryGroupId(entry).replace(/^legacy_/, '기존 기록 '))}</b></div>
      </div>
      <div class="detail-block">
        <h3>참여자</h3>
        <p class="item-sub">${entry.members.map(escapeHtml).join(', ') || '-'}</p>
      </div>
      <div class="item-actions">
        <button class="ghost" data-action="back-list">목록으로</button>
        ${pending ? `<button class="secondary" data-action="edit-entry" data-id="${entry.id}">수정</button>` : ''}
        <button class="secondary" data-action="copy-share" data-id="${entry.id}">공유문구 복사</button>
        <button class="danger" data-action="delete-entry" data-id="${entry.id}">삭제</button>
      </div>
    </section>
  `;
}

function renderSaleSummary(entry) {
  const sale = entry.sale;
  const hasCash = sale.cashRatePerBillion > 0;
  return `
    <section class="card detail-block">
      <h2>판매 정보</h2>
      <div class="kv-grid">
        <div class="kv"><span>실제 판매가</span><b>${formatAmount(sale.salePrice)}</b></div>
        <div class="kv"><span>수수료</span><b>${formatAmount(sale.feeAmount)}</b></div>
        <div class="kv"><span>정산 제외</span><b>${formatAmount(sale.excludeAmount)}</b></div>
        <div class="kv"><span>최종 정산금액</span><b>${formatAmount(sale.netAmount)}</b></div>
        <div class="kv"><span>1인당 메소</span><b>${formatAmount(sale.perPerson)}</b></div>
        <div class="kv"><span>판매일</span><b>${formatDate(sale.soldAt?.slice(0, 10) || entry.date)}</b></div>
        <div class="kv"><span>억당 현금가</span><b>${hasCash ? formatWon(sale.cashRatePerBillion) : '-'}</b></div>
        <div class="kv"><span>1인당 현금</span><b>${hasCash ? formatWon(sale.perPersonCash) : '-'}</b></div>
        <div class="kv"><span>총 현금 환산</span><b>${hasCash ? formatWon(sale.totalCash) : '-'}</b></div>
        <div class="kv"><span>전달 예정 현금</span><b>${hasCash ? formatWon(sale.transferCash) : '-'}</b></div>
        <div class="kv"><span>판매자</span><b>${escapeHtml(sale.sellerName || '-')}</b></div>
      </div>
      <p class="item-sub">전달 예정 현금은 판매자 본인 몫을 제외하고, 나머지 참여자에게 전달할 총액입니다.</p>
      <div class="item-actions">
        <button class="secondary" data-action="open-sale" data-id="${entry.id}">판매 정보 수정</button>
      </div>
    </section>
  `;
}

function renderSettings() {
  app.innerHTML = `
    <section class="card">
      <h2>설정</h2>
      <p class="item-sub">반복 입력을 줄이기 위한 기본값입니다. 공유 URL을 연결하면 다른 사람도 같은 데이터를 볼 수 있습니다.</p>
    </section>

    <div class="section-title"><h2>정산 규칙</h2></div>
    <section class="card">
      <div class="field-grid">
        <label class="field">
          <span>기본 수수료 방식</span>
          <select id="settingFeeMode">
            <option value="percent" ${state.settings.feeMode === 'percent' ? 'selected' : ''}>퍼센트</option>
            <option value="fixed" ${state.settings.feeMode === 'fixed' ? 'selected' : ''}>고정 금액</option>
          </select>
        </label>
        <label class="field">
          <span>기본 수수료 값</span>
          <input id="settingFeeValue" type="number" step="0.001" min="0" value="${state.settings.feeValue}" />
        </label>
      </div>
      <label class="field">
        <span>기본 반올림 방식</span>
        <select id="settingRoundingMode">
          ${roundingOptions(state.settings.roundingMode)}
        </select>
      </label>
      <label class="field">
        <span>현재 억당 시세, 원</span>
        <input id="settingCashRatePerBillion" type="number" step="1" min="0" value="${state.settings.cashRatePerBillion || 0}" placeholder="예: 2500" />
        <span class="item-sub">정산대기 건은 이 시세를 즉시 반영하고, 완료 시점에 시세가 고정됩니다.</span>
      </label>
      <div class="item-actions">
        <button class="primary" data-action="save-rules">정산 규칙 저장</button>
      </div>
    </section>

    <div class="section-title"><h2>고정 파티</h2><button class="primary small" data-action="new-party">+ 파티</button></div>
    <div class="settings-list">
      ${state.parties.map((party) => `
        <div class="setting-row">
          <div>
            <b>${escapeHtml(party.name)}</b>
            <div class="desc">${party.members.map(escapeHtml).join(', ') || '참여자 없음'}</div>
          </div>
          <div class="setting-actions">
            <button class="secondary small" data-action="edit-party" data-id="${party.id}">수정</button>
            <button class="danger small" data-action="delete-party" data-id="${party.id}">삭제</button>
          </div>
        </div>
      `).join('')}
    </div>

    <div class="section-title"><h2>보스 목록</h2></div>
    <section class="card">
      <label class="field">
        <span>보스명, 줄바꿈으로 구분</span>
        <textarea id="bossList" rows="7">${state.settings.bosses.map(escapeHtml).join('\n')}</textarea>
      </label>
      <div class="item-actions">
        <button class="primary" data-action="save-bosses">보스 목록 저장</button>
      </div>
    </section>

    <div class="section-title"><h2>공유 웹앱 연결</h2></div>
    <section class="card">
      <label class="field">
        <span>Apps Script 웹앱 URL</span>
        <input id="remoteApiUrl" type="url" value="${escapeHtml(getRemoteUrl())}" placeholder="https://script.google.com/macros/s/.../exec" />
      </label>
      <p class="item-sub">같은 URL을 입력한 사람끼리 동일한 정산 데이터를 봅니다. 마지막으로 저장한 내용이 기준입니다.</p>
      <div class="remote-summary">
        <div class="kv"><span>현재 상태</span><b>${getRemoteUrl() ? '공유 연결 사용' : '로컬 저장만 사용'}</b></div>
        <div class="kv"><span>마지막 동기화</span><b>${remoteUpdatedAt ? formatDateTime(remoteUpdatedAt) : '-'}</b></div>
      </div>
      <div class="setting-actions">
        <button class="primary" data-action="save-remote-url">URL 저장</button>
        <button class="secondary" data-action="pull-remote">공유 데이터 불러오기</button>
        <button class="secondary" data-action="push-remote">현재 데이터 올리기</button>
        <button class="ghost" data-action="clear-remote-url">연결 해제</button>
      </div>
    </section>

    <div class="section-title"><h2>데이터</h2></div>
    <section class="card">
      <div class="setting-actions">
        <button class="secondary" data-action="export-data">백업 내보내기</button>
        <button class="secondary" data-action="import-data">백업 가져오기</button>
        <button class="ghost" data-action="seed-demo">데모 데이터 넣기</button>
        <button class="danger" data-action="reset-data">전체 초기화</button>
      </div>
      <input id="importFile" type="file" accept="application/json" hidden />
    </section>
  `;
  $('#importFile')?.addEventListener('change', handleImportFile);
}


function entryCard(entry) {
  const pending = isPendingEntry(entry);
  const st = pending ? statusMap.waiting : statusMap.done;
  const calc = calculateEntry(entry);
  const recipient = getEntryRecipient(entry);
  const category = getEntryCategory(entry);
  const amountLine = `1인 ${formatAmount(calc.perPerson)}${calc.cashRatePerBillion > 0 ? ` / ${formatWon(calc.perPersonCash)}` : ''}`;
  return `
    <article class="item-card" data-id="${entry.id}">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(entry.boss)}</div>
          <div class="item-sub">${formatShortDate(entry.date)} · ${entry.members.length}인 · ${escapeHtml(entry.item || '아이템 미입력')}</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="item-meta">
        <span class="badge draft">${escapeHtml(category)}</span>
        <span class="badge draft">${recipient ? `${escapeHtml(recipient)} 수령` : '판매 정산'}</span>
        <span class="badge draft">${amountLine}</span>
      </div>
      <div class="item-actions">
        <button class="ghost" data-action="detail" data-id="${entry.id}">상세</button>
        ${pending ? `<button class="secondary" data-action="edit-entry" data-id="${entry.id}">수정</button>` : ''}
      </div>
    </article>
  `;
}

function emptyState(title, desc) {
  return `<div class="empty"><b>${title}</b>${desc}</div>`;
}


function handleAppClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const groupId = target.dataset.groupId;
  const actions = {
    'new-entry': function () { openBulkEntryDialog(); },
    detail: function () { openDetail(id); },
    'back-list': function () { state.detailId = null; saveState({ localOnly: true }); render(); },
    'edit-entry': function () { openBulkEntryDialog(findEntry(id)); },
    'delete-entry': function () { deleteEntry(id); },
    'copy-share': function () { copyShare(id); },
    'select-all-pending': selectAllPending,
    'clear-selection': clearPendingSelection,
    'complete-selected': completeSelectedBatch,
    'complete-group': function () { completeGroup(groupId); },
    'add-to-group': function () { openBulkEntryDialog(null, groupId); },
    'merge-selected-group': moveSelectedToGroup,
    'copy-group-share': function () { copyGroupShare(groupId); },
    'copy-batch-share': copyBatchShare,
    'clear-search': function () { sessionStorage.removeItem('bossSplit.search'); renderDone(); },
    'save-rules': saveRules,
    'new-party': function () { openPartyDialog(); },
    'edit-party': function () { openPartyDialog(findParty(id)); },
    'delete-party': function () { deleteParty(id); },
    'save-bosses': saveBosses,
    'export-data': exportData,
    'import-data': function () { $('#importFile').click(); },
    'seed-demo': seedDemoData,
    'reset-data': resetData,
    'save-remote-url': saveRemoteUrlFromSettings,
    'clear-remote-url': clearRemoteUrl,
    'pull-remote': function () { pullRemoteState(); },
    'push-remote': function () { pushRemoteState(); },
  };
  if (actions[action]) actions[action]();
}

function handleAppChange(event) {
  const target = event.target;
  if (target.matches('[data-action="select-entry"]')) {
    if (target.checked) selectedEntryIds.add(target.dataset.id);
    else selectedEntryIds.delete(target.dataset.id);
    renderList();
    return;
  }
  if (target.matches('[data-action="select-group"]')) {
    const group = getStoredGroups(state.entries.filter(isPendingEntry)).find(function (g) { return g.id === target.dataset.groupId; });
    if (group) {
      group.entries.forEach(function (entry) {
        if (target.checked) selectedEntryIds.add(entry.id);
        else selectedEntryIds.delete(entry.id);
      });
    }
    renderList();
    return;
  }
  if (target.matches('[data-action="toggle-payment"]')) {
    const entry = findEntry(target.dataset.id);
    if (!entry) return;
    entry.payments = entry.payments || {};
    entry.payments[target.dataset.member] = target.checked;
    entry.status = isAllPaid(entry) ? 'done' : 'waiting';
    saveState();
    render();
  }
}

function saveRemoteUrlFromSettings() {
  const input = $('#remoteApiUrl');
  const url = input?.value?.trim() || '';
  if (!url) {
    showToast('Apps Script 웹앱 URL을 입력하세요.');
    return;
  }
  setRemoteUrl(url);
  showToast('공유 URL을 저장했습니다.');
  setRemoteStatus('loading');
  pullRemoteState();
}

function clearRemoteUrl() {
  if (!confirm('공유 연결을 해제할까요? 현재 브라우저의 로컬 데이터는 유지됩니다.')) return;
  localStorage.removeItem(REMOTE_URL_KEY);
  localStorage.removeItem('bossSplitLedger.remoteUpdatedAt.v1');
  remoteUpdatedAt = '';
  setRemoteStatus('local', '공유 연결을 해제했습니다.');
  render();
}

function openDetail(id) {
  state.detailId = id;
  saveState({ localOnly: true });
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


function openEntryDialog(entry = null) {
  populateEntrySelects(entry);
  $('#entryDialogTitle').textContent = entry ? '정산 수정' : '정산 등록';
  $('#entryId').value = entry?.id || '';
  $('#entryDate').value = entry?.date || new Date().toISOString().slice(0, 10);
  $('#entryBoss').value = entry?.boss || state.settings.bosses[0] || '';
  $('#entryParty').value = entry ? '__custom__' : (state.parties[0]?.id || '__custom__');
  $('#entryItem').value = entry?.item || '';
  $('#entryExpectedPrice').value = entry?.sale?.salePrice ?? entry?.expectedPrice ?? '';
  $('#entryMemo').value = entry?.memo || '';
  $('#entryNewMember').value = '';
  if (entry) renderEntryMembers(entry.members, entry.members);
  else refreshEntryMembersFromParty();
  $('#entryDialog').showModal();
}

function populateEntrySelects(entry = null) {
  const bosses = [...new Set([...(state.settings.bosses || []), entry?.boss].filter(Boolean))];
  $('#entryBoss').innerHTML = bosses.map((boss) => `<option value="${escapeHtml(boss)}">${escapeHtml(boss)}</option>`).join('');
  $('#entryParty').innerHTML = [
    ...state.parties.map((party) => `<option value="${party.id}">${escapeHtml(party.name)}</option>`),
    '<option value="__custom__">직접 선택</option>',
  ].join('');
}

function refreshEntryMembersFromParty() {
  const partyId = $('#entryParty').value;
  const party = state.parties.find((p) => p.id === partyId);
  const members = party?.members || [];
  renderEntryMembers(members, members);
}

function renderEntryMembers(members, checkedMembers = []) {
  const unique = [...new Set(members.filter(Boolean))];
  const checked = new Set(checkedMembers.filter(Boolean));
  $('#entryMembers').innerHTML = unique.length
    ? unique.map((member) => `
      <label class="check-pill">
        <input type="checkbox" value="${escapeHtml(member)}" ${checked.has(member) ? 'checked' : ''} />
        ${escapeHtml(member)}
      </label>
    `).join('')
    : '<p class="item-sub">참여자를 추가하세요.</p>';
}

function addTempMemberToEntry() {
  const input = $('#entryNewMember');
  const name = input.value.trim();
  if (!name) return;
  const current = getEntryMemberNamesFromDialog();
  if (!current.includes(name)) current.push(name);
  renderEntryMembers(current, current);
  input.value = '';
}

function getEntryMemberNamesFromDialog() {
  return [...$('#entryMembers').querySelectorAll('input[type="checkbox"]')].map((input) => input.value).filter(Boolean);
}

function getCheckedEntryMembers() {
  return [...$('#entryMembers').querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value).filter(Boolean);
}


function handleEntrySubmit(event) {
  event.preventDefault();
  const id = $('#entryId').value || uid();
  const existing = findEntry(id);
  const members = getCheckedEntryMembers();
  if (!members.length) {
    showToast('참여자를 1명 이상 선택하세요.');
    return;
  }

  const salePrice = numberOrZero($('#entryExpectedPrice').value);
  if (salePrice <= 0) {
    showToast('판매가를 입력하세요.');
    return;
  }

  const party = findParty($('#entryParty').value);
  const now = new Date().toISOString();
  const saleBasis = {
    ...(existing?.sale || {}),
    salePrice,
    feeMode: existing?.sale?.feeMode || state.settings.feeMode,
    feeValue: existing?.sale?.feeValue ?? state.settings.feeValue,
    excludeAmount: numberOrZero(existing?.sale?.excludeAmount),
    roundingMode: existing?.sale?.roundingMode || state.settings.roundingMode,
    sellerName: existing?.sale?.sellerName || members[0] || '',
    soldAt: existing?.sale?.soldAt || now,
  };

  const payload = {
    id,
    date: normalizeDateValue($('#entryDate').value) || new Date().toISOString().slice(0, 10),
    boss: $('#entryBoss').value,
    partyName: party?.name || '직접 선택',
    members,
    item: $('#entryItem').value.trim(),
    expectedPrice: salePrice,
    memo: $('#entryMemo').value.trim(),
    status: existing?.status === 'done' ? 'done' : 'waiting',
    createdAt: existing?.createdAt || now,
    sale: saleBasis,
    payments: prunePayments(existing?.payments || {}, members),
  };

  if (existing) {
    Object.assign(existing, payload);
  } else {
    state.entries.unshift(payload);
  }

  if (payload.status !== 'done') selectedEntryIds.add(id);
  state.activeTab = 'waiting';
  state.detailId = null;
  saveState();
  $('#entryDialog').close();
  showToast(existing ? '정산을 수정했습니다.' : '정산을 등록하고 자동 선택했습니다.');
  render();
}


function openBulkEntryDialog(entry = null, targetGroupId = '') {
  const tbody = $('#entryRows');
  tbody.innerHTML = '';
  $('#entryId').value = entry ? entry.id : '';
  $('#entryDialogTitle').textContent = entry ? '정산 수정' : '정산 일괄 등록';
  $('#addEntryRowBtn').hidden = Boolean(entry);
  populateEntryGroupOptions(targetGroupId || (entry ? getEntryGroupId(entry) : ''), entry);
  appendBulkEntryRow(makeBulkEntryRowData(entry));
  updateBulkEntrySubmitLabel();
  $('#entryDialog').showModal();
}

function makeBulkEntryRowData(entry = null) {
  const firstParty = state.parties[0] || null;
  const matchedParty = entry
    ? (state.parties.find(function (party) { return party.name === entry.partyName; }) || null)
    : firstParty;
  return {
    date: normalizeDateValue(entry && entry.date) || new Date().toISOString().slice(0, 10),
    boss: (entry && entry.boss) || (state.settings.bosses && state.settings.bosses[0]) || '',
    partyId: (matchedParty && matchedParty.id) || '__custom__',
    members: entry && entry.members && entry.members.length ? entry.members.slice() : ((matchedParty && matchedParty.members) || []).slice(),
    item: (entry && entry.item) || '',
    salePrice: entry ? ((entry.sale && entry.sale.salePrice) != null ? entry.sale.salePrice : entry.expectedPrice) : '',
    category: entry ? getEntryCategory(entry) : '자동',
    recipient: entry ? getEntryRecipient(entry) : '',
  };
}

function appendBulkEntryRow(data) {
  data = data || {};
  const tbody = $('#entryRows');
  const normalized = {
    date: normalizeDateValue(data.date) || new Date().toISOString().slice(0, 10),
    boss: data.boss || (state.settings.bosses && state.settings.bosses[0]) || '',
    partyId: data.partyId || (state.parties[0] && state.parties[0].id) || '__custom__',
    members: Array.isArray(data.members) ? data.members : [],
    item: data.item || '',
    salePrice: data.salePrice != null ? data.salePrice : '',
    category: data.category || '자동',
    recipient: data.recipient || '',
  };
  const bosses = Array.from(new Set([].concat(state.settings.bosses || [], normalized.boss).filter(Boolean)));
  const bossOptions = bosses.map(function (boss) {
    return '<option value="' + escapeHtml(boss) + '"' + (boss === normalized.boss ? ' selected' : '') + '>' + escapeHtml(boss) + '</option>';
  }).join('');
  const partyOptions = state.parties.map(function (party) {
    return '<option value="' + escapeHtml(party.id) + '"' + (party.id === normalized.partyId ? ' selected' : '') + '>' + escapeHtml(party.name) + '</option>';
  }).join('') + '<option value="__custom__"' + (normalized.partyId === '__custom__' ? ' selected' : '') + '>직접 입력</option>';
  const categories = ['자동', '물욕템', '연마석', '기타'];
  const categoryOptions = categories.map(function (category) {
    return '<option value="' + category + '"' + (category === normalized.category ? ' selected' : '') + '>' + category + '</option>';
  }).join('');
  const recipientOptions = ['<option value="">판매 정산</option>'].concat(normalized.members.map(function (member) {
    return '<option value="' + escapeHtml(member) + '"' + (member === normalized.recipient ? ' selected' : '') + '>' + escapeHtml(member) + ' 수령</option>';
  })).join('');
  const row = document.createElement('tr');
  row.dataset.entryRow = '1';
  row.innerHTML =
    '<td class="entry-col-date"><input data-field="date" type="date" value="' + escapeHtml(normalized.date) + '" aria-label="정산 날짜" /></td>' +
    '<td class="entry-col-boss"><select data-field="boss" aria-label="보스">' + bossOptions + '</select></td>' +
    '<td class="entry-col-category"><select data-field="category" aria-label="카테고리">' + categoryOptions + '</select></td>' +
    '<td class="entry-col-party"><select data-field="partyId" aria-label="파티">' + partyOptions + '</select></td>' +
    '<td class="entry-col-members"><input data-field="members" type="text" value="' + escapeHtml(normalized.members.join(', ')) + '" placeholder="하람, 영권" aria-label="참여자" /></td>' +
    '<td class="entry-col-item"><input data-field="item" type="text" value="' + escapeHtml(normalized.item) + '" placeholder="예: 생명의 연마석" aria-label="아이템" /></td>' +
    '<td class="entry-col-recipient"><select data-field="recipient" aria-label="아이템 수령">' + recipientOptions + '</select></td>' +
    '<td class="entry-col-price"><input data-field="salePrice" type="number" step="0.001" min="0" value="' + escapeHtml(normalized.salePrice) + '" placeholder="예: 10" aria-label="판매가 또는 아이템 가치" /></td>' +
    '<td class="entry-col-action"><button type="button" class="danger entry-row-remove" data-entry-row-action="remove" aria-label="행 삭제">×</button></td>';
  tbody.appendChild(row);
  updateBulkEntrySubmitLabel();
}

function addBulkEntryRowFromPrevious() {
  const rows = Array.from($('#entryRows').querySelectorAll('tr[data-entry-row]'));
  const previous = rows.length ? readBulkEntryRow(rows[rows.length - 1]) : makeBulkEntryRowData();
  appendBulkEntryRow({date:previous.date,boss:previous.boss,partyId:previous.partyId,members:previous.members,item:'',salePrice:''});
  const lastRow = $('#entryRows').lastElementChild;
  const itemInput = lastRow && lastRow.querySelector('[data-field="item"]');
  if (itemInput) itemInput.focus();
}
function syncBulkEntryMembersFromParty(row) {
  if (!row) return;
  const partySelect = row.querySelector('[data-field="partyId"]');
  const partyId = partySelect ? partySelect.value : '';
  if (!partyId || partyId === '__custom__') return;
  const party = findParty(partyId);
  if (!party) return;
  const membersInput = row.querySelector('[data-field="members"]');
  if (membersInput) membersInput.value = party.members.join(', ');
  syncBulkEntryRecipientOptions(row);
}

function readBulkEntryRow(row) {
  const salePriceInput = row.querySelector('[data-field="salePrice"]');
  return {
    date: (row.querySelector('[data-field="date"]') || {}).value || '',
    boss: (row.querySelector('[data-field="boss"]') || {}).value || '',
    category: (row.querySelector('[data-field="category"]') || {}).value || '자동',
    partyId: (row.querySelector('[data-field="partyId"]') || {}).value || '__custom__',
    members: splitMembers(((row.querySelector('[data-field="members"]') || {}).value || '')),
    item: (((row.querySelector('[data-field="item"]') || {}).value || '')).trim(),
    recipient: (row.querySelector('[data-field="recipient"]') || {}).value || '',
    salePriceRaw: (((salePriceInput || {}).value || '')).trim(),
    salePrice: numberOrZero((salePriceInput || {}).value),
  };
}

function getActiveBulkEntryRows() {
  return Array.from($('#entryRows').querySelectorAll('tr[data-entry-row]')).map(readBulkEntryRow).filter(function (row) { return row.item || row.salePriceRaw; });
}
function updateBulkEntrySubmitLabel() {
  const tbody=$('#entryRows');
  const rowCount=tbody?tbody.querySelectorAll('tr[data-entry-row]').length:0;
  const activeCount=tbody?getActiveBulkEntryRows().length:0;
  const editing=Boolean($('#entryId')&&$('#entryId').value);
  if ($('#entryRowCount')) $('#entryRowCount').textContent=editing?'1건 수정':(Math.max(1,rowCount)+'행 · '+activeCount+'건 입력');
  if ($('#entrySubmitBtn')) $('#entrySubmitBtn').textContent=editing?'수정 저장':(Math.max(1,activeCount)+'건 등록');
}
function buildBulkEntryPayload(row, existing, now, forcedId, groupId) {
  existing = existing || null;
  now = now || new Date().toISOString();
  const id = forcedId || (existing && existing.id) || uid();
  const party = findParty(row.partyId);
  const members = Array.isArray(row.members) ? row.members.filter(Boolean) : [];
  const salePrice = numberOrZero(row.salePrice);
  const oldSale = (existing && existing.sale) || {};
  const recipient = members.includes(row.recipient) ? row.recipient : '';
  const category = resolveItemCategory(row.category, row.item);
  const saleBasis = Object.assign({}, oldSale, {
    salePrice: salePrice,
    feeMode: oldSale.feeMode || state.settings.feeMode,
    feeValue: oldSale.feeValue != null ? oldSale.feeValue : state.settings.feeValue,
    excludeAmount: numberOrZero(oldSale.excludeAmount),
    roundingMode: oldSale.roundingMode || state.settings.roundingMode,
    sellerName: oldSale.sellerName || members[0] || '',
    soldAt: oldSale.soldAt || now,
    groupId: groupId || oldSale.groupId || makeGroupId(),
    category: category,
    recipient: recipient,
  });
  return {
    id: id,
    date: normalizeDateValue(row.date) || new Date().toISOString().slice(0, 10),
    boss: row.boss || '보스 미입력',
    partyName: (party && party.name) || '직접 선택',
    members: members,
    item: String(row.item || '').trim(),
    expectedPrice: salePrice,
    memo: (existing && existing.memo) || '',
    status: existing && existing.status === 'done' ? 'done' : 'waiting',
    createdAt: (existing && existing.createdAt) || now,
    sale: saleBasis,
    payments: prunePayments((existing && existing.payments) || {}, members),
  };
}

function handleBulkEntrySubmit(event) {
  event.preventDefault();
  const editingId = $('#entryId').value;
  const existing = editingId ? findEntry(editingId) : null;
  const rows = getActiveBulkEntryRows();
  if (!rows.length) { showToast('정산 항목과 금액을 1건 이상 입력하세요.'); return; }
  if (existing && rows.length !== 1) { showToast('기존 정산 수정은 1건만 가능합니다.'); return; }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!normalizeDateValue(row.date)) { showToast((i + 1) + '번째 행의 날짜를 확인하세요.'); return; }
    if (!row.boss) { showToast((i + 1) + '번째 행의 보스를 선택하세요.'); return; }
    if (!row.members.length) { showToast((i + 1) + '번째 행의 참여자를 1명 이상 입력하세요.'); return; }
    if (!row.item) { showToast((i + 1) + '번째 행의 아이템명을 입력하세요.'); return; }
    if (row.salePrice <= 0) { showToast((i + 1) + '번째 행의 판매가/아이템 가치를 입력하세요.'); return; }
    if (row.recipient && !row.members.includes(row.recipient)) { showToast((i + 1) + '번째 행의 아이템 수령자를 확인하세요.'); return; }
  }

  const now = new Date().toISOString();
  const targetValue = $('#entryTargetGroup') ? $('#entryTargetGroup').value : '__new__';
  const groupId = targetValue && targetValue !== '__new__'
    ? targetValue
    : (existing ? getEntryGroupId(existing) : makeGroupId());

  if (existing) {
    const payload = buildBulkEntryPayload(rows[0], existing, now, existing.id, groupId);
    Object.assign(existing, payload);
    if (payload.status !== 'done') selectedEntryIds.add(payload.id);
    showToast('정산을 수정했습니다.');
  } else {
    const payloads = rows.map(function (row) { return buildBulkEntryPayload(row, null, now, '', groupId); });
    state.entries.unshift.apply(state.entries, payloads);
    payloads.forEach(function (payload) { selectedEntryIds.add(payload.id); });
    showToast(payloads.length + '건을 같은 그룹으로 등록하고 자동 선택했습니다.');
  }
  state.activeTab = 'waiting';
  state.detailId = null;
  saveState();
  $('#entryDialog').close();
  render();
}

function prunePayments(payments, members) {
  return Object.fromEntries(members.map((member) => [member, Boolean(payments[member])]));
}

function openSaleDialog(id) {
  const entry = findEntry(id);
  if (!entry) return;
  $('#saleEntryId').value = id;
  $('#saleTarget').innerHTML = `<b>${escapeHtml(entry.item)}</b><div class="item-sub">${formatShortDate(entry.date)} · ${escapeHtml(entry.boss)} · ${entry.members.length}인</div>`;
  $('#salePrice').value = entry.sale?.salePrice || entry.expectedPrice || '';
  $('#feeMode').value = entry.sale?.feeMode || state.settings.feeMode;
  $('#feeValue').value = entry.sale?.feeValue ?? state.settings.feeValue;
  $('#feeValueLabel').textContent = $('#feeMode').value === 'percent' ? '수수료 %' : '수수료 금액, 억 단위';
  $('#excludeAmount').value = entry.sale?.excludeAmount || 0;
  $('#cashRatePerBillion').value = entry.sale?.cashRatePerBillion ?? state.settings.cashRatePerBillion ?? 0;
  $('#sellerName').innerHTML = entry.members.map((member) => `<option value="${escapeHtml(member)}">${escapeHtml(member)}</option>`).join('');
  $('#sellerName').value = entry.sale?.sellerName || entry.members[0] || '';
  $('#roundingMode').value = entry.sale?.roundingMode || state.settings.roundingMode;
  renderCalcPreview();
  $('#saleDialog').showModal();
}

function renderCalcPreview() {
  const id = $('#saleEntryId').value;
  const entry = findEntry(id);
  const preview = $('#calcPreview');
  if (!entry) {
    preview.textContent = '';
    return;
  }
  const calc = calculateSale(entry);
  const cashLines = calc.cashRatePerBillion > 0
    ? `
    억당 현금가: <b>${formatWon(calc.cashRatePerBillion)}</b><br>
    총 현금 환산액: <b>${formatWon(calc.totalCash)}</b><br>
    1인당 전달 현금: <b>${formatWon(calc.perPersonCash)}</b><br>
    판매자 제외 전달 예정: <b>${formatWon(calc.transferCash)}</b><br>
    판매자: <b>${escapeHtml(calc.sellerName || '-')}</b><br>`
    : '억당 현금가를 입력하면 현금 전달액이 표시됩니다.<br>';
  preview.innerHTML = `
    판매가: <b>${formatAmount(calc.salePrice)}</b><br>
    수수료: <b>${formatAmount(calc.feeAmount)}</b><br>
    정산 제외: <b>${formatAmount(calc.excludeAmount)}</b><br>
    최종 정산금액: <b>${formatAmount(calc.netAmount)}</b><br>
    참여자 ${entry.members.length}명 · 1인당 메소 <b>${formatAmount(calc.perPerson)}</b><br>
    ${cashLines}
  `;
}

function calculateSale(entry) {
  const salePrice = numberOrZero($('#salePrice').value);
  const feeMode = $('#feeMode').value;
  const feeValue = numberOrZero($('#feeValue').value);
  const excludeAmount = numberOrZero($('#excludeAmount').value);
  const cashRatePerBillion = numberOrZero($('#cashRatePerBillion').value);
  const sellerName = $('#sellerName').value || entry.members[0] || '';
  const roundingMode = $('#roundingMode').value;
  const feeAmount = feeMode === 'percent' ? salePrice * (feeValue / 100) : feeValue;
  const netAmount = Math.max(0, salePrice - feeAmount - excludeAmount);
  const rawPerPerson = entry.members.length ? netAmount / entry.members.length : 0;
  const perPerson = applyRounding(rawPerPerson, roundingMode);
  const totalCash = roundWon(netAmount * cashRatePerBillion);
  const perPersonCash = roundWon(perPerson * cashRatePerBillion);
  const receiverCount = Math.max(0, entry.members.filter((m) => m !== sellerName).length);
  const transferCash = roundWon(perPersonCash * receiverCount);
  return {
    salePrice, feeMode, feeValue, feeAmount, excludeAmount, netAmount, perPerson, roundingMode,
    cashRatePerBillion, sellerName, totalCash, perPersonCash, transferCash,
  };
}

function handleSaleSubmit(event) {
  event.preventDefault();
  const entry = findEntry($('#saleEntryId').value);
  if (!entry) return;
  const calc = calculateSale(entry);
  if (calc.salePrice <= 0) {
    showToast('실제 판매가를 입력하세요.');
    return;
  }
  entry.sale = { ...calc, soldAt: new Date().toISOString() };
  entry.status = 'settling';
  entry.payments = prunePayments(entry.payments || {}, entry.members);
  if (calc.sellerName) entry.payments[calc.sellerName] = true;
  saveState();
  $('#saleDialog').close();
  state.detailId = entry.id;
  showToast('정산 금액을 생성했습니다.');
  render();
}

function markAllPaid(id) {
  const entry = findEntry(id);
  if (!entry) return;
  entry.payments = Object.fromEntries(entry.members.map((member) => [member, true]));
  entry.status = 'done';
  saveState();
  showToast('전체 지급 완료로 처리했습니다.');
  render();
}

function reopenSettling(id) {
  const entry = findEntry(id);
  if (!entry || !entry.sale) return;
  entry.status = 'settling';
  saveState();
  showToast('정산중으로 되돌렸습니다.');
  render();
}

function deleteEntry(id) {
  const entry = findEntry(id);
  if (!entry) return;
  if (!confirm(`'${entry.item}' 정산을 삭제할까요?`)) return;
  state.entries = state.entries.filter((e) => e.id !== id);
  if (state.detailId === id) state.detailId = null;
  saveState();
  showToast('정산을 삭제했습니다.');
  render();
}

async function copyShare(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const text = buildShareText(entry);
  try {
    await navigator.clipboard.writeText(text);
    showToast('카톡 공유 문구를 복사했습니다.');
  } catch {
    fallbackCopy(text);
    showToast('공유 문구를 복사했습니다.');
  }
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}


function buildShareText(entry) {
  return buildBatchShareText([entry]);
}


function isPendingEntry(entry) {
  return Boolean(entry) && entry.status !== 'done';
}

function calculateEntry(entry) {
  const sale = entry?.sale || {};
  const salePrice = numberOrZero(sale.salePrice ?? entry?.expectedPrice);
  const recipient = getEntryRecipient(entry);
  const feeMode = sale.feeMode || state.settings.feeMode;
  const feeValue = sale.feeValue ?? state.settings.feeValue;
  const excludeAmount = numberOrZero(sale.excludeAmount);
  const roundingMode = sale.roundingMode || state.settings.roundingMode;
  const feeAmount = recipient ? 0 : (feeMode === 'percent' ? salePrice * (numberOrZero(feeValue) / 100) : numberOrZero(feeValue));
  const netAmount = Math.max(0, salePrice - feeAmount - excludeAmount);
  const memberCount = entry?.members?.length || 0;
  const rawPerPerson = memberCount ? netAmount / memberCount : 0;
  const perPerson = applyRounding(rawPerPerson, roundingMode);
  const frozenRate = sale.completedCashRate ?? sale.cashRatePerBillion;
  const cashRatePerBillion = entry?.status === 'done'
    ? numberOrZero(frozenRate ?? state.settings.cashRatePerBillion)
    : numberOrZero(state.settings.cashRatePerBillion);
  const totalCash = roundWon(netAmount * cashRatePerBillion);
  const perPersonCash = roundWon(perPerson * cashRatePerBillion);
  return {
    salePrice: salePrice,
    feeMode: feeMode,
    feeValue: numberOrZero(feeValue),
    feeAmount: feeAmount,
    excludeAmount: excludeAmount,
    netAmount: netAmount,
    perPerson: perPerson,
    rawPerPerson: rawPerPerson,
    roundingMode: roundingMode,
    cashRatePerBillion: cashRatePerBillion,
    totalCash: totalCash,
    perPersonCash: perPersonCash,
    recipient: recipient,
  };
}

function getSelectedPendingEntries() {
  return state.entries.filter((entry) => isPendingEntry(entry) && selectedEntryIds.has(entry.id));
}

function getBatchGroups(entries) {
  return getStoredGroups(entries || []);
}

function getBatchSelectionSummary(entries) {
  if (!entries.length) return '정산 그룹 또는 항목을 선택하세요.';
  const expanded = getExpandedSelectedPendingEntries(entries);
  const groupCount = getStoredGroups(expanded).length;
  const total = expanded.reduce(function (sum, entry) { return sum + calculateEntry(entry).netAmount; }, 0);
  return `${groupCount}그룹 · 완료 대상 ${expanded.length}건 · 총 가치 ${formatAmount(total)}`;
}

function selectAllPending() {
  state.entries.filter(isPendingEntry).forEach((entry) => selectedEntryIds.add(entry.id));
  renderList();
}

function clearPendingSelection() {
  selectedEntryIds.clear();
  renderList();
}

function completeSelectedBatch() {
  const selected = getSelectedPendingEntries();
  const entries = getExpandedSelectedPendingEntries(selected);
  if (!entries.length) { showToast('완료할 정산 그룹을 선택하세요.'); return; }
  const invalid = entries.find(function (entry) { return calculateEntry(entry).salePrice <= 0; });
  if (invalid) { showToast("'" + invalid.item + "' 금액을 확인하세요."); return; }

  const completedAt = new Date().toISOString();
  entries.forEach(function (entry) {
    const calc = calculateEntry(entry);
    entry.sale = Object.assign({}, entry.sale || {}, calc, {
      cashRatePerBillion: calc.cashRatePerBillion,
      completedCashRate: calc.cashRatePerBillion,
      completedAt: completedAt,
    });
    entry.status = 'done';
    entry.payments = Object.fromEntries((entry.members || []).map(function (member) { return [member, true]; }));
  });

  lastBatchShareText = buildBatchShareText(entries);
  sessionStorage.setItem('bossSplit.lastBatchShare.v5', lastBatchShareText);
  selectedEntryIds.clear();
  state.activeTab = 'done';
  state.detailId = null;
  saveState();
  showToast(getStoredGroups(entries).length + '개 그룹, ' + entries.length + '건을 정산 완료했습니다.');
  render();
}

async function copyBatchShare() {
  if (!lastBatchShareText) {
    showToast('복사할 통합 공유문이 없습니다.');
    return;
  }
  try {
    await navigator.clipboard.writeText(lastBatchShareText);
    showToast('통합 공유문을 복사했습니다.');
  } catch {
    fallbackCopy(lastBatchShareText);
    showToast('통합 공유문을 복사했습니다.');
  }
}

function buildBatchShareText(entries) {
  const groups = getStoredGroups((entries || []).filter(Boolean));
  if (!groups.length) return '';
  return groups.map(function (group) {
    const settlement = calculateGroupSettlement(group.entries);
    const dates = Array.from(new Set(group.entries.map(function (entry) { return formatDate(entry.date); })));
    const members = settlement.members;
    const totalCash = group.entries.reduce(function (sum, entry) { return sum + calculateEntry(entry).totalCash; }, 0);
    const hasCash = group.entries.some(function (entry) { return calculateEntry(entry).cashRatePerBillion > 0; });
    const lines = [
      '정산 날짜: ' + dates.join(', '),
      '정산 인원: ' + members.length + '인',
      '',
    ];
    group.entries.forEach(function (entry) {
      const calc = calculateEntry(entry);
      const recipient = getEntryRecipient(entry);
      lines.push(entry.boss + ' · ' + entry.item + (recipient ? ' (' + recipient + ' 수령)' : ''));
      lines.push('정산 가치: ' + formatAmount(calc.netAmount) + ' · 1인 지분 ' + formatAmount(calc.rawPerPerson));
      lines.push('');
    });
    lines.push('총합: ' + formatAmount(settlement.totalValue) + (hasCash ? ' / ' + formatWon(totalCash) : ''));
    lines.push('');
    lines.push('최종 정산');
    if (settlement.transfers.length) {
      settlement.transfers.forEach(function (transfer) {
        const cash = settlement.cashRate > 0 ? ' / ' + formatWon(transfer.amount * settlement.cashRate) : '';
        lines.push(transfer.from + ' → ' + transfer.to + ': ' + formatAmount(transfer.amount) + cash);
      });
    } else {
      lines.push('추가 송금 없음');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }).join('\n\n────────\n\n');
}

function resolveItemCategory(raw, item) {
  if (raw && raw !== '자동') return raw;
  return String(item || '').includes('연마석') ? '연마석' : '물욕템';
}

function getEntryGroupId(entry) {
  return entry?.sale?.groupId || ('legacy_' + entry.id);
}

function getEntryCategory(entry) {
  if (entry?.sale?.category) return entry.sale.category;
  return String(entry?.item || '').includes('연마석') ? '연마석' : '기타';
}

function getEntryRecipient(entry) {
  const recipient = entry?.sale?.recipient || '';
  return (entry?.members || []).includes(recipient) ? recipient : '';
}

function makeGroupId() {
  return 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function populateEntryGroupOptions(targetGroupId, entry) {
  const select = $('#entryTargetGroup');
  if (!select) return;
  const groups = getStoredGroups(state.entries.filter(isPendingEntry));
  const currentId = targetGroupId || (entry ? getEntryGroupId(entry) : '');
  const options = ['<option value="__new__">새 그룹으로 등록</option>'].concat(groups.map(function (group) {
    return '<option value="' + escapeHtml(group.id) + '">' + escapeHtml(getGroupLabel(group)) + '</option>';
  }));
  select.innerHTML = options.join('');
  if (currentId && groups.some(function (group) { return group.id === currentId; })) select.value = currentId;
  else select.value = '__new__';
}

function syncBulkEntryRecipientOptions(row) {
  if (!row) return;
  const members = splitMembers(((row.querySelector('[data-field="members"]') || {}).value || ''));
  const select = row.querySelector('[data-field="recipient"]');
  if (!select) return;
  const current = select.value;
  select.innerHTML = ['<option value="">판매 정산</option>'].concat(members.map(function (member) {
    return '<option value="' + escapeHtml(member) + '">' + escapeHtml(member) + ' 수령</option>';
  })).join('');
  select.value = members.includes(current) ? current : '';
}

function getStoredGroups(entries) {
  const map = new Map();
  (entries || []).forEach(function (entry) {
    const id = getEntryGroupId(entry);
    if (!map.has(id)) map.set(id, { id: id, entries: [] });
    map.get(id).entries.push(entry);
  });
  const groups = Array.from(map.values());
  groups.forEach(function (group) { group.entries.sort(sortRecent); });
  groups.sort(function (a, b) {
    const aa = a.entries[0] || {};
    const bb = b.entries[0] || {};
    return (String(bb.date || '') + String(bb.createdAt || '')).localeCompare(String(aa.date || '') + String(aa.createdAt || ''));
  });
  return groups;
}

function getGroupLabel(group) {
  const dates = Array.from(new Set(group.entries.map(function (entry) { return formatShortDate(entry.date); })));
  const bosses = Array.from(new Set(group.entries.map(function (entry) { return entry.boss; })));
  return dates.join(', ') + ' · ' + group.entries.length + '건 · ' + bosses.slice(0, 2).join(', ') + (bosses.length > 2 ? ' 외' : '');
}

function getExpandedSelectedPendingEntries(selected) {
  const ids = new Set((selected || []).map(getEntryGroupId));
  return state.entries.filter(function (entry) { return isPendingEntry(entry) && ids.has(getEntryGroupId(entry)); });
}

function calculateGroupSettlement(entries) {
  const entitlement = {};
  const received = {};
  let totalValue = 0;
  let cashRate = 0;
  (entries || []).forEach(function (entry) {
    const calc = calculateEntry(entry);
    totalValue += calc.netAmount;
    if (!cashRate && calc.cashRatePerBillion > 0) cashRate = calc.cashRatePerBillion;
    const members = entry.members || [];
    const share = members.length ? calc.netAmount / members.length : 0;
    members.forEach(function (member) {
      entitlement[member] = (entitlement[member] || 0) + share;
      if (!(member in received)) received[member] = received[member] || 0;
    });
    const holder = getEntryRecipient(entry) || entry.sale?.sellerName || members[0] || '';
    if (holder) received[holder] = (received[holder] || 0) + calc.netAmount;
  });
  const members = Array.from(new Set(Object.keys(entitlement).concat(Object.keys(received))));
  const balances = {};
  members.forEach(function (member) {
    balances[member] = roundFloat((received[member] || 0) - (entitlement[member] || 0), 6);
  });
  const payers = members.filter(function (m) { return balances[m] > 0.0000001; }).map(function (m) { return { name: m, amount: balances[m] }; });
  const receivers = members.filter(function (m) { return balances[m] < -0.0000001; }).map(function (m) { return { name: m, amount: -balances[m] }; });
  const transfers = [];
  let i = 0, j = 0;
  while (i < payers.length && j < receivers.length) {
    const amount = Math.min(payers[i].amount, receivers[j].amount);
    if (amount > 0.0000001) transfers.push({ from: payers[i].name, to: receivers[j].name, amount: roundFloat(amount, 6) });
    payers[i].amount -= amount;
    receivers[j].amount -= amount;
    if (payers[i].amount <= 0.0000001) i += 1;
    if (receivers[j].amount <= 0.0000001) j += 1;
  }
  return { totalValue: roundFloat(totalValue, 6), members: members, entitlement: entitlement, received: received, balances: balances, transfers: transfers, cashRate: cashRate };
}

function pendingGroupCard(group) {
  const settlement = calculateGroupSettlement(group.entries);
  const allSelected = group.entries.every(function (entry) { return selectedEntryIds.has(entry.id); });
  const itemRows = group.entries.map(function (entry) {
    const calc = calculateEntry(entry);
    const recipient = getEntryRecipient(entry);
    return '<div class="group-item">' +
      '<label class="group-item-check"><input type="checkbox" data-action="select-entry" data-id="' + escapeHtml(entry.id) + '"' + (selectedEntryIds.has(entry.id) ? ' checked' : '') + ' /></label>' +
      '<div class="group-item-main"><b>' + escapeHtml(entry.boss) + ' · ' + escapeHtml(entry.item) + '</b>' +
      '<span>' + escapeHtml(getEntryCategory(entry)) + ' · ' + formatAmount(calc.netAmount) + (recipient ? ' · ' + escapeHtml(recipient) + ' 수령' : ' · 판매 정산') + '</span></div>' +
      '<button class="ghost small" data-action="edit-entry" data-id="' + escapeHtml(entry.id) + '">수정</button>' +
      '</div>';
  }).join('');
  return '<section class="group-card">' +
    '<div class="group-card-head"><label class="group-select"><input type="checkbox" data-action="select-group" data-group-id="' + escapeHtml(group.id) + '"' + (allSelected ? ' checked' : '') + ' /><span>' + escapeHtml(getGroupLabel(group)) + '</span></label>' +
    '<span class="badge waiting">정산대기</span></div>' +
    '<div class="group-total">그룹 총 가치 <b>' + formatAmount(settlement.totalValue) + '</b></div>' +
    '<div class="group-items">' + itemRows + '</div>' +
    '<div class="item-actions"><button class="secondary" data-action="add-to-group" data-group-id="' + escapeHtml(group.id) + '">+ 이 그룹에 추가</button>' +
    '<button class="primary" data-action="complete-group" data-group-id="' + escapeHtml(group.id) + '">그룹 정산 완료</button></div>' +
    '</section>';
}

function completedGroupCard(group) {
  const settlement = calculateGroupSettlement(group.entries);
  const itemRows = group.entries.map(function (entry) {
    const calc = calculateEntry(entry);
    const recipient = getEntryRecipient(entry);
    return '<div class="group-item completed"><div class="group-item-main"><b>' + escapeHtml(entry.boss) + ' · ' + escapeHtml(entry.item) + '</b>' +
      '<span>' + escapeHtml(getEntryCategory(entry)) + ' · ' + formatAmount(calc.netAmount) + (recipient ? ' · ' + escapeHtml(recipient) + ' 수령' : ' · 판매') + '</span></div></div>';
  }).join('');
  const transferRows = settlement.transfers.length
    ? settlement.transfers.map(function (transfer) {
        const cash = settlement.cashRate > 0 ? ' / ' + formatWon(transfer.amount * settlement.cashRate) : '';
        return '<div class="transfer-row"><b>' + escapeHtml(transfer.from) + ' → ' + escapeHtml(transfer.to) + '</b><span>' + formatAmount(transfer.amount) + cash + '</span></div>';
      }).join('')
    : '<div class="transfer-row"><b>추가 송금 없음</b><span>상계 완료</span></div>';
  return '<section class="group-card done-group">' +
    '<div class="group-card-head"><div><b>' + escapeHtml(getGroupLabel(group)) + '</b><div class="item-sub">완료 그룹 · ' + group.entries.length + '건</div></div><span class="badge done">완료</span></div>' +
    '<div class="group-total">그룹 총 가치 <b>' + formatAmount(settlement.totalValue) + '</b></div>' +
    '<div class="group-items">' + itemRows + '</div>' +
    '<div class="settlement-box"><h3>최종 정산</h3>' + transferRows + '</div>' +
    '<div class="item-actions"><button class="secondary" data-action="copy-group-share" data-group-id="' + escapeHtml(group.id) + '">그룹 공유문 복사</button></div>' +
    '</section>';
}

function completeGroup(groupId) {
  const entries = state.entries.filter(function (entry) { return isPendingEntry(entry) && getEntryGroupId(entry) === groupId; });
  if (!entries.length) return;
  entries.forEach(function (entry) { selectedEntryIds.add(entry.id); });
  completeSelectedBatch();
}

function moveSelectedToGroup() {
  const target = $('#mergeTargetGroup')?.value || '';
  const selected = getSelectedPendingEntries();
  if (!target) { showToast('편입할 대상 그룹을 선택하세요.'); return; }
  if (!selected.length) { showToast('편입할 항목을 선택하세요.'); return; }
  selected.forEach(function (entry) {
    entry.sale = entry.sale || {};
    entry.sale.groupId = target;
  });
  selectedEntryIds.clear();
  state.entries.filter(function (entry) { return isPendingEntry(entry) && getEntryGroupId(entry) === target; }).forEach(function (entry) { selectedEntryIds.add(entry.id); });
  saveState();
  showToast(selected.length + '건을 선택한 그룹에 편입했습니다.');
  renderList();
}

async function copyGroupShare(groupId) {
  const entries = state.entries.filter(function (entry) { return getEntryGroupId(entry) === groupId; });
  const text = buildBatchShareText(entries);
  try {
    await navigator.clipboard.writeText(text);
    showToast('그룹 공유문을 복사했습니다.');
  } catch {
    fallbackCopy(text);
    showToast('그룹 공유문을 복사했습니다.');
  }
}

function getMonthlySummary(monthKey) {
  const monthEntries = state.entries.filter(function (entry) { return String(entry.date || '').startsWith(monthKey); });
  const completed = monthEntries.filter(function (entry) { return entry.status === 'done'; });
  const pending = monthEntries.filter(isPendingEntry);
  const summary = {
    monthKey: monthKey, completed: completed, pending: pending,
    gross: 0, net: 0, pendingNet: 0, groups: getStoredGroups(completed).length,
    memberShares: {}, memberCash: {}, categories: {}, bosses: {},
  };
  completed.forEach(function (entry) {
    const calc = calculateEntry(entry);
    summary.gross += calc.salePrice;
    summary.net += calc.netAmount;
    const share = entry.members.length ? calc.netAmount / entry.members.length : 0;
    entry.members.forEach(function (member) {
      summary.memberShares[member] = (summary.memberShares[member] || 0) + share;
      summary.memberCash[member] = (summary.memberCash[member] || 0) + share * calc.cashRatePerBillion;
    });
    const category = getEntryCategory(entry);
    if (!summary.categories[category]) summary.categories[category] = { name: category, count: 0, value: 0, items: [] };
    summary.categories[category].count += 1;
    summary.categories[category].value += calc.netAmount;
    summary.categories[category].items.push(entry.item);
    if (!summary.bosses[entry.boss]) summary.bosses[entry.boss] = { boss: entry.boss, count: 0, value: 0, desireCount: 0, items: [] };
    summary.bosses[entry.boss].count += 1;
    summary.bosses[entry.boss].value += calc.netAmount;
    if (category === '물욕템') summary.bosses[entry.boss].desireCount += 1;
    summary.bosses[entry.boss].items.push(entry.item + (getEntryRecipient(entry) ? ' (' + getEntryRecipient(entry) + ' 수령)' : ''));
  });
  pending.forEach(function (entry) { summary.pendingNet += calculateEntry(entry).netAmount; });
  summary.gross = roundFloat(summary.gross, 6);
  summary.net = roundFloat(summary.net, 6);
  summary.pendingNet = roundFloat(summary.pendingNet, 6);
  return summary;
}

function renderMonthlySummary(monthKey) {
  const summary = getMonthlySummary(monthKey);
  const memberRows = Object.keys(summary.memberShares).sort().map(function (member) {
    const cash = summary.memberCash[member] > 0 ? ' / ' + formatWon(summary.memberCash[member]) : '';
    return '<div class="summary-row"><b>' + escapeHtml(member) + '</b><span>' + formatAmount(summary.memberShares[member]) + cash + '</span></div>';
  }).join('');
  const categoryRows = Object.values(summary.categories).sort(function (a,b) { return b.value-a.value; }).map(function (category) {
    return '<div class="summary-chip"><b>' + escapeHtml(category.name) + '</b><span>' + category.count + '건 · ' + formatAmount(category.value) + '</span></div>';
  }).join('');
  const bossRows = Object.values(summary.bosses).sort(function (a,b) { return b.value-a.value; }).map(function (boss) {
    return '<div class="boss-summary-row"><div><b>' + escapeHtml(boss.boss) + '</b><span>' + boss.count + '건 · 물욕 ' + boss.desireCount + '건 · ' + formatAmount(boss.value) + '</span></div><p>' + boss.items.map(escapeHtml).join(', ') + '</p></div>';
  }).join('');
  return '<section class="card monthly-summary">' +
    '<div class="section-title monthly-title"><h2>월별 서머리</h2><input id="summaryMonth" type="month" value="' + escapeHtml(monthKey) + '" /></div>' +
    '<div class="monthly-stats"><div class="stat"><span>총 발생 가치</span><b>' + formatAmount(summary.gross) + '</b></div>' +
    '<div class="stat"><span>순 정산 가치</span><b>' + formatAmount(summary.net) + '</b></div>' +
    '<div class="stat"><span>대기 중 가치</span><b>' + formatAmount(summary.pendingNet) + '</b></div>' +
    '<div class="stat"><span>완료 그룹</span><b>' + summary.groups + '</b></div></div>' +
    '<div class="summary-section"><h3>멤버별 나눠가진 지분</h3>' + (memberRows || '<p class="item-sub">완료된 정산이 없습니다.</p>') + '</div>' +
    '<div class="summary-section"><h3>카테고리</h3><div class="summary-chips">' + (categoryRows || '<span class="item-sub">기록 없음</span>') + '</div></div>' +
    '<div class="summary-section"><h3>보스별 드랍 / 물욕</h3>' + (bossRows || '<p class="item-sub">기록 없음</p>') + '</div>' +
    '</section>';
}

function saveRules() {
  state.settings.feeMode = $('#settingFeeMode').value;
  state.settings.feeValue = numberOrZero($('#settingFeeValue').value);
  state.settings.roundingMode = $('#settingRoundingMode').value;
  state.settings.cashRatePerBillion = numberOrZero($('#settingCashRatePerBillion').value);
  saveState();
  showToast('정산 규칙을 저장했습니다. 정산대기 금액에 최신 시세가 즉시 반영됩니다.');
  renderSettings();
}

function openPartyDialog(party = null) {
  $('#partyId').value = party?.id || '';
  $('#partyName').value = party?.name || '';
  $('#partyMembers').value = party?.members?.join(', ') || '';
  $('#partyDialog').showModal();
}

function handlePartySubmit(event) {
  event.preventDefault();
  const id = $('#partyId').value || uid();
  const existing = findParty(id);
  const name = $('#partyName').value.trim();
  const members = splitMembers($('#partyMembers').value);
  if (!members.length) {
    showToast('참여자를 1명 이상 입력하세요.');
    return;
  }
  if (existing) {
    existing.name = name;
    existing.members = members;
  } else {
    state.parties.push({ id, name, members });
  }
  saveState();
  $('#partyDialog').close();
  showToast(existing ? '파티를 수정했습니다.' : '파티를 추가했습니다.');
  render();
}

function deleteParty(id) {
  const party = findParty(id);
  if (!party) return;
  if (state.parties.length <= 1) {
    showToast('파티는 최소 1개 필요합니다.');
    return;
  }
  if (!confirm(`'${party.name}' 파티를 삭제할까요? 기존 정산 기록은 유지됩니다.`)) return;
  state.parties = state.parties.filter((p) => p.id !== id);
  saveState();
  showToast('파티를 삭제했습니다.');
  render();
}

function saveBosses() {
  const bosses = $('#bossList').value.split('\n').map((v) => v.trim()).filter(Boolean);
  if (!bosses.length) {
    showToast('보스명을 1개 이상 입력하세요.');
    return;
  }
  state.settings.bosses = [...new Set(bosses)];
  saveState();
  showToast('보스 목록을 저장했습니다.');
  render();
}

function exportData() {
  const data = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boss-split-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('백업 파일을 만들었습니다.');
}

function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(String(reader.result));
      state = normalizeState(imported);
      saveState();
      showToast('백업 데이터를 가져왔습니다.');
      render();
    } catch {
      showToast('JSON 백업 파일을 확인하세요.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}


function seedDemoData() {
  if (!confirm('데모 데이터를 추가할까요? 기존 데이터는 유지됩니다.')) return;
  const demoParty = state.parties[0] || { name: '기본 파티', members: ['하람', '예원', '민수', '준호'] };
  const now = new Date().toISOString();
  const makeDemo = (date, boss, item, price) => ({
    id: uid(),
    date,
    boss,
    partyName: demoParty.name,
    members: [...demoParty.members],
    item,
    expectedPrice: price,
    memo: '',
    status: 'waiting',
    createdAt: now,
    sale: {
      salePrice: price,
      feeMode: state.settings.feeMode,
      feeValue: state.settings.feeValue,
      excludeAmount: 0,
      roundingMode: state.settings.roundingMode,
      sellerName: demoParty.members[0] || '',
      soldAt: now,
    },
    payments: {},
  });

  const demo1 = makeDemo(new Date().toISOString().slice(0, 10), '하드 스우', '몽환의 벨트', 120);
  const demo2 = makeDemo(offsetDate(-1), '카오스 더스크', '거대한 공포', 88);
  state.entries.unshift(demo1, demo2);
  selectedEntryIds.add(demo1.id);
  selectedEntryIds.add(demo2.id);
  state.activeTab = 'waiting';
  saveState();
  showToast('데모 정산 2건을 추가하고 선택했습니다.');
  render();
}

function resetData() {
  if (!confirm('모든 정산 기록과 설정을 초기화할까요?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  saveState();
  showToast('전체 초기화했습니다.');
  render();
}

function findEntry(id) { return state.entries.find((entry) => entry.id === id); }
function findParty(id) { return state.parties.find((party) => party.id === id); }
function paidCount(entry) { return entry.members.filter((m) => entry.payments?.[m]).length; }
function isAllPaid(entry) { return entry.members.length > 0 && paidCount(entry) === entry.members.length; }
function sortRecent(a, b) { return `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`); }

function filterEntries(entries, keyword) {
  const q = keyword.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(function (entry) {
    return [
      entry.boss, entry.item, entry.partyName, entry.members.join(' '), entry.memo,
      getEntryCategory(entry), getEntryRecipient(entry), getEntryGroupId(entry)
    ].join(' ').toLowerCase().includes(q);
  });
}

function splitMembers(text) {
  return [...new Set(text.split(/[,.，、\n]/).map((v) => v.trim()).filter(Boolean))];
}

function applyRounding(value, mode) {
  const n = Number(value) || 0;
  const factorMap = {
    exact: null,
    floor_001: 1000,
    floor_01: 100,
    round_01: 100,
    round_1: 1,
  };
  if (mode === 'exact') return roundFloat(n, 6);
  if (mode === 'floor_001') return Math.floor(n * factorMap.floor_001) / factorMap.floor_001;
  if (mode === 'floor_01') return Math.floor(n * factorMap.floor_01) / factorMap.floor_01;
  if (mode === 'round_01') return Math.round(n * factorMap.round_01) / factorMap.round_01;
  if (mode === 'round_1') return Math.round(n);
  return roundFloat(n, 6);
}

function roundFloat(num, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(num) + Number.EPSILON) * factor) / factor;
}

function formatAmount(value) {
  const n = Number(value) || 0;
  if (n === 0) return '0억';
  return `${trimDecimal(n)}억`;
}

function roundWon(value) {
  const n = Number(value) || 0;
  return Math.round(n);
}

function formatWon(value) {
  const n = roundWon(value);
  return `${n.toLocaleString('ko-KR')}원`;
}

function trimDecimal(num) {
  return Number(num).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

function normalizeDateValue(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dateToYmd(value);

  let text = String(value).trim();
  if (!text) return '';

  // 이전 버전에서 만들어진 "...undefined.undefined" 꼬리 문구를 먼저 제거합니다.
  text = text.replace(/(?:\.undefined)+$/g, '').trim();

  // Google Sheets/Apps Script가 날짜를 문자열로 바꿔 내려주는 여러 케이스를 흡수합니다.
  // 1) 2026-06-27, 2026.06.27, 2026/06/27
  const numeric = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (numeric) return `${numeric[1]}-${numeric[2].padStart(2, '0')}-${numeric[3].padStart(2, '0')}`;

  // 2) Sat Jun 27 2026 00:00:00 GMT+0900 (한국 표준시)
  const englishDate = text.match(/[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (englishDate) {
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const month = monthMap[englishDate[1]];
    if (month) return `${englishDate[3]}-${month}-${englishDate[2].padStart(2, '0')}`;
  }

  // 3) ISO 문자열 등 브라우저가 해석 가능한 날짜
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return dateToYmd(parsed);

  return text;
}

function dateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateParts(value) {
  const normalized = normalizeDateValue(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { y: match[1], m: match[2], d: match[3] } : null;
}

function formatDate(date) {
  const parts = getDateParts(date);
  if (!parts) return date ? String(date) : '-';
  return `${parts.y}.${parts.m}.${parts.d}`;
}

function formatShortDate(date) {
  const parts = getDateParts(date);
  if (!parts) return date ? String(date) : '-';
  return `${parts.m}.${parts.d}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uid() {
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function roundingOptions(selected) {
  const options = [
    ['exact', '정확히 나누기'],
    ['floor_001', '0.001억 단위 버림'],
    ['floor_01', '0.01억 단위 버림'],
    ['round_01', '0.01억 단위 반올림'],
    ['round_1', '1억 단위 반올림'],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}
