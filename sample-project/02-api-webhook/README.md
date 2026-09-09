# 02 · REST API × 호스티드 웹훅 — 채팅상담 샘플

> 샘플 모음 인덱스는 [`../README.md`](../README.md) 를 보세요.
> 같은 화면을 CLI + 로컬 게이트웨이로 구현한 것이 [`01-cli-gateway`](../01-cli-gateway/) 입니다.

파트너가 **REST API 와 호스티드 웹훅만으로** 카카오 상담톡 상담 화면을 구축하는 최소·완결 샘플입니다.
CLI 를 설치하지 않고, 데몬도 띄우지 않습니다. 조회·발신은 `https://api.talkbridge.io` 를 직접 호출하고,
수신은 톡브릿지 센터의 호스티드 게이트웨이가 **내 공개 URL 로** 서명된 POST 를 보냅니다.

- 런타임: **Node.js 18+**, 의존성 **0개** (`node:http` + 내장 `fetch`)
- 프론트: **바닐라 JS** (01 과 동일 화면)
- 검증 환경: 개발환경 `api.talkbridge-dev.com` / brand `crm-b3e696` / Windows 11 · Node 22.18 · Tailscale Funnel

---

## 0. 이 방식의 핵심 — 상대가 나에게 찾아온다

01 과 갈리는 지점은 딱 하나, **수신을 어떻게 받느냐**입니다.

```
카카오 → TalkBridge 호스티드 게이트웨이
                │
                │  ← TalkBridge 가 내 쪽으로 들어온다
                │     공인 HTTPS 주소가 있어야 도달한다
                ▼
     https://hook.mycompany.com/webhook   (또는 개발 중엔 터널 주소)
```

| | 01 CLI × 게이트웨이 | **02 API × 호스티드 웹훅 (이 샘플)** |
|---|---|---|
| 공인 도메인 · DNS · TLS | 불필요 | **필요** (로컬 개발은 터널) |
| 관리할 상시 프로세스 | 데몬 1개 | **없음** |
| 재시도 | 인메모리 1s→3s, 3회 | **영속 1s→5s→30s→2m→10m, 5회** |
| 프로세스 사망 시 | 재기동 후 저널 재생 | **서버가 보관·재전달** |
| 조회·발신 | CLI 텍스트 파싱 | **REST JSON** — 파서 없음 |

**이래서 유리합니다** — 24/7 상담 운영, 유실이 곧 손실인 서비스, 이미 공개 API 서버가 있는 조직.
**대신 감수할 것** — 공인 HTTPS 엔드포인트. 사설 IP 는 SSRF 방어로 전달되지 않습니다.

> 01 로 검증하고 02 로 승격하는 경로가 자연스럽습니다.
> 서명 스킴과 페이로드가 같아서 `server/signature.js` 는 **한 글자도 안 고치고**,
> `server/webhook.js` 는 **본문 조회 두 줄(import + 호출)만** 바꿔 재사용했습니다(§5).

---

## 1. 무엇을 보여주는 샘플인가

```
고객(카카오톡)
     │  문의
     ▼
TalkBridge ──(호스티드 게이트웨이)──► https://<내 공개 URL>/webhook
                                              │  서명 검증 → 200 → REST 로 본문 보강
                                              ▼
                                       상담 화면 (SSE 실시간)
                                              │  답장
                                              ▼
                        POST https://api.talkbridge.io/api/agent/send ──► 고객
```

---

## 2. 빠른 시작

```bash
# 1) 환경 설정
cp .env.example .env
#   TB_BRAND           ← 톡브릿지 센터의 브랜드 키
#   TB_API_KEY         ← 센터에서 발급한 Agent API 키 (blumnb-…, BrandWrite)
#   TB_WEBHOOK_SECRET  ← 아래 3) 에서 확인하는 whsec_… (API 키와 별개!)
#   TB_API_BASE        ← 실환경은 그대로. 개발환경을 받았다면 그 주소
#   TB_PUBLIC_URL      ← 4) 에서 등록할 내 수신 URL

# 2) 공개 HTTPS 주소 확보
#   운영: 공인 도메인 + TLS (nginx/Caddy 뒤에 이 서버)
#   로컬 개발: 터널 — Tailscale Funnel 예시는 §6.3

# 3) 진단 — 인증·브랜드·공개 URL 도달·서명 로직을 한 번에 본다
npm run doctor

# 4) 톡브릿지 센터 > 브랜드 > "상담 받을 곳 연결" > Webhook
#   URL: https://<내 공개 주소>/webhook
#   여기서 보이는 whsec_ 값을 .env 의 TB_WEBHOOK_SECRET 에 넣는다

# 5) 상담 화면 서버 기동
npm start
#   → http://127.0.0.1:8788/
#   카카오톡에서 채널에 문의를 보내면 수신 이벤트가 화면에 바로 찍힌다
```

> `TB_WEBHOOK_SECRET` 은 **Agent 키에서 결정적으로 파생**됩니다. Agent 키를 재발급/재연결하면
> whsec 도 바뀌므로 `.env` 를 다시 맞춰야 합니다 (`npm run doctor` `[5]` 가 401 이면 정상, 200 이면 검증이 꺼진 것).

---

## 3. 수신 스펙 — 01 과 동일 (실측 확인)

헤더·페이로드·서명식·처리 순서·멱등 규칙은 [01 README §3](../01-cli-gateway/README.md#3-검증된-수신-스펙) 과 같습니다.
2026-09-09 실측: 센터에 Funnel 주소를 등록하고 카카오톡에서 문의 2건 → 호스티드 게이트웨이가 인터넷 경로로
`POST /webhook` 2건 전달, **01 과 동일한 `signature.js` 로 서명 통과**, Delivery-Id 멱등 2건, REST 본문 보강 정상.
다른 것은 **전달 신뢰성**뿐입니다.

REST 응답 봉투도 실측으로 고정했습니다:

```
GET /api/agent/me                      → { name, scope, brands[] }               (봉투 없음)
GET /api/agent/rooms                   → { ok, brand, rooms[] }                   rooms[]: userKey lastSeq lastText lastKind lastTimestampUnixMs count ended
GET /api/agent/rooms/{u}/messages      → { ok, brand, userKey, messages[] }       messages[]: seq userKey sessionId kind text timestampUnixMs — 최신순
```

| | 호스티드 게이트웨이 (02) | CLI 게이트웨이 (01) |
|---|---|---|
| 재시도 | 1s → 5s → 30s → 2m → 10m, 5회 | 1s → 3s, 3회 |
| 영속 | 원장 영속, 재기동 후 재개 | 인메모리 |
| 실패 시 | Failed 표시 + Degraded 보고 | — |
| 도달 조건 | **HTTPS 공인 도메인만** | `127.0.0.1` |

**4xx 도 재시도 대상**입니다. 정상 처리했으면 반드시 200 — 이 규칙을 어기면 5회 동안 같은 이벤트가 반복됩니다.

---

## 4. 발신·조회 스펙 (REST)

| 동작 | 엔드포인트 | 바디 / 쿼리 | 래퍼 |
|---|---|---|---|
| 내 정보 | `GET /api/agent/me` | — | `me` |
| 상담방 목록 | `GET /api/agent/rooms` | `brand`, `max` | `rooms` |
| 방 메시지 | `GET /api/agent/rooms/{userKey}/messages` | `brand`, `max`(1~300) | `roomMessages` |
| 텍스트 발신 | `POST /api/agent/send` | `brandKey`, `userKey`, `text` | `send` |
| 리치 발신 | `POST /api/agent/send/rich` | `brandKey`, `userKey`, `rich`(문자열) | `sendRich` |
| 종료 | `POST /api/agent/end` | `brandKey`, `userKey`, `greeting?` | `end` |
| 종료+봇전환 | `POST /api/agent/end-with-bot` | `brandKey`, `userKey`, `botEvent?` | `endWithBot` |
| 차단/해제 | `POST /api/agent/block` · `unblock` | `brandKey`, `userKey` | `block` |

- 헤더 `Authorization: Bearer blumnb-…`. 조회는 BrandRead, 발신·설정은 BrandWrite
- 응답 봉투 `{ ok, code, message, ... }` — `FORBIDDEN` / `NO_BRAND_SCOPE` 는 재시도 무의미, `NO_PERSISTENCE`(503) 는 재시도
- **활성 세션에만 발신됩니다.** 발신은 **구독 상담 건수를 소진**합니다(조회는 비과금)

### 01 (CLI) 과 다른 점

| 항목 | 01 CLI | 02 REST |
|---|---|---|
| 순수 종료 | 없음 (`end-with-bot` 만) | `end` 있음 |
| 발신 취소 `delete` | 있음 | **REST 에 없음** |
| `history` / `convId` | 있음 | **REST 에 없음** |
| 첨부 발신 | `send --file` 한 번 | `upload/image` → URL → `send/rich` 조립 |
| 출력 | 텍스트 파싱 | JSON |

---

## 5. 구조 — 01 에서 무엇이 바뀌었나

```
02-api-webhook/
├─ server/
│  ├─ index.js        HTTP 라우팅 + 정적 서빙 + 부팅 백필      (01 과 같은 뼈대, CLI 호출 → REST)
│  ├─ config.js       .env 로더                                 (키 이름만 다름)
│  ├─ api.js          ★ REST 클라이언트 + 응답 정규화           (01 의 cli.js 자리, 절반 길이)
│  ├─ signature.js    ★ HMAC 서명 검증                          ← 01 과 바이트 단위 동일
│  ├─ webhook.js      ★ 수신 핸들러                             ← 01 과 동일, 본문 조회 2줄(import·호출)만 api.js
│  ├─ store.js        인메모리 저장소 + 멱등 집합                ← 01 과 동일
│  └─ sse.js          브라우저 실시간 푸시                       ← 01 과 동일
├─ public/            3분할 상담 화면                            ← 01 과 동일 (문구만)
├─ scripts/
│  ├─ doctor.mjs      진단 6종 — REST 인증 · 공개 URL 도달성 · 서명 실패 케이스
│  └─ screenshot.mjs  소개용 스크린샷 (Playwright, 선택)
└─ .env.example
```

`api.js` 는 응답을 **01 의 CLI 래퍼와 같은 모델**(`userKey/kind/seq/text/at/direction`)로 정규화합니다.
그래서 `store.js`·`webhook.js`·프론트가 어느 샘플에서든 같은 데이터를 봅니다 —
파트너가 01 위에 만든 커스텀 로직은 02 로 옮길 때 그대로 살아남습니다.

### 서버 API

| 메서드 | 경로 | REST 대응 |
|---|---|---|
| POST | `/webhook` | (호스티드 게이트웨이 수신) |
| GET | `/api/events` | SSE 실시간 채널 |
| GET | `/api/me` | `GET /api/agent/me` |
| GET | `/api/rooms` | `GET /api/agent/rooms` |
| GET | `/api/rooms/:userKey/messages` | `GET /api/agent/rooms/{userKey}/messages` |
| POST | `/api/send` | `POST /api/agent/send` |
| POST | `/api/end` (`mode:"plain"` 이면 `end`) | `end-with-bot` / `end` |
| POST | `/api/block` · `/api/unblock` | `block` / `unblock` |

---

## 6. 구현 노트 — 따라 할 때 걸리는 지점

### 6.1 응답 봉투 안 어디에 배열이 있나

공개 매뉴얼은 `rooms[]`·`messages[]` 의 **필드**는 적지만 봉투 안 **위치**는 명시하지 않습니다.
실측(§3)으로는 **최상위 키**(`rooms`, `messages`)에 있고 `me` 는 봉투 없이 본문만 옵니다.
`api.js` 의 `pick()` 은 그래도 최상위 키 → `data.키` → `data` 배열 순으로 찾아, 봉투가 바뀌어도 버팁니다.
`npm run doctor` `[4]` 가 "응답은 정상인데 0개" 를 잡고 응답 키를 보여줍니다.

### 6.2 시각은 `timestampUnixMs`

01 의 CLI 는 연도 없는 `09-08 10:28` 을 줘서 보정이 필요했지만, REST 는 epoch ms 를 줍니다.
`api.js` 가 ISO 로 올려 화면 모델(`at`)에 넣습니다.

### 6.3 로컬 개발과 터널 — Tailscale Funnel

호스티드 게이트웨이는 사설 IP 로 전달하지 않습니다. 노트북에서 개발하려면 터널이 필요합니다.
Tailscale Funnel 은 도메인·인증서 없이 `https://<node>.<tailnet>.ts.net` 을 줍니다:

```bash
# Git Bash 라면 MSYS 경로 변환을 끈다 (안 끄면 /webhook 이 C:/Program Files/Git/webhook 이 된다)
export MSYS_NO_PATHCONV=1
tailscale funnel --bg --set-path=/webhook http://127.0.0.1:8788/webhook
tailscale funnel status
#   https://<node>.<tailnet>.ts.net (Funnel on)
#   |-- /webhook proxy http://127.0.0.1:8788/webhook
```

- **`/webhook` 경로만** 마운트합니다. 루트를 열면 인증 없는 상담 화면과 `/api/send`(과금) 가 인터넷에 노출됩니다
- Funnel 을 연 PC 에서 그 주소를 `curl` 하면 MagicDNS 가 tailnet IP 로 풀어 **타임아웃**됩니다 — 공개 경로 테스트가 아닙니다.
  `npm run doctor` `[5]` 는 공개 DNS(8.8.8.8)로 풀어 그 IP 에 SNI 로 붙기 때문에 실제 인터넷 경로를 검사합니다
- 끄기: `tailscale funnel --https=443 off`

### 6.4 `fetch` 와 Node 18

Node 18~20 은 내장 `fetch` 가 experimental 이라 첫 호출에 경고 한 줄이 찍힐 수 있습니다(동작 무관).
21+ 는 없습니다. `AbortSignal.timeout()` 으로 REST 타임아웃을 겁니다.

### 6.5 `agent` echo 는 두 번 온다

발신에 성공하면 내 웹훅으로 `kind:"agent"` 가 되돌아옵니다. 실측으로는 **발신 1건에 두 번** 옵니다:

```
① 즉시      {"userKey":"…","kind":"agent","brand":"…"}            ← seq 없음 (발신 접수 신호)
② 약 1초 뒤  {"userKey":"…","kind":"agent","seq":16,"brand":"…"}   ← 저널 항목
```

`webhook.js` 는 ①을 저장하지 않고 SSE `ack` 로만 흘리고, ②가 오면 `store.js` 가 같은 본문의 낙관적(pending) 말풍선을 치웁니다.
이 처리가 없으면 답장 하나가 **말풍선 세 개**(pending · seq 없음 · seq 있음)로 보입니다.
`POST /api/agent/send` 응답에는 `serial`(`bw-…`)이 들어 있습니다.

**자동응답을 붙인다면 `webhook.js` 의 `case 'agent'` 에서 응답 생성을 타지 않게** 하세요. 안 그러면 무한 루프입니다.

### 6.6 게이트웨이가 실제로 무엇을 보내는지 보기

```bash
TB_DEBUG_WEBHOOK=1 npm start
#   [webhook:debug] {"x-bridge-event":"agent","x-bridge-delivery-id":"…","x-bridge-signature":"v0=509dad10e…",…} {"userKey":"…","kind":"agent","brand":"…"}
```

서명값은 앞 12자만 남깁니다. 페이로드 형식이 의심될 때만 켜세요.

---

## 7. 운영으로 옮길 때

| 지금(샘플) | 운영에서 |
|---|---|
| 인메모리 저장소 | DB — 멱등 테이블(`delivery_id` UNIQUE) + 메시지 테이블 |
| 터널(Funnel) | 공인 도메인 + 리버스 프록시(TLS 종단) 뒤에 이 서버 |
| `HOST=127.0.0.1` | 프록시 뒤라면 그대로. 직접 노출이면 상담원 인증 필수 |
| 인증 없는 상담 화면 | 상담원 로그인·권한 |
| 사람이 답장 | `webhook.js` 의 보강 직후에 LLM 호출 → AI 상담봇 (`agent` echo 필터 필수) |

---

## 8. 문제 해결

| 증상 | 원인·조치 |
|---|---|
| `me` 가 401 | `TB_API_KEY` 오타/만료, 또는 `TB_API_BASE` 가 키를 발급한 환경과 다름(실환경 키로 개발환경 호출 등) |
| `NO_BRAND_SCOPE` | 키가 `TB_BRAND` 브랜드에 묶여 있지 않음 — 센터에서 브랜드별 키 확인 |
| 웹훅이 전부 401 | 센터의 whsec 와 `.env` 의 `TB_WEBHOOK_SECRET` 불일치. Agent 키 재발급 시 whsec 도 바뀜 |
| 이벤트가 안 옴 | 센터 Webhook 연결 URL 확인, `npm run doctor` `[5]` 로 인터넷 경로 도달 확인, 센터의 전달 상태(Failed/Degraded) 확인 |
| 같은 이벤트가 5번 옴 | 서버가 2xx 를 안 돌려줌 (예외로 500) — 서명 통과 후엔 무조건 200 |
| `rooms` 가 0개로 파싱됨 | 봉투 구조 변경 → `doctor [4]` 가 보여주는 응답 키로 `api.js` `pick()` 조정 |
| 발신이 세션 오류로 실패 | 종료·만료된 상담. 새 문의가 와야 재개 |
| Funnel 주소가 로컬에서 타임아웃 | 정상(MagicDNS). §6.3 |
| `curl` 로 보낸 한글이 `�ѱ�`/`??` 로 깨져 발송됨 | **보내는 쪽** 문제. Windows 에서 한글을 명령행 인자(`-d '…'`)로 넘기면 코드페이지 949 로 재해석됨. `--data-binary @-` 히어독·파일, 또는 Node `fetch` 로 보낼 것. PowerShell 은 `-Body ([Text.Encoding]::UTF8.GetBytes($json))`. 서버는 바이트를 변형하지 않음 |

---

## 9. 참고

- 샘플 모음 인덱스: [`../README.md`](../README.md)
- 01 샘플 (CLI × 게이트웨이): [`../01-cli-gateway/`](../01-cli-gateway/)
- 공개 매뉴얼: <https://api.talkbridge.io/>
- 매뉴얼 요약: [`../../docs/talkbridge-manual-digest.md`](../../docs/talkbridge-manual-digest.md)
- 기술 문의: TalkBridge 디스코드 커뮤니티 / `help@talkbridge.io`
