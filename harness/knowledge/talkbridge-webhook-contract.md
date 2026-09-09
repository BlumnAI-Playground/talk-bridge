# TalkBridge 수신 웹훅 계약

> 원문: [`docs/talkbridge-manual-digest.md`](../../docs/talkbridge-manual-digest.md) §9,
> 실측: [`sample-project/01-cli-gateway/README.md`](../../sample-project/01-cli-gateway/README.md) §3
> 이 문서는 검수 기준으로 쓰기 위해 **계약 조항만** 추린 것이다. 상세는 원문을 참조한다.

## 1. 페이로드 — "본문 없는 신호"

```
POST <webhook url>
x-bridge-signature:   v0=<lowerhex>
x-bridge-event:       <kind>
x-bridge-timestamp:   <unix seconds>
x-bridge-delivery-id: <uuid>
content-type:         application/json; charset=utf-8

{"userKey":"...","kind":"message","seq":42,"brand":"..."}
```

- 게이트웨이가 보내는 **키 순서는 `userKey, kind, seq, brand`** — 일반 모델 순서와 다르다.
- `text` 는 **없다**. `kind` 가 `message` / `agent` 면 `rooms --user` 또는
  `GET /api/agent/rooms/{userKey}/messages` 로 본문을 2차 조회한다.
- 이미지 첨부는 별도 필드가 아니라 본문 `text` 안에 URL 로 들어온다.

| kind | 본문 조회 | 의미 |
|---|---|---|
| `message` | 필요 | 고객 메시지 |
| `agent` | 필요 | **내 발신의 echo** — 자동응답 로직에서 반드시 제외 (무한 루프). 호스티드는 seq 없는 즉시 신호가 먼저 한 번 더 온다 (§3.1) |
| `reference` | 불필요 | 새 상담 연결(세션 시작) |
| `expired` | 불필요 | 세션 만료 |
| `ended` | 불필요 | 상담 종료 |

## 2. 서명 (HMAC-SHA256, 양쪽 게이트웨이 동일)

```
서명대상 = "v0:" + X-Bridge-Timestamp + ":" + <원본 raw body 바이트>
서명값   = "v0=" + lowerhex( HMAC_SHA256( 시크릿 문자열 전체(UTF-8), 서명대상 ) )
```

**검수 시 반드시 확인하는 5가지**

1. **raw body 바이트 그대로** 사용 — `JSON.parse` → `JSON.stringify` 재직렬화는 100% 실패
2. **상수시간 비교** (`crypto.timingSafeEqual`) — 길이가 다르면 throw 하므로 먼저 걸러야 한다
3. **타임스탬프 편차 검사** — 편차가 크면 리플레이로 간주해 거부 (샘플 기본 300초, `0` 이면 미검사)
4. 시크릿은 **환경변수/설정에서만** — 코드·문서·로그·에러 메시지에 노출 금지
5. API 키(`blumnb-`)와 서명 시크릿(`whsec_`)은 **별개** — 혼용 금지

호스티드 게이트웨이의 `whsec_` 는 Agent 키에서 결정적으로 파생되어 키 재발급 시 함께 바뀐다.
CLI 게이트웨이는 `setup --webhook-secret` 으로 직접 지정하며 `.env` 의 `TB_WEBHOOK_SECRET` 과 같아야 한다.

## 3. 전달 신뢰성 규칙

| 규칙 | 근거 |
|---|---|
| 서명 실패는 **401** | 재시도해도 계속 401 이 나는 것이 정상 |
| 정상 처리는 **무조건 2xx** | **4xx 도 재시도 대상**이다 |
| **즉시 2xx 후 비동기 후처리** | 게이트웨이 타임아웃 회피 — CLI 조회를 응답 뒤로 미룬다 |
| 멱등 1순위 `X-Bridge-Delivery-Id` | at-least-once 라 중복이 온다 |
| 멱등 2순위 `(brand, seq)` | 저널 리셋 시 seq 재사용 가능 → 장기 저장은 Delivery-Id 기준 |
| `seq` 로 재정렬 | 재시도가 끼면 순서가 뒤바뀔 수 있다 |

| | 호스티드(02) | CLI 게이트웨이(01) |
|---|---|---|
| 재시도 | 1s→5s→30s→2m→10m, 5회 | 1s→3s, 3회 |
| 영속 | 원장 영속, 재기동 후 재개 | 인메모리, 프로세스 생존 중만 |
| 도달 조건 | HTTPS 공인 도메인만 (사설 IP·SSRF 차단) | `127.0.0.1` 로컬 sink |

### 3.1 호스티드 게이트웨이 실측 (2026-09-09, 02-api-webhook)

- 센터 "상담 받을 곳 연결 → Webhook" 에 Funnel URL 등록 → 카카오톡 문의 2건 → `POST /webhook` 2건이 인터넷 경로로 도달
- **01 의 `signature.js` 를 무수정으로** 서명 통과 → CLI 게이트웨이와 호스티드 게이트웨이의 서명 스킴 동일성 확인
- `X-Bridge-Delivery-Id` 멱등 2건, 중복 전달 없음. 페이로드 `{userKey, kind, seq, brand}` 본문 없음 — 01 과 동일
- **`agent` echo 는 발신 1건에 두 번 온다**: ① 즉시 `{userKey, kind:"agent", brand}` (**seq 없음**), ② ~1초 뒤 `{…, seq:N}` 저널 항목.
  ①을 메시지로 저장하면 말풍선이 중복된다 → 핸들러는 seq 없는 `agent` 를 저장하지 않고 신호로만 취급해야 한다.
  검수 시 `seq == null` 인 agent 처리와 pending 말풍선 정리(`store.upsertMessage`)가 01·02 양쪽에 있는지 확인
  → 문서화·식별 필드 개선 예고: [cli-feat/CF-008](cli-feat/v1.0.0/CF-008-hosted-gateway-agent-echo.md)
- REST 봉투: `me` → `{name, scope, brands}` (봉투 없음), `rooms` → `{ok, brand, rooms[]}`, `messages` → `{ok, brand, userKey, messages[]}` **최신순**. 필드는 요약 §7 과 정확히 일치
- `whsec_` 는 센터 Webhook 연결 화면에서 확인. Agent 키(`blumnb-`)와 별개이며 둘 다 **발급 환경(dev/prod)에 묶인다**

## 4. 수신 서버 5단계 (문서 §9.4)

서명 검증 → `kind` 분기 → 본문 조회 → 2xx 반환 → 발신 API 로 답장

> 샘플은 "2xx 반환" 을 "본문 조회" 앞으로 당겼다. 이는 §3 의 타임아웃 규칙에 부합하는 의도적 편차다.

## 5. 도메인 모델 (상관키)

- `brandKey`(=수신 `brand`) — 모든 호출의 스코프
- `userKey` — 수신에서 받은 값을 **그대로** 발신 `--to`/`userKey` 에 쓴다. 세션 ID 를 따로 다루지 않는다
- `seq` — 브랜드 저널 단조증가 시퀀스
- **활성 세션 제약** — 진행 중 세션에만 발신 가능. 선발신 불가 → 항상 인바운드가 먼저
