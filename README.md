# 보스 정산 공유 웹앱 v4.3

## 구성

- `index.html`: 웹앱 진입 파일
- `style.css`: 화면 스타일
- `app.js`: 정산 기능, 공유 동기화 기능
- `Code.gs.txt`: Google Apps Script 백엔드 코드

## v4 변경점

- 다른 사람이 링크로 접속할 수 있는 공유 웹앱 구조 추가
- Google Sheets + Apps Script 저장소 연동
- 설정 화면에 Apps Script 웹앱 URL 입력란 추가
- 공유 데이터 불러오기 / 현재 데이터 올리기 버튼 추가
- 변경 시 자동 공유 저장
- 기존 JSON 백업/복원 유지

## 배포 방법 요약

### 1. Google Sheets 만들기

1. 구글 드라이브에서 새 스프레드시트를 만든다.
2. 이름 예시: `보스 정산 DB`
3. 메뉴에서 `확장 프로그램 > Apps Script`를 연다.
4. 기본 코드 전체를 지우고 `Code.gs.txt` 내용을 붙여넣는다.
5. 저장한다.

### 2. Apps Script 웹앱 배포

1. Apps Script 우측 상단 `배포 > 새 배포` 클릭
2. 유형 선택에서 `웹 앱` 선택
3. 실행 계정: `나`
4. 액세스 권한: 같이 볼 사람이 로그인 없이 써도 되면 `모든 사용자`
5. 배포 후 나오는 `/exec` URL을 복사한다.

### 3. 프런트 배포

#### 가장 쉬운 테스트

`index.html`을 직접 열고 설정 탭에 Apps Script URL을 입력한다.

#### 공유 링크로 쓰기

GitHub Pages, Netlify, Cloudflare Pages 같은 정적 호스팅에 `index.html`, `style.css`, `app.js`를 올린다.
그 다음 웹앱에서 설정 탭에 Apps Script URL을 입력한다. 더 편하게 쓰려면 `app.js` 상단의 `DEFAULT_REMOTE_URL = ''`에 Apps Script `/exec` URL을 미리 넣어 배포하면, 접속자마다 URL을 따로 입력하지 않아도 된다.

## 사용 흐름

1. 웹앱 접속
2. 설정 > 공유 웹앱 연결
3. Apps Script 웹앱 URL 입력
4. `URL 저장` 클릭
5. 기존 로컬 데이터가 있으면 `현재 데이터 올리기`
6. 다른 사람은 같은 프런트 주소로 접속 후 같은 Apps Script URL을 입력하거나, 미리 입력된 버전으로 배포해서 사용

## 주의

- 이 버전은 마지막 저장이 기준입니다.
- 여러 사람이 동시에 같은 정산 건을 수정하면 나중에 저장한 내용이 남습니다.
- 민감한 개인정보나 계좌번호는 넣지 않는 것을 권장합니다.
- Apps Script 액세스 권한을 `모든 사용자`로 열면 URL을 아는 사람이 접근할 수 있습니다.


## v4 연결 적용

Apps Script 기본 URL이 `index.html`과 `app.js`에 내장되어 있다.

```text
https://script.google.com/macros/s/AKfycbwn3g81buXd0YFZsq3qdXFJxk6KCKfMlR1WXEdMffAUsoq3glf9PVr5zebCJvkrL7H2/exec
```

GitHub Pages에는 `index.html`, `style.css`, `app.js`, `README.md`를 교체 업로드하면 된다.


## v4.1 수정 내역

- 웹페이지를 새로 열면 항상 홈 화면에서 시작하도록 수정했습니다.
- 하단 탭 이동, 상세 화면 이동 같은 UI 상태 변경은 공유 저장소에 올리지 않도록 분리했습니다.
- 정산 규칙 저장 후 공유 저장이 완료될 때 설정 화면이 다시 그려져 입력값이 덮이는 느낌이 나던 문제를 줄였습니다.
- Apps Script 기본 연결 URL은 기존과 동일하게 포함되어 있습니다.

## v4.3 수정 내역

- Google Sheets에서 날짜가 `Sat Jun 27 2026 00:00:00 GMT+0900 ...` 형태로 내려와도 `2026.06.27`로 표시되도록 보정했습니다.
- 목록 카드의 날짜 표기는 `06.27 · 2인 · 아이템명`처럼 짧게 줄였습니다.
- 상세 화면 상단 문구에서 불필요한 `기본 파티` 노출을 제거했습니다.
- Apps Script가 Entries 시트의 날짜 열을 텍스트로 저장하도록 보강했습니다.

## 교체 파일

GitHub Pages에는 `index.html`, `style.css`, `app.js`를 교체하면 됩니다.
Apps Script는 `Code.gs.txt` 내용으로 교체 배포하면 날짜 저장이 더 안정적입니다.


## v4.3 수정 사항

- GitHub Pages/브라우저 캐시 때문에 이전 `app.js`가 계속 실행되는 문제를 줄이기 위해 `app.js?v=4.3.0` 캐시 버스터를 적용했습니다.
- `Sat Jun 27 2026 00:00:00 GMT+0900 (한국 표준시).undefined.undefined` 형태의 날짜 문자열을 `2026.06.27` / `06.27` 형식으로 강제 보정합니다.
- 최근 정산 카드에서 `기본 파티` 배지를 제거해 목록을 더 짧게 표시합니다.
- Apps Script 코드 버전을 4.3.0으로 갱신했습니다.
