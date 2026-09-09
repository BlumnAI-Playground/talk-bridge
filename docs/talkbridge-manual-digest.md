# TalkBridge 공개 매뉴얼 요약 (출처: https://api.talkbridge.io/, 2026-09-08 기준)

> 파트너용 CLI × API 연동 샘플 제작을 위한 1차 파악 문서.
> 원문은 Docusaurus(ko/en), 총 31페이지. 아래는 연동 구현에 필요한 사실만 추린 것.

## 1. 제품 한 줄 정의

카카오톡 **상담톡** 채널과 파트너의 시스템(자체 서버 / AI Agent / Discord / Slack)을
잇는 브릿지. 카카오 상담톡 파트너 계약·발송 규격·재시도 같은 채널 복잡도를 TalkBridge가
흡수하고, 파트너는 **인바운드 수신(웹훅) + 아웃바운드 발신(REST)** 두 계약만 다룬다.

## 2. 연결 방식 3종 (택일, 동일 브랜드 키·동일 대화 흐름 공유)

| 방식 | 대상 | 진입점 |
|---|---|---|
| **MCP** | 비개발자 / 빠른 검증 | 커넥터 주소 `https://mcp.talkbridge.io/mcp` 붙여넣기 → 구글 로그인 |
| **CLI** | 개발자(자동화·스크립트) | `npm i -g @blumn-ai/talkbridge-cli` |
| **API** | 개발자(프로덕션 직접 통합) | REST 발신 + 서명 웹훅 수신 |

## 3. 핵심 도메인 모델

- **brandKey** — 브랜드(=카카오 채널) 키. 모든 호출의 스코프 단위.
- **userKey** — 상담 고객 키. **수신 웹훅으로 받은 값을 그대로 발신에 사용**하는 상관키.
  세션 ID를 따로 다룰 필요 없음 — userKey 하나로 대화가 이어진다.
- **seq** — 브랜드 저널의 단조증가 시퀀스. 순서 재정렬·논리 멱등 기준.
- **활성 세션 제약** — 카카오 상담톡은 **진행 중인 활성 세션에만 발신 가능**.
  세션이 없거나 만료면 발신 실패. (선발신 불가 → 항상 인바운드가 먼저)

## 4. 인증

- Base URL(운영): `https://api.talkbridge.io`
- 헤더: `Authorization: Bearer blumnb-xxxx-...`
- 키는 `blumnb-` 프리픽스, **특정 brandKey에 묶임**. 톡브릿지 센터에서 발급.
- 스코프
  - `BrandRead` — 조회: `me`, `rooms`, `rooms/{userKey}/messages`, `profile`, `sysmsg`, `channel/*`(GET)
  - `BrandWrite` — 위 + 발신·설정 변경: `send`, `send/rich`, `end`, `block`, `upload/*`, `channel/*`(POST)
  - CLI 문서에는 `Admin` 스코프도 언급됨
- 검증: `GET /api/agent/me` → `{ "name": "...", "scope": "BrandWrite", "brands": ["mybrand"] }`
- **API Key(`blumnb-`)와 웹훅 서명 시크릿(`whsec_`)은 별개.**

## 5. 발신 API (BrandWrite)

| 엔드포인트 | 바디 |
|---|---|
| `POST /api/agent/send` | `brandKey`, `userKey`, `text` |
| `POST /api/agent/send/rich` | `brandKey`, `userKey`, `rich` (카카오 리치 JSON을 **문자열로 직렬화**) |
| `POST /api/agent/end` | `brandKey`, `userKey`, `greeting?` |
| `POST /api/agent/end-with-bot` | `brandKey`, `userKey`, `botEvent?` |
| `POST /api/agent/block` / `unblock` | `brandKey`, `userKey` |
| `POST /api/agent/upload/image` | multipart: `brand`, `file`, `imageType?` |
| `POST /api/agent/upload/file` | multipart: `brand`, `file`, `fileType`(file\|audio\|video) |

업로드 응답에 `url`/`name`/`size` → 리치 메시지 이미지 필드에 연결해 발신.

⚠️ **self-echo**: 발신 성공 시 내 웹훅으로 `kind: "agent"` 이벤트가 되돌아온다.
무한 루프 방지를 위해 반드시 필터링.

## 6. 설정 API

| 엔드포인트 | 비고 |
|---|---|
| `GET/POST /api/agent/channel/schedule` | `weekTimetable[]` = `{day, startAt, endAt}`. 비면 400 EMPTY. 하루 1구간만. |
| `POST /api/agent/channel/chat` | `brandKey`, `active`(bool) — 채팅기능 토글 |
| `GET/POST /api/agent/channel/domain` | 수신도메인. ⚠️ bypass 게이트웨이 구성에선 임의 변경 금지 |
| `GET /api/agent/profile?brand=` | 발신프로필 |
| `GET /api/agent/sysmsg?brand=` | 시스템메시지 |

상담시간은 카카오가 시간대 정보를 안 받아 **KST 벽시계 고정** → 저장 시 KST 변환.
비워 두고 활성화하면 24시간 무휴.

## 7. 수신 내용 조회 (BrandRead)

```
GET /api/agent/rooms?brand=mybrand&max=50
GET /api/agent/rooms/{userKey}/messages?brand=mybrand&max=20   # max 1~300, 기본 100, 최신순
```

- `messages[]`: `seq`, `userKey`, `sessionId`, `kind`, `text`, `timestampUnixMs`
- `rooms[]`: `userKey`, `lastSeq`, `lastText`, `lastKind`, `lastTimestampUnixMs`, `count`, `ended`

이미지 첨부는 별도 필드가 아니라 **본문 `text` 안에 URL이 들어온다** (URL 유무로 판별).

## 8. 응답 봉투 & 에러 코드

```json
{ "ok": true, "code": "0", "message": null }
```
추가 필드: `data`(설정·조회 시 카카오 원본), `url`/`name`/`size`(업로드).

| HTTP | code | 의미 |
|---|---|---|
| 401 | — | 토큰 없음/무효 |
| 403 | `FORBIDDEN` | 권한 부족(BrandWrite 필요) |
| 403 | `NO_BRAND_SCOPE` | 이 브랜드에 인가되지 않은 키 |
| 404 | `NO_BRAND` | 존재하지 않는 브랜드 |
| 400 | `EMPTY` | 필수 필드 누락 |
| 400 | `BAD_RICH` | 리치 JSON 파싱 실패 |
| 400 | `NOT_MULTIPART` / `NO_FILE` | 업로드 문제 |
| 503 | `NO_PERSISTENCE` | 수신 영속 비활성(조회 폴백) → 재시도 |

발신이 카카오까지 갔다 실패하면 `code`에 카카오/브릿지 정규화 코드가 담김(세션 만료·중복 등).
원칙: 인증계 오류(`FORBIDDEN`/`NO_BRAND_SCOPE`)는 재시도 무의미.
세션 만료계 실패는 새 수신 이벤트로 세션이 재개된 뒤 재시도.

## 9. 수신 웹훅

### 9.1 페이로드 = "본문 없는 신호"

```
POST <내 웹훅 URL>
Content-Type: application/json
X-Bridge-Signature:   v0=<hex>
X-Bridge-Event:       <kind>
X-Bridge-Timestamp:   <unix seconds>
X-Bridge-Delivery-Id: <uuid>

{ "brand": "mybrand", "userKey": "user_ab12cd34", "kind": "message", "seq": 42 }
```

**메시지 텍스트가 없다.** 본문은 `rooms/{userKey}/messages`로 별도 조회.

| kind | 조회 필요? | 처리 |
|---|---|---|
| `message` | ✅ | 본문 조회 → 응대 |
| `reference` | ✗ | 새 상담 연결(세션 시작) |
| `expired` | ✗ | 세션 만료 |
| `ended` | ✗ | 상담 종료 |
| `agent` | ✗ | **내 발신 echo → 무시** |

상관 관계: 수신 `userKey` = 발신 `userKey`, 수신 `brand` = 발신 `brandKey`.

### 9.2 서명 (HMAC-SHA256)

```
서명대상 = "v0:" + X-Bridge-Timestamp + ":" + <원본 raw body>
서명값   = "v0=" + lowerhex(HMAC_SHA256(whsec_전체문자열_UTF8, 서명대상))
```

- **raw body 바이트 그대로** 사용 (파싱 후 재직렬화하면 공백·키 순서가 달라져 실패)
- 상수시간 비교 필수, ts 편차가 크면 리플레이로 간주해 거부 권장
- 호스티드 게이트웨이의 `whsec_`는 **연결한 Agent 키에서 결정적으로 파생** (show-once 아님,
  센터에서 재확인 가능). Agent 키를 재발급/재연결하면 whsec도 바뀜 → 수신 서버 값 갱신 필요
- CLI 게이트웨이는 `--webhook-secret`으로 직접 지정 (동일 서명 스킴)

문서에 Node.js(Express raw parser) / C#(ASP.NET minimal API) 참조 구현이 실려 있음.

### 9.3 전달 신뢰성

| | 호스티드 게이트웨이 | CLI 게이트웨이 |
|---|---|---|
| 재시도 | 1s→5s→30s→2m→10m, 총 5회 | 1s→3s, 최대 3회 |
| 영속 | ✅ 원장 영속, 재기동 후 재개 | ❌ 인메모리, 프로세스 살아있는 동안만 |
| 실패 시 | Failed 표시 + 상태 Degraded 보고 | — |

- **4xx도 재시도 대상.** 정상 처리했으면 반드시 2xx.
- at-least-once → 멱등 필수. 1순위 키 `X-Bridge-Delivery-Id`, 논리 유일성 `(brand, seq)`.
  (저널 리셋 시 seq 재사용 가능 → 장기 저장은 Delivery-Id 기준이 안전)
- 순서 보존을 시도하나 재시도가 끼면 뒤바뀔 수 있음 → `seq`로 재정렬.
- 게이트웨이 타임아웃 회피: **즉시 2xx 후 비동기 후처리**.
- HTTPS 공인 도메인만 전달 (사설 IP·SSRF 차단) → 로컬 개발은 터널(Tailscale Funnel, ngrok) 필요.

### 9.4 수신 서버가 해야 할 5단계

1. 서명 검증 → 2. `kind` 분기 → 3. 본문 조회 → 4. 2xx 반환 → 5. 발신 API로 답장

## 10. CLI

- 설치: `npm install -g @blumn-ai/talkbridge-cli` (Node 18+, 플랫폼 바이너리는 npm optionalDependency)
- 지원 RID: `win-x64` / `osx-arm64` / `osx-x64` / `linux-x64` / `linux-arm64` (전부 v1)
- 설정 저장: `~/.talkbridge/config.json` (사용자 전용 권한)
- 기본 브릿지 엔드포인트: `https://webhook.talkbridge.io` (`--endpoint`로 변경)

### 등록 두 가지

- `talkbridge login` — 브라우저 OAuth 페어링(권장). 센터 `/Partner/CliLogin` → 브랜드 선택 →
  5자리·5분 유효 코드 입력 → BrandWrite 키 자동 발급·저장. 옵션 `--console`, `--endpoint`
- `talkbridge setup [<키>]` — 인자 없으면 TUI 마법사(Terminal.Gui), 인자 주면 비대화형 즉시 저장

TUI 구성: Channel(Inbound Kakao + Health check / Outbound Discord·Slack·Webhook) ·
CS Features(Customer Memo: SQLite/MySQL/CSV) · AI(프로바이더·베이스URL·키 → `GET /v1/models`로 모델 선택) ·
Knowledge(Ontology). 기존 설정이 있으면 재설정할 섹션만 체크, 미선택은 기존값 유지.
TUI 키 이벤트 문제 시 `BRIDGE_TUI_DIAG=1`.

### 명령 목록

| 명령 | 동작 | 주요 옵션 |
|---|---|---|
| `setup [<키>]` | 키 검증·저장 / TUI | `--endpoint`, sink·CRM·AI 플래그 |
| `login` | OAuth 페어링 | `--console`, `--endpoint` |
| `whoami` | 이름·스코프·엔드포인트·허용 브랜드 | — |
| `env` | 실행파일 채널·바라보는 서버·설정 경로 (인증 불필요) | — |
| `history` | 상담 이력(진행중/완료, convId) | `--brand` |
| `rooms` | 상담방 리스트 / 특정 방 메시지 | `--brand`(필수), `--user`, `--max N` |
| `send` | 텍스트/리치 발송 | `--brand`, `--to`, `--text`, `--rich-json <파일>` |
| `delete` | 발신 취소 (**발송 후 24h 내**) | `--brand`, `--to`, `--serial` 또는 `--text` [`--within 초(10~86400)`] |
| `profile` | 발신프로필 조회 | `--brand`(필수) |
| `webhook-domain` | 수신도메인 get/set | `--brand`, `--url` |
| `chat` | 채팅기능 activate/deactivate | `--brand` |
| `schedule` | 상담시간 get/set | `--brand`, `--json <파일>` |
| `block` / `unblock` | 차단 / 해제 | `--brand`, `--to` |
| `end-with-bot` | 종료 + 봇 핸드오프 | `--brand`, `--to`, `--event` |
| `sysmsg` | 시스템메시지 조회 | `--brand`(필수) |
| `upload` | image/file/audio/video 업로드 | `--brand`, `--file` |
| `gateway` | 아웃바운드 게이트웨이 데몬 | start/stop/restart/status |
| `knowledge` | 상담지식 온톨로지(그래프 RAG) | status/install/build/search/view |
| `model` | AI 모델 조회·선택 | list / set `<id>` |
| `chatbot` | AI 상담 보조 대화형 TUI | (setup·model 선행) |

`--to`(=`--user`)가 대상 고객 키. 삭제는 개인정보 동의·카톡 인증 말풍선 불가,
삭제해도 상담 건수는 복구되지 않으며 고객 방에는 "메시지가 삭제되었습니다"가 표시됨.

### setup 비대화형 플래그 그룹

- 기본: `--key`, `--endpoint`
- Webhook sink: `--webhook-url`, `--webhook-secret`, `--webhook-brand`, `--webhook-console`
- Discord sink: `--discord-token`, `--guild`, `--channel`, `--discord-brand`
- Slack sink: `--slack-bot`(xoxb), `--slack-app`(xapp), `--slack-channel`, `--slack-brand`
- CRM: `--crm sqlite|mysql|csv`, `--sqlite-path`, `--mysql-conn`, `--csv-path`
- AI: `--ai-base`, `--ai-key`, `--ai-model`, `--ai-provider`, `--ai-api chat|responses`

### gateway (로컬 데몬)

`start` / `status` / `restart` / `stop`. sink가 최소 1개 구성돼 있어야 기동. 백그라운드 detach.

| 파일 | 위치 |
|---|---|
| PID | `~/.bridge-agent/gateway.pid` |
| 로그 | `~/.bridge-agent/gateway.log` |
| 스레드 매핑 | `~/.bridge-agent/thread-map.json`, `slack-thread-map.json` |
| 리플레이 오프셋 | `~/.bridge-agent/stream-offsets.json` |

Sink 3종 (동시 팬아웃, 하나 실패해도 나머지 지속):

- **Webhook** — SSE로 받은 인바운드를 지정 URL로 POST 릴레이. 셀프구축 수신용. `console-log`로 payload 확인
- **Discord** — 상담 1건 = 채널 스레드 1개 양방향 릴레이
- **Slack** — Socket Mode (공개 URL 불필요), xoxb(발신) + xapp(수신)

⚠️ Discord/Slack 상담 싱크는 **BrandWrite 키 + 단일 브랜드** 필요. 미충족 시 상담 싱크는
비활성화되고 Webhook 릴레이만 계속됨.

### 과금 유의

발신형 명령(`send`, 리치 발송 등)은 구독 플랜 상담 건수를 소진. 조회·설정 명령은 비과금.

## 11. 상담원 지원 (Discord/Slack 싱크 운영 시)

- 스레드에 올린 이미지·파일은 그대로 고객에게 전달(카카오 규격 자동 변환). 텍스트 동봉 시 캡션.
- 매크로: `cs-close`(종료, 뒤에 인사말 붙이면 종료 직전 선발송) / `cs-memo`(이름·전화·메모) /
  `cs-who`(상담원만 보임)
- 반드시 **고객 상담 스레드 안**에서 실행(스레드로 고객을 식별). 매크로 입출력은 고객에게 미전달.
- Discord = 슬래시 커맨드 `/cs-*` (자동완성 노출).
  Slack = `/` 없는 **예약 키워드** — Slack 슬래시 커맨드는 실행된 스레드를 알려주지 않아 고객 특정 불가.
- `cs-memo` 저장 시 스레드 제목이 `이름(고객키)`로 바뀜.

## 12. 온보딩 5단계 (톡브릿지 센터)

1. 브랜드 만들기 → 2. 카카오 채널 등록 → 3. 채널 인증(관리자 휴대폰 인증번호)
→ 4. 상담 받을 곳 연결(Discord/Slack/Webhook) → 5. 상담 활성화

선행 조건(카카오 측 — TalkBridge가 대신 처리 불가):
카카오톡 채널 보유 → **비즈니스 채널 전환(심사 1~3영업일, 길게 3~5일)** →
채널 공개 ON + 검색 허용 ON → 채널 이름·검색용 아이디(@xxx)·채널 URL 확보

- 「상담 활성화」 토글 = 카카오 상담 수신 시작 + 연결한 곳으로 전달, 두 가지를 함께 켬.
- 연동 완료 브랜드가 하나도 없으면 사용량·결제 화면이 잠김.
- 채널 소유권: **마지막으로 채널 인증에 성공한 설정이 소유.** 재인증 시 이관되고 이전 설정은
  「인증 무효화됨」(삭제는 안 됨). 이관은 채널당 24시간 3회 제한, 반영까지 최대 ~1분.
  이전 담당자 계정 접근 없이도 새 담당자가 재인증으로 회수 가능.

## 13. 요금 (샘플/데모 설계 제약)

| 요금제 | 월(공급가) | VAT포함 | 건수 | 건당 |
|---|---|---|---|---|
| Free | ₩0 | ₩0 | **30일간 총 3건** | — |
| Pro 100 | ₩15,000 | ₩16,500 | 100 | 150원 |
| Pro 300 | ₩45,000 | ₩49,500 | 300 | 150원 |
| Pro 500 | ₩75,000 | ₩82,500 | 500 | 150원 |
| Pro 1000 | ₩140,000 | ₩154,000 | 1,000 | 140원 |
| Enterprise | 견적 | — | 1,000 초과 | — |

- **과금 단위 = 하루에 응대한 고객 1명 = 1건 (KST 자정 경계).** 메시지 수·상담원 수 무관.
- 후청구 없음. 소진되면 신규 상담 중지. 자동 상향 없음. 잔여 건수 이월 없음(상향 시에만 합산).
- 청약철회: 첫 유료 결제 7일 이내 + 해당 결제 건수 미사용일 때만. 상향 결제는 환불 대상 아님.
- 이메일 알림 5종: 가입 환영 / 구독 시작 / 80% 경고(주기당 1회) / 소진 / 탈퇴 완료.
- ⚠️ **Free 체험이 30일 3건뿐** → 파트너 샘플은 라이브 발신을 최소화하는 설계가 필요.

## 14. 문의 창구

- 도입/견적(Enterprise, 테스트 채널 연결 지원, 맞춤 구축) → 도입 문의 폼
- 계정·결제·환불 → `help@talkbridge.io` (메일 제목 앞에 `[TalkBridge]`)
- 연동·API·CLI·웹훅 기술 문의 → 디스코드 커뮤니티
- 카카오 채널 개설·비즈니스 심사 → 카카오 고객센터 (cs.kakao.com)

## 15. 샘플 제작 관점 — 확인/결정 필요 항목

1. **userKey 표기 형식** — API 문서 예시는 `user_ab12cd34`, CLI 문서 예시는 `kakao:Uabc123`.
   실측으로 통일 필요(샘플 코드의 상관키 처리에 직결).
2. **`rich` 봉투 스키마** — `chat_bubble_type`이 필수라는 언급만 있고 전체 스키마는 문서에 없음.
   "발신 식별 필드는 서버가 채운다"까지만 확인됨. 카카오 상담톡 리치 규격 원문 참조 or 실측 필요.
3. **참조 구현 `project/webconsult-test`** — 문서가 "저장소에 있다"고 3회 언급(서명 고정벡터
   테스트 `project/webconsult-test.tests` 포함)하지만 공개 위치 미상. 확보하면 샘플 골격을 크게 단축.
4. **엔드포인트 2개** — REST `api.talkbridge.io` vs CLI 기본 `webhook.talkbridge.io`.
   CLI가 발신도 후자를 경유하는지 확인 필요.
5. **`history` / `convId`** — CLI에만 있고 REST 문서에 대응 엔드포인트가 없음.
6. **schedule `day` 값 도메인** — 예시는 `MON`/`TUE`. 전체 열거값·주말 처리 확인 필요.
7. **`GET /api/agent/me` 경로 표기** — 문서 본문은 `/api/agent/me`, 스코프 표에는 `me`로만 표기.
