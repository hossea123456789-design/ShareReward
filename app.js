const STORAGE_KEY = 'bossSplitLedger.v1';
const REMOTE_URL_KEY = 'bossSplitLedger.remoteUrl.v1';
const CLIENT_ID_KEY = 'bossSplitLedger.clientId.v1';
const APP_VERSION = '4.1.0';
const DEFAULT_REMOTE_URL = (window.BOSS_SPLIT_REMOTE_URL || '').trim() || 'https://script.google.com/macros/s/AKfycbwn3g81buXd0YFZsq3qdXFJxk6KCKfMlR1WXEdMffAUsoq3glf9PVr5zebCJvkrL7H2/exec'; // 기본 공유 저장소 URL

const statusMap = {
  waiting: { label: '판매대기', cls: 'waiting' },
  settling: { label: '정산중', cls: 'settling' },
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
  $('#quickAddBtn').addEventListener('click', () => openEntryDialog());

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      state.detailId = null;
      saveState({ localOnly: true });
      render();
    });
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => btn.addEventListener('click', () => $('#entryDialog').close()));
  document.querySelectorAll('[data-close-sale-dialog]').forEach((btn) => btn.addEventListener('click', () => $('#saleDialog').close()));
  document.querySelectorAll('[data-close-party-dialog]').forEach((btn) => btn.addEventListener('click', () => $('#partyDialog').close()));

  $('#entryParty').addEventListener('change', refreshEntryMembersFromParty);
  $('#addTempMemberBtn').addEventListener('click', addTempMemberToEntry);
  $('#entryForm').addEventListener('submit', handleEntrySubmit);

  $('#saleForm').addEventListener('submit', handleSaleSubmit);
  ['salePrice', 'feeMode', 'feeValue', 'excludeAmount', 'cashRatePerBillion', 'sellerName', 'roundingMode'].forEach((id) => {
    $(`#${id}`).addEventListener('input', renderCalcPreview);
    $(`#${id}`).addEventListener('change', renderCalcPreview);
  });
  $('#feeMode').addEventListener('change', () => {
    $('#feeValueLabel').textContent = $('#feeMode').value === 'percent' ? '수수료 %' : '수수료 금액, 억 단위';
  });

  $('#partyForm').addEventListener('submit', handlePartySubmit);

  app.addEventListener('click', handleAppClick);
  app.addEventListener('change', handleAppChange);
}

function setTodayToEntryDialog() {
  $('#entryDate').value = new Date().toISOString().slice(0, 10);
}

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
    date: entry.date || new Date().toISOString().slice(0, 10),
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
    settling: () => renderList('settling'),
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
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthEntries = state.entries.filter((e) => e.date.startsWith(monthKey));
  const waiting = state.entries.filter((e) => e.status === 'waiting').length;
  const settling = state.entries.filter((e) => e.status === 'settling').length;
  const doneThisMonth = monthEntries.filter((e) => e.status === 'done').length;
  const unpaidCount = state.entries
    .filter((e) => e.status === 'settling')
    .reduce((acc, e) => acc + e.members.filter((m) => !e.payments?.[m]).length, 0);
  const recent = [...state.entries].sort(sortRecent).slice(0, 5);

  app.innerHTML = `
    <section class="card">
      <div class="summary-grid">
        <div class="stat"><span>판매대기</span><b>${waiting}</b></div>
        <div class="stat"><span>정산중</span><b>${settling}</b></div>
        <div class="stat"><span>이번 달 완료</span><b>${doneThisMonth}</b></div>
        <div class="stat"><span>미지급 인원</span><b>${unpaidCount}</b></div>
        <div class="stat"><span>저장 파티</span><b>${state.parties.length}</b></div>
        <div class="stat"><span>전체 기록</span><b>${state.entries.length}</b></div>
      </div>
      <button class="big-action" data-action="new-entry">+ 새 정산 만들기</button>
    </section>

    <div class="section-title">
      <h2>최근 정산</h2>
      <span class="sub">최신 5건</span>
    </div>
    ${recent.length ? `<div class="list">${recent.map(entryCard).join('')}</div>` : emptyState('아직 정산 기록이 없습니다', '보스 처치 후 드랍이 나오면 새 정산을 만들어보세요.')}
  `;
}

function renderList(status) {
  const title = status === 'waiting' ? '판매대기' : '정산중';
  const desc = status === 'waiting'
    ? '거래소 판매 전인 아이템만 모았습니다.'
    : '판매는 끝났고 지급 체크가 남은 정산입니다.';
  const list = state.entries.filter((e) => e.status === status).sort(sortRecent);
  app.innerHTML = `
    <section class="card">
      <h2>${title}</h2>
      <p class="item-sub">${desc}</p>
      ${status === 'waiting' ? '<button class="big-action" data-action="new-entry">+ 판매대기 추가</button>' : ''}
    </section>
    <div class="section-title"><h2>${title} 목록</h2><span class="sub">${list.length}건</span></div>
    ${list.length ? `<div class="list">${list.map(entryCard).join('')}</div>` : emptyState(`${title} 기록이 없습니다`, status === 'waiting' ? '판매할 드랍템이 생기면 새 정산을 추가하세요.' : '판매 완료 입력을 하면 이곳에 표시됩니다.')}
  `;
}

function renderDone() {
  const keyword = sessionStorage.getItem('bossSplit.search') || '';
  const done = state.entries.filter((e) => e.status === 'done');
  const filtered = filterEntries(done, keyword).sort(sortRecent);
  app.innerHTML = `
    <section class="card">
      <h2>정산완료</h2>
      <p class="item-sub">보스명, 아이템명, 참여자명으로 검색할 수 있습니다.</p>
    </section>
    <div class="section-title"><h2>완료 기록</h2><span class="sub">${filtered.length}/${done.length}건</span></div>
    <div class="search-row">
      <input id="doneSearch" type="search" value="${escapeHtml(keyword)}" placeholder="예: 하드 스우, 몽환, 하람" />
      <button class="secondary" data-action="clear-search">초기화</button>
    </div>
    ${filtered.length ? `<div class="list">${filtered.map(entryCard).join('')}</div>` : emptyState('검색 결과가 없습니다', '다른 보스명, 아이템명, 참여자명으로 검색해보세요.')}
  `;
  $('#doneSearch')?.addEventListener('input', (event) => {
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
  const sale = entry.sale;
  const st = statusMap[entry.status] || statusMap.waiting;
  const copyText = buildShareText(entry);
  app.innerHTML = `
    <section class="item-card">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(entry.boss)} 정산</div>
          <div class="item-sub">${formatDate(entry.date)} · ${escapeHtml(entry.partyName)} · ${entry.members.length}인</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="kv-grid">
        <div class="kv"><span>아이템</span><b>${escapeHtml(entry.item)}</b></div>
        <div class="kv"><span>예상가</span><b>${formatAmount(entry.expectedPrice)}</b></div>
        <div class="kv"><span>참여자</span><b>${entry.members.map(escapeHtml).join(', ') || '-'}</b></div>
        <div class="kv"><span>상태</span><b>${st.label}</b></div>
      </div>
      ${entry.memo ? `<div class="detail-block"><h3>메모</h3><p class="item-sub">${escapeHtml(entry.memo)}</p></div>` : ''}
      <div class="item-actions">
        <button class="ghost" data-action="back-list">목록으로</button>
        <button class="secondary" data-action="edit-entry" data-id="${entry.id}">수정</button>
        ${entry.status === 'waiting' ? `<button class="primary" data-action="open-sale" data-id="${entry.id}">판매 완료 입력</button>` : ''}
        <button class="danger" data-action="delete-entry" data-id="${entry.id}">삭제</button>
      </div>
    </section>

    ${sale ? renderSaleSummary(entry) : ''}

    ${sale ? `
      <section class="card detail-block">
        <div class="section-title" style="margin-top:0">
          <h2>지급 현황</h2>
          <span class="sub">${paidCount(entry)}/${entry.members.length}명 완료</span>
        </div>
        <div class="payment-list">
          ${entry.members.map((member) => {
            const isSeller = member === sale.sellerName;
            const cashLabel = sale.cashRatePerBillion > 0 ? ` · ${formatWon(sale.perPersonCash)}` : '';
            return `
            <div class="payment-row ${isSeller ? 'seller-row' : ''}">
              <label>
                <input type="checkbox" data-action="toggle-payment" data-id="${entry.id}" data-member="${escapeHtml(member)}" ${entry.payments?.[member] || isSeller ? 'checked' : ''} ${isSeller ? 'disabled' : ''} />
                ${escapeHtml(member)}${isSeller ? ' <em>판매자</em>' : ''}
              </label>
              <span class="payment-amount">${formatAmount(sale.perPerson)}${cashLabel}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="item-actions">
          <button class="secondary" data-action="all-paid" data-id="${entry.id}">전체 지급 완료</button>
          <button class="ghost" data-action="reopen-settling" data-id="${entry.id}">정산중으로 되돌리기</button>
        </div>
      </section>

      <section class="card detail-block">
        <div class="section-title" style="margin-top:0">
          <h2>카톡 공유 문구</h2>
          <button class="primary small" data-action="copy-share" data-id="${entry.id}">복사</button>
        </div>
        <div class="copy-box">${escapeHtml(copyText)}</div>
      </section>
    ` : ''}
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
        <span>기본 억당 현금가, 원</span>
        <input id="settingCashRatePerBillion" type="number" step="1" min="0" value="${state.settings.cashRatePerBillion || 0}" placeholder="예: 2500" />
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
  const st = statusMap[entry.status] || statusMap.waiting;
  const saleLine = entry.sale
    ? `판매가 ${formatAmount(entry.sale.salePrice)} · 1인당 ${formatAmount(entry.sale.perPerson)}${entry.sale.cashRatePerBillion > 0 ? ` / ${formatWon(entry.sale.perPersonCash)}` : ''}`
    : `예상가 ${formatAmount(entry.expectedPrice)}`;
  return `
    <article class="item-card" data-id="${entry.id}">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(entry.boss)}</div>
          <div class="item-sub">${formatDate(entry.date)} · ${entry.members.length}인 · ${escapeHtml(entry.item)}</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="item-meta">
        <span class="badge draft">${escapeHtml(entry.partyName)}</span>
        <span class="badge draft">${saleLine}</span>
        ${entry.status === 'settling' ? `<span class="badge problem">미지급 ${entry.members.length - paidCount(entry)}명</span>` : ''}
      </div>
      <div class="item-actions">
        <button class="ghost" data-action="detail" data-id="${entry.id}">상세</button>
        ${entry.status === 'waiting' ? `<button class="primary" data-action="open-sale" data-id="${entry.id}">판매 완료</button>` : ''}
        ${entry.sale ? `<button class="secondary" data-action="copy-share" data-id="${entry.id}">공유문구 복사</button>` : ''}
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

  const actions = {
    'new-entry': () => openEntryDialog(),
    detail: () => openDetail(id),
    'back-list': () => { state.detailId = null; saveState({ localOnly: true }); render(); },
    'edit-entry': () => openEntryDialog(findEntry(id)),
    'delete-entry': () => deleteEntry(id),
    'open-sale': () => openSaleDialog(id),
    'copy-share': () => copyShare(id),
    'all-paid': () => markAllPaid(id),
    'reopen-settling': () => reopenSettling(id),
    'clear-search': () => { sessionStorage.removeItem('bossSplit.search'); renderDone(); },
    'save-rules': saveRules,
    'new-party': () => openPartyDialog(),
    'edit-party': () => openPartyDialog(findParty(id)),
    'delete-party': () => deleteParty(id),
    'save-bosses': saveBosses,
    'export-data': exportData,
    'import-data': () => $('#importFile').click(),
    'seed-demo': seedDemoData,
    'reset-data': resetData,
    'save-remote-url': saveRemoteUrlFromSettings,
    'clear-remote-url': clearRemoteUrl,
    'pull-remote': () => pullRemoteState(),
    'push-remote': () => pushRemoteState(),
  };
  actions[action]?.();
}

function handleAppChange(event) {
  const target = event.target;
  if (target.matches('[data-action="toggle-payment"]')) {
    const entry = findEntry(target.dataset.id);
    if (!entry) return;
    entry.payments = entry.payments || {};
    entry.payments[target.dataset.member] = target.checked;
    entry.status = isAllPaid(entry) ? 'done' : 'settling';
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
  $('#entryDialogTitle').textContent = entry ? '정산 수정' : '새 정산 만들기';
  $('#entryId').value = entry?.id || '';
  $('#entryDate').value = entry?.date || new Date().toISOString().slice(0, 10);
  $('#entryBoss').value = entry?.boss || state.settings.bosses[0] || '';
  $('#entryParty').value = entry ? '__custom__' : (state.parties[0]?.id || '__custom__');
  $('#entryItem').value = entry?.item || '';
  $('#entryExpectedPrice').value = entry?.expectedPrice || '';
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
  const party = findParty($('#entryParty').value);
  const payload = {
    id,
    date: $('#entryDate').value,
    boss: $('#entryBoss').value,
    partyName: party?.name || '직접 선택',
    members,
    item: $('#entryItem').value.trim(),
    expectedPrice: numberOrZero($('#entryExpectedPrice').value),
    memo: $('#entryMemo').value.trim(),
    status: existing?.status || 'waiting',
    createdAt: existing?.createdAt || new Date().toISOString(),
    sale: existing?.sale || null,
    payments: prunePayments(existing?.payments || {}, members),
  };
  if (existing) {
    Object.assign(existing, payload);
  } else {
    state.entries.unshift(payload);
  }
  saveState();
  $('#entryDialog').close();
  state.detailId = id;
  showToast(existing ? '정산을 수정했습니다.' : '새 정산을 만들었습니다.');
  render();
}

function prunePayments(payments, members) {
  return Object.fromEntries(members.map((member) => [member, Boolean(payments[member])]));
}

function openSaleDialog(id) {
  const entry = findEntry(id);
  if (!entry) return;
  $('#saleEntryId').value = id;
  $('#saleTarget').innerHTML = `<b>${escapeHtml(entry.item)}</b><div class="item-sub">${escapeHtml(entry.boss)} · ${entry.members.length}인 · 예상가 ${formatAmount(entry.expectedPrice)}</div>`;
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
  const lines = [];
  const line = '━━━━━━━━━━━━';
  lines.push(`[${entry.boss} 정산]`);
  lines.push(line);
  lines.push(`${formatDate(entry.date)} · ${entry.item}`);
  lines.push(`참여: ${entry.members.join(', ')}`);

  if (!entry.sale) {
    lines.push(line);
    lines.push(`예상가: ${formatAmount(entry.expectedPrice)}`);
    lines.push('상태: 판매대기');
    return lines.join('\n');
  }

  const sale = entry.sale;
  const paid = entry.members.filter((m) => entry.payments?.[m] && m !== sale.sellerName);
  const unpaid = entry.members.filter((m) => !entry.payments?.[m] && m !== sale.sellerName);
  const feePart = sale.excludeAmount > 0
    ? `${formatAmount(sale.salePrice)} - ${formatAmount(sale.feeAmount)} - ${formatAmount(sale.excludeAmount)} = ${formatAmount(sale.netAmount)}`
    : `${formatAmount(sale.salePrice)} - ${formatAmount(sale.feeAmount)} = ${formatAmount(sale.netAmount)}`;

  lines.push(line);
  lines.push(`판매: ${feePart}`);

  if (sale.cashRatePerBillion > 0) {
    lines.push(`1인: ${formatAmount(sale.perPerson)} / ${formatWon(sale.perPersonCash)}`);
    lines.push(`시세: 억당 ${formatWon(sale.cashRatePerBillion)}`);
    lines.push(line);
    lines.push(`판매자: ${sale.sellerName || '-'}`);
    lines.push(`전달예정: ${formatWon(sale.transferCash)}`);
  } else {
    lines.push(`1인: ${formatAmount(sale.perPerson)}`);
    lines.push(line);
  }

  lines.push(`완료: ${paid.length ? paid.join(', ') : '-'}`);
  lines.push(`미지급: ${unpaid.length ? unpaid.join(', ') : '-'}`);
  return lines.join('\n');
}

function saveRules() {
  state.settings.feeMode = $('#settingFeeMode').value;
  state.settings.feeValue = numberOrZero($('#settingFeeValue').value);
  state.settings.roundingMode = $('#settingRoundingMode').value;
  state.settings.cashRatePerBillion = numberOrZero($('#settingCashRatePerBillion').value);
  saveState();
  showToast('정산 규칙을 저장했습니다.');
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
  const demo1 = {
    id: uid(),
    date: new Date().toISOString().slice(0, 10),
    boss: '하드 스우',
    partyName: demoParty.name,
    members: demoParty.members,
    item: '몽환의 벨트',
    expectedPrice: 120,
    memo: '거래소 판매 후 n빵 예정',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    sale: null,
    payments: {},
  };
  const demoCashRate = state.settings.cashRatePerBillion || 2500;
  const demoPerPerson = applyRounding(83.6 / demoParty.members.length, state.settings.roundingMode);
  const demoSeller = demoParty.members[0] || '하람';
  const demo2 = {
    id: uid(),
    date: offsetDate(-1),
    boss: '카오스 더스크',
    partyName: demoParty.name,
    members: demoParty.members,
    item: '거대한 공포',
    expectedPrice: 88,
    memo: '',
    status: 'settling',
    createdAt: new Date().toISOString(),
    sale: {
      salePrice: 88,
      feeMode: 'percent',
      feeValue: 5,
      feeAmount: 4.4,
      excludeAmount: 0,
      netAmount: 83.6,
      perPerson: demoPerPerson,
      roundingMode: state.settings.roundingMode,
      cashRatePerBillion: demoCashRate,
      sellerName: demoSeller,
      totalCash: roundWon(83.6 * demoCashRate),
      perPersonCash: roundWon(demoPerPerson * demoCashRate),
      transferCash: roundWon(demoPerPerson * demoCashRate * Math.max(0, demoParty.members.length - 1)),
      soldAt: new Date().toISOString(),
    },
    payments: Object.fromEntries(demoParty.members.map((member, idx) => [member, idx === 0])),
  };
  state.entries.unshift(demo1, demo2);
  saveState();
  showToast('데모 데이터를 추가했습니다.');
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
  return entries.filter((entry) => [entry.boss, entry.item, entry.partyName, entry.members.join(' '), entry.memo]
    .join(' ')
    .toLowerCase()
    .includes(q));
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

function formatDate(date) {
  if (!date) return '-';
  const [y, m, d] = date.split('-');
  return `${y}.${m}.${d}`;
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
