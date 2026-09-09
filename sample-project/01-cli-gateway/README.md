# 01 · CLI × Gateway — 채팅상담 샘플

> 샘플 모음 인덱스는 [`../README.md`](../README.md) 를 보세요.
> 다음 샘플 `02-api-webhook` 은 같은 화면을 REST API + 호스티드 웹훅으로 구현합니다.

파트너가 **TalkBridge CLI 와 게이트웨이만으로** 카카오 상담톡 상담 화면을 구축하는
최소·완결 샘플입니다. REST 를 직접 호출하지 않고 모든 조회·발신을 CLI 로 처리합니다.

- 런타임: **Node.js 18+**, 의존성 **0개** (`node:http` 내장 모듈만)
- 프론트: **바닐라 JS** (프레임워크·번들러 없음)
- 검증 환경: `talkbridge-dev` v1.0.0 → v1.1.0 재검증 / brand `crm-b3e696` / Windows 11 · Node 22.18

![상담 화면 — 상담방 목록, 대화, 실시간 수신 이벤트](docs/screenshot.png)

> 왼쪽은 CLI `rooms` 로 읽은 상담방, 가운데는 `rooms --user` 로 보강한 대화,
> 오른쪽은 게이트웨이가 밀어 넣은 수신 이벤트가 실시간으로 쌓이는 로그입니다.
> 이 화면은 `npm run screenshot` 으로 다시 만들 수 있습니다.

---

## 0. 이 방식의 핵심 — 도메인이 필요 없다

이 샘플이 REST API + 실제 웹훅 방식과 갈리는 지점은 딱 하나, **수신을 어떻게 받느냐**입니다.

```
[ 02 · API × 실제 웹훅 ]              [ 01 · CLI × 게이트웨이 (이 샘플) ]

TalkBridge ──POST──► 내 서버          TalkBridge ◄──SSE── 게이트웨이 데몬
           (밖에서 안으로 들어옴)                  (안에서 밖으로 나감)  │
                                                                      ▼
공인 도메인 · DNS · TLS 인증서            localhost:8787 로 넘겨줌
인바운드 방화벽 허용이 필요               → 준비할 인프라가 없음
```

게이트웨이 데몬이 **내 쪽에서 밖으로** 나가 TalkBridge 에 붙습니다(아웃바운드 SSE).
받은 이벤트는 데몬이 `http://127.0.0.1` 로 넘겨줍니다.
외부에서 내 쪽으로 들어오는 연결이 **아예 없으므로** 준비할 것이 사라집니다.

| | 01 CLI × 게이트웨이 | 02 API × 실제 웹훅 |
|---|---|---|
| 공인 도메인 | **불필요** | 필요 |
| DNS 레코드(A/CNAME) | **불필요** | 필요 |
| TLS 인증서 발급·갱신 | **불필요** | 필요 |
| 인바운드 방화벽·포트 개방 | **불필요** | 필요 |
| 리버스 프록시(nginx 등) | **불필요** | 보통 필요 |
| 로컬 개발용 터널(ngrok 등) | **불필요** | 필요 |
| 관리할 상시 프로세스 | 데몬 1개 | 없음 |
| 재시도 | 인메모리 1s→3s, 3회 | 영속 1s→5s→30s→2m→10m, 5회 |
| 프로세스 사망 시 | 재기동 후 저널 재생 | 서버가 보관·재전달 |

**이래서 유리합니다**

- 사내망·VPN 안에서만 도는 상담 시스템 — 외부 노출이 금지된 환경에서도 그대로 붙습니다
- 노트북에서 바로 검증 — `npm start` 하나로 끝, 터널을 띄울 필요가 없습니다
- 인프라 담당자를 거치지 않고 개발자 혼자 붙일 수 있습니다
- DNS 변경에 결재·리드타임이 걸리는 조직에서 착수가 막히지 않습니다

**대신 감수할 것**

- 데몬이 **살아 있어야** 수신됩니다
- 재시도가 경량입니다(인메모리 3회, 영속 재개 없음)
- 24/7 무중단 운영이라면 그 서버에서 데몬을 돌리거나, 02 방식(호스티드 게이트웨이)으로 옮기세요

> **나중에 갈아탈 수 있습니다.** 서명 스킴과 페이로드가 양쪽 동일해서,
> `server/signature.js`·`store.js`·`sse.js` 는 한 글자도 안 고치고, `server/webhook.js` 는
> 본문 조회 두 줄(import + 호출, CLI → REST)만 바꿔 [02](../02-api-webhook/) 에서 재사용됩니다.
> 바뀌는 것은 "게이트웨이를 내가 띄우느냐, 톡브릿지 센터가 띄우느냐" 뿐입니다.

---

## 1. 무엇을 보여주는 샘플인가

카카오 상담톡의 인바운드·아웃바운드를 **한 화면**에 잇습니다.

```
고객(카카오톡)
     │  문의
     ▼
TalkBridge 서버 ──SSE──► talkbridge-dev gateway (내 PC 데몬)
                                  │
                                  │ Webhook sink: 서명된 POST
                                  ▼
                         이 샘플 서버 /webhook
                                  │ ① 서명 검증(HMAC-SHA256)
                                  │ ② 즉시 200
                                  │ ③ 멱등(Delivery-Id)
                                  │ ④ 본문 조회 ── talkbridge-dev rooms --user
                                  ▼
                         브라우저 상담 화면 (SSE 푸시)
                                  │ 상담원이 답장 입력
                                  ▼
                         talkbridge-dev send ──► 고객
```

**핵심은 웹훅 페이로드에 메시지 본문이 없다는 점입니다.** 들어오는 것은 신호뿐이고,
본문은 CLI 로 2차 조회해야 합니다. 이 샘플은 그 보강 과정을 그대로 구현했습니다.

---

## 2. 빠른 시작

```bash
# 0) 사전: CLI 설치 + 로그인 (한 번만)
npm install -g @blumn-dev/talkbridge-cli   # 운영은 @blumn-ai/talkbridge-cli
talkbridge-dev login                        # 브라우저 페어링 → 5자리 코드
talkbridge-dev whoami                       # 브랜드 키 확인

# 1) 환경 설정
cp .env.example .env
#   TB_BRAND           ← whoami 에서 본 브랜드 키
#   TB_WEBHOOK_SECRET  ← 아무 긴 랜덤 문자열 (whsec_ 로 시작하는 걸 권장)

# 2) 진단 — 붙기 전에 빠진 걸 먼저 본다
npm run doctor

# 3) 게이트웨이 webhook sink 를 이 서버로 향하게 구성
npm run gateway:setup

# 4) 게이트웨이 기동
npm run gateway:start

# 5) 상담 화면 서버 기동
npm start
#   → http://127.0.0.1:8787/
```

> **첫 기동 시 저널 전체가 재생됩니다.**
> `~/.bridge-agent/stream-offsets.json` 이 없으면 게이트웨이가 seq 1 부터 다시 보냅니다.
> 과거 상담이 한꺼번에 들어와도 정상이며, 멱등 처리 덕에 중복 저장되지 않습니다.

---

## 3. 검증된 수신 스펙

실측(11건 캡처, 서명 11/11 일치)으로 확정한 계약입니다.

### 3.1 요청

```http
POST /webhook
content-type:         application/json; charset=utf-8
x-bridge-signature:   v0=b9f4e121fc8cae0ae6ea2667c1bd8a15f944f50d31c3f33301079b9bdb39b73f
x-bridge-event:       message
x-bridge-timestamp:   1788856230
x-bridge-delivery-id: d38f7b06-4524-4872-9c26-c251a91f4eb9

{"userKey":"Vjpe_s_fc16k","kind":"message","seq":1,"brand":"crm-b3e696"}
```

| 필드 | 설명 |
|---|---|
| `userKey` | 고객 상관키. **그대로 발신 `--to` 에 쓴다** |
| `kind` | `message` / `agent` / `reference` / `expired` / `ended` |
| `seq` | 브랜드 저널 단조증가 시퀀스 |
| `brand` | 브랜드 키 |

**본문(text)이 없습니다.** `kind` 가 `message`·`agent` 면 CLI 로 보강해야 합니다.

### 3.2 서명

```
서명대상 = "v0:" + X-Bridge-Timestamp + ":" + <원본 raw body 바이트>
서명값   = "v0=" + lowerhex( HMAC_SHA256( 시크릿문자열_UTF8, 서명대상 ) )
```

구현은 [`server/signature.js`](server/signature.js).

> ⚠️ **raw body 를 그대로 써야 합니다.** 게이트웨이가 보내는 키 순서는
> `userKey, kind, seq, brand` 로 일반적인 모델 순서와 다릅니다.
> `JSON.parse` → `JSON.stringify` 로 되돌리면 서명이 100% 깨집니다.
> 그래서 이 샘플은 `/webhook` 라우트에서만 raw Buffer 를 유지합니다.

### 3.3 이벤트별 처리

| kind | 본문 조회 | 이 샘플의 처리 |
|---|---|---|
| `message` | ✅ | 보강 → 저장 → 미읽음 +1 → 화면 푸시 |
| `agent` | ✅ | **내 발신의 echo.** 말풍선을 "발신 완료"로 확정 |
| `reference` | ✗ | 방을 `진행중` 으로, 시스템 말풍선 |
| `expired` | ✗ | 방을 `종료` 로 |
| `ended` | ✗ | 방을 `종료` 로 |

> 호스티드 게이트웨이(02)는 발신 1건에 `agent` 를 **두 번**(seq 없는 즉시 신호 + seq 있는 저널 항목) 보내는 것이
> 실측되었습니다. `webhook.js` 는 seq 없는 `agent` 를 저장하지 않고 넘기며, `store.js` 는 seq 있는 echo 가 오면
> 같은 본문의 낙관적(pending) 말풍선을 치웁니다 — 두 파일은 01·02 가 공유하므로 여기에도 같은 처리가 들어 있습니다.
>
> **`agent` echo 는 반드시 자동응답 로직에서 제외해야 합니다.**
> 이 샘플은 사람이 직접 답장하므로 echo 를 화면 표시에만 씁니다.
> AI 자동응답으로 바꾼다면 `webhook.js` 의 `case 'agent'` 에서 응답 생성을 타지 않게 하세요 —
> 안 그러면 내 발신이 내 발신을 부르는 무한 루프가 됩니다.

### 3.4 신뢰성 규칙

| 규칙 | 구현 위치 |
|---|---|
| 서명 실패는 **401** (재시도해도 계속 실패해야 정상) | `webhook.js` |
| 정상 처리는 **무조건 200** (4xx 도 재시도 대상) | `webhook.js` |
| **즉시 200 후 비동기 후처리** (게이트웨이 타임아웃 회피) | `webhook.js` |
| 멱등 1순위 `X-Bridge-Delivery-Id` | `store.js` |
| 멱등 2순위 `(brand, seq)` | `store.js` |
| 순서 뒤바뀜 대비 `seq` 재정렬 | `store.js` |

CLI 게이트웨이 재시도는 **1s → 3s, 최대 3회 · 인메모리**입니다(프로세스가 살아 있는 동안만).
영속 재시도가 필요하면 톡브릿지 센터의 호스티드 게이트웨이를 쓰세요.

---

## 4. 검증된 발신 스펙 (CLI)

| 동작 | 명령 | 래퍼 |
|---|---|---|
| 텍스트 발신 | `send --brand <키> --to <userKey> --text <메시지>` | `cliSend` |
| 첨부 발신 | `send --brand <키> --to <userKey> --file <경로> [--text ...]` | `cliSendFile` |
| 리치 발신 | `send --brand <키> --to <userKey> --rich-json <파일>` | — |
| 발신 취소 | `delete --brand <키> --to <userKey> --serial <번호>` (24h 내) | `cliDelete` |
| 종료+봇전환 | `end-with-bot --brand <키> --to <userKey> [--event <블럭>]` | `cliEndWithBot` |
| 차단/해제 | `block` / `unblock --brand <키> --to <userKey>` | `cliBlock` |

발신 실패는 CLI 원문을 그대로 올려 보냅니다. 실제 관측 예:

```json
{ "ok": false, "error": "오류: 전송 실패(-509): 메시지 형식이 올바르지 않아 전송되지 않았어요." }
```

> **활성 세션에만 발신됩니다.** 종료·만료된 상담에는 보낼 수 없고, 새 문의가 와야 재개됩니다.
> 그리고 발신은 **구독 상담 건수를 소진**합니다(조회·설정은 비과금).

### 공개 문서와 다른 점 (dev CLI v1.0.0 실측)

| 항목 | 실측 |
|---|---|
| `send --file` | 존재함. CLI 가 업로드+발신을 한 번에 처리 (공개 문서 미기재) |
| `upload` | URL·키만 반환 — **rich 조립용**. 고객에게 바로 보내려면 `send --file` |
| 순수 `end` | **CLI 에 없음.** `end-with-bot` 만 존재 |
| 설정 변경 | `webhook-domain set` · `chat` · `schedule set` 은 **Admin** 스코프 필요 (BrandWrite 로는 불가) |
| `--json` 출력 | v1.0.0 **없음** → 텍스트 파싱. **v1.1.0 부터 전역 `--json`** (필드명 = REST). 이 샘플은 v1.0.0 호환을 위해 텍스트 파서를 유지하고, 03 샘플이 `--json` 을 쓴다 |

---

## 5. 구조

```
sample-project/
├─ server/
│  ├─ index.js        HTTP 라우팅 + 정적 서빙 + 부팅 백필
│  ├─ config.js       .env 로더(의존성 0)
│  ├─ cli.js          ★ CLI 래퍼 + 출력 파서
│  ├─ signature.js    ★ HMAC 서명 검증
│  ├─ webhook.js      ★ 수신 핸들러(검증→200→멱등→보강→푸시)
│  ├─ store.js        인메모리 저장소 + 멱등 집합
│  └─ sse.js          브라우저 실시간 푸시
├─ public/
│  ├─ index.html      3분할 상담 화면
│  ├─ app.js          바닐라 JS
│  └─ style.css
├─ scripts/
│  ├─ doctor.mjs      진단 7종
│  ├─ gateway.mjs     sink 구성 + 데몬 수명주기
│  └─ screenshot.mjs  소개용 스크린샷 생성(Playwright, 선택)
├─ docs/
│  └─ screenshot.png
└─ .env.example
```

`screenshot.mjs` 만 Playwright 를 씁니다 — **샘플을 실행하는 데는 필요 없습니다.**

### 서버 API

| 메서드 | 경로 | CLI 대응 |
|---|---|---|
| POST | `/webhook` | (게이트웨이 수신) |
| GET | `/api/events` | SSE 실시간 채널 |
| GET | `/api/me` | `whoami` |
| GET | `/api/rooms` | `rooms --brand` |
| GET | `/api/rooms/:userKey/messages` | `rooms --brand --user` |
| GET | `/api/history` | `history --brand` (convId 포함) |
| POST | `/api/send` | `send --text` |
| POST | `/api/end` | `end-with-bot` |
| POST | `/api/block` · `/api/unblock` | `block` / `unblock` |
| POST | `/api/delete` | `delete` |

---

## 6. 구현 노트 — 따라 할 때 걸리는 지점

### 6.1 Windows 에서 CLI 를 spawn 하는 법

`talkbridge-dev` 는 npm 이 만든 `.cmd` 셈입니다. 그런데

- `shell: false` → Node 18.20+/20.12+ 는 보안 패치(CVE-2024-27980)로 `.cmd` 실행을 **거부**합니다.
- `shell: true` → 상담 메시지의 `" & % ^` 가 cmd 파서에 먹혀 **깨지거나 인젝션**이 됩니다.

그래서 이 샘플은 셈을 타지 않고 **런처 JS 를 `process.execPath`(node)로 직접 실행**합니다.
인자가 배열로 그대로 전달되므로 어떤 문자가 와도 안전합니다. → `server/cli.js` 의 `resolveLauncher()`

```
node <npm root -g>/@blumn-dev/talkbridge-cli/bin/talkbridge-dev.js  whoami
```

### 6.2 CLI 출력 파싱

v1.0.0 에는 `--json` 이 없어 텍스트를 파싱합니다. 실측 형식(v1.1.0 은 연도가 붙습니다 — 파서는 둘 다 받습니다):

```
  · Vjpe_s_fc16k     [진행중]   4건  최신#11  09-08 10:28  "[첨부]"              ← v1.0.0
  · Vjpe_s_fc16k     [진행중]  10건  최신#17  2026-09-09 10:30  "…"            ← v1.1.0
  #10   [message] 09-08 10:23  톡브릿지 가격이 어떻게되나요?
```

v1.1.0+ 라면 파서 대신 `--json` 을 쓰는 편이 낫습니다 — [03 샘플의 `server/cli.js`](../03-cli-knowledge-graph/server/cli.js) 가 그 형태입니다.

파서는 `server/cli.js` 한 곳에 모여 있습니다. CLI 표기가 바뀌면 여기만 고치면 됩니다.
`doctor` 의 `[6]` 항목이 "출력은 있는데 파싱 0개"를 잡아 줍니다.

> v1.0.0 타임스탬프에는 **연도가 없습니다**(`09-08 10:28`). 파서는 현재 연도로 올리고,
> 6시간 이상 미래면 작년으로 보정합니다. v1.1.0 은 연도를 주므로 보정이 필요 없습니다. 정확한 시각이 필요하면 웹훅 도착 시각이나 `--json` 의 `timestampUnixMs` 를 쓰세요.

### 6.3 이미지 첨부

고객이 보낸 이미지는 별도 필드가 아니라 **본문 `text` 안에 URL** 로 들어옵니다.
`public/app.js` 의 `renderText()` 가 URL 을 뽑아 링크 + 썸네일로 렌더합니다.

### 6.4 로컬 개발과 터널

CLI 게이트웨이는 내 PC 에서 도는 데몬이라 `http://127.0.0.1` 로 릴레이됩니다.
**터널이 필요 없습니다** — 이 방식의 가장 큰 실무적 이점입니다(§0).

반면 **호스티드 게이트웨이**(톡브릿지 센터)는 HTTPS 공인 도메인으로만 전달합니다.
사설 IP 는 SSRF 방어로 차단되므로, 그쪽으로 옮길 때는 공개 서버나
터널(Tailscale Funnel·ngrok)이 필요합니다. 등록 주소는 `TB_WEBHOOK_URL` 로 바꿉니다.
이 경로 전체를 다루는 것이 다음 샘플 `02-api-webhook` 입니다.

---

## 7. 운영으로 옮길 때

| 지금(샘플) | 운영에서 |
|---|---|
| 인메모리 저장소 | DB — 멱등 테이블(`delivery_id` UNIQUE) + 메시지 테이블 |
| CLI 텍스트 파싱 | REST 직접 호출(`https://api.talkbridge.io`)로 교체하면 파싱 불필요 → `02-api-webhook` |
| CLI 게이트웨이(인메모리 재시도 3회) | 호스티드 게이트웨이(영속 재시도 5회 + 재기동 재개) → `02-api-webhook` |
| 인증 없는 상담 화면 | 상담원 로그인·권한 |
| 사람이 답장 | `webhook.js` 의 보강 직후에 LLM 호출을 끼우면 AI 상담봇 (단, `agent` echo 필터 필수) |

---

## 8. 문제 해결

| 증상 | 원인·조치 |
|---|---|
| 웹훅이 전부 401 | CLI 의 `--webhook-secret` 과 `.env` 의 `TB_WEBHOOK_SECRET` 불일치 → `npm run doctor` `[4]` 확인 |
| 이벤트가 안 옴 | `npm run gateway:status` 로 데몬 확인, `~/.bridge-agent/gateway.log` 확인 |
| 첫 기동에 과거 메시지 폭주 | 정상. `stream-offsets.json` 이 없어 저널 재생 중 |
| 상담방 0개로 파싱됨 | CLI 출력 형식 변경 → `server/cli.js` 파서 수정 |
| 발신이 `-509` 등으로 실패 | 세션이 종료·만료됐거나 `userKey` 가 잘못됨. 새 문의가 와야 재개 |
| 설정 변경이 거부됨 | `schedule set` · `chat` · `webhook-domain set` 은 **Admin** 스코프 필요 |
| `curl` 로 보낸 한글이 깨져 발송됨 | Windows 에서 한글을 명령행 인자로 넘기면 코드페이지 949 로 재해석됨. `--data-binary @-` 히어독·파일 또는 Node `fetch` 로. (CLI 를 직접 부를 때도 같은 이유로 `server/cli.js` 는 인자를 배열로 넘긴다) |

---

## 9. 참고

- 샘플 모음 인덱스: [`../README.md`](../README.md)
- 공개 매뉴얼: <https://api.talkbridge.io/>
- 매뉴얼 요약: [`../../docs/talkbridge-manual-digest.md`](../../docs/talkbridge-manual-digest.md)
- 기술 문의: TalkBridge 디스코드 커뮤니티 / `help@talkbridge.io`
