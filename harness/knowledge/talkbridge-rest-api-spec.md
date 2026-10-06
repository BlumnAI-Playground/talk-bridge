# TalkBridge REST API 스펙 (샘플이 의존하는 범위)

> 원문: [`docs/talkbridge-manual-digest.md`](../../docs/talkbridge-manual-digest.md) §4·§5·§7·§8
> 실측: [`sample-project/02-api-webhook/README.md`](../../sample-project/02-api-webhook/README.md) §3·§4 (2026-09-09, 개발환경)
> 구현: [`sample-project/02-api-webhook/server/api.js`](../../sample-project/02-api-webhook/server/api.js)
> CLI 쪽 대응 문서: [`talkbridge-cli-spec.md`](talkbridge-cli-spec.md)

## 1. 인증·환경

- `Authorization: Bearer blumnb-…` — Agent API 키. **특정 brandKey 에 묶이고, 발급 환경(dev/prod)에 묶인다**
- 베이스: 실환경 `https://api.talkbridge.io` / 개발환경 `https://api.talkbridge-dev.com` (`talkbridge-cli-spec.md` §1)
- 스코프: `BrandRead`(조회) ⊂ `BrandWrite`(발신·설정) ⊂ `Admin`. 발신은 BrandWrite 이상
- 웹훅 서명 시크릿 `whsec_` 는 API 키와 **별개**. 센터 Webhook 연결 화면에서 확인, Agent 키 재발급 시 함께 바뀜

## 2. 샘플이 사용하는 엔드포인트

| 엔드포인트 | 스코프 | 요청 | 래퍼 | 비고 |
|---|---|---|---|---|
| `GET /api/agent/me` | — | — | `me` | 응답 **봉투 없음** `{name, scope, brands[]}` |
| `GET /api/agent/rooms` | BrandRead | `?brand=&max=` | `rooms` | `{ok, brand, rooms[]}` |
| `GET /api/agent/rooms/{userKey}/messages` | BrandRead | `?brand=&max=`(1~300, 기본 100) | `roomMessages` | `{ok, brand, userKey, messages[]}` **최신순** |
| `POST /api/agent/send` | BrandWrite | `{brandKey, userKey, text}` | `send` | **과금**. 응답에 `serial: "bw-…"` |
| `POST /api/agent/send/rich` | BrandWrite | `{brandKey, userKey, rich}` (rich 는 **문자열**) | `sendRich` | 미실측 |
| `POST /api/agent/end` | BrandWrite | `{brandKey, userKey, greeting?}` | `end` | CLI 에 없는 순수 종료 |
| `POST /api/agent/end-with-bot` | BrandWrite | `{brandKey, userKey, botEvent?}` | `endWithBot` | |
| `POST /api/agent/block` · `unblock` | BrandWrite | `{brandKey, userKey}` | `block` | |
| `POST /api/agent/send/attachments` | BrandWrite | **multipart** `brandKey, userKey, text?, files(여러 개)` | `sendAttachments` | **과금**. `{ok, results[{kind, ok, code, serial, message?}]}` — 말풍선마다 serial. 한 장이라도 나가면 최상위 `ok:true` |
| `POST /api/agent/delete` | BrandWrite | `{brandKey, userKey, serial}` 또는 `{…, text, withinSeconds?(10~86400, 기본 180)}` | `deleteMessage` | 발송 후 **24h** 이내, 말풍선 1개 단위. 상담 건수 미환급. 실패 `NOT_FOUND`·`NOT_DELETABLE`·`EXPIRED` |

2026-10-06 공개 매뉴얼(Outbound Messages) 기준으로 `send/attachments`·`delete` 가 REST 에 추가됐다(CF-009 해소). 대화 이력 `GET /api/agent/conversations`·`conversation?convId=` 도 매뉴얼에 있다(샘플 미사용).
개발환경 실측: 두 엔드포인트 모두 404 가 아닌 인가 응답(403 `NO_BRAND_SCOPE`, 키-브랜드 불일치) — 존재 확인. REST 실발신은 미완,
같은 코어를 CLI v1.3.1(`send --file` · `delete --serial`, `--json` 필드 = REST)로 실발신 실측 완료 — `talkbridge-cli-spec.md` 가 아니라 01 README §4.1 에 응답·웹훅 원문.
**실측 차이**: 조회(`messages[]`)의 agent·deleted 항목에 `serial`·`deleted` 가 **아직 없다**(매뉴얼과 다름) → 샘플은 `outbox.js` 로 보완. 묶음 첨부는 저널 1건(본문 = 캡션 또는 `[첨부]`).
설정 API(`channel/schedule`·`chat`·`domain`)는 샘플이 쓰지 않는다. `channel/domain` 은 bypass 구성에서 변경 금지.

## 3. 응답 모델 (실측)

```
rooms[]    : userKey, lastSeq, lastText, lastKind, lastTimestampUnixMs, count, ended
messages[] : seq, userKey, sessionId, kind, text, timestampUnixMs, serial?(agent·deleted 만), deleted?(삭제된 발신만 true)
봉투       : { ok, code, message, ... }   (me 는 예외 — 봉투 없음)
```

- 시각은 **epoch ms** — CLI 의 연도 없는 `MM-DD HH:mm` 과 달리 보정이 필요 없다
- 고객 첨부는 `text` 안에 줄마다 `[photo|video|audio|file] <https://talk.kakaocdn.net/…> (문구)` — 묶음사진은 한 메시지 여러 줄.
  **호스트가 `talk.kakaocdn.net` 인 https 만** 첨부로 인정(고객이 입력한 링크·SSRF 방지). CDN URL 은 영구가 아니다(열흘 뒤 만료 실측) → 보관이 필요하면 수신 직후 사본 저장.
  `api.js` `parseAttachments` 가 `messages[].attachments[{type,url,comment}]` 로 올린다
- 묶음 첨부 발신을 지우면 `deleted:true` 는 **모든 장을 지웠을 때만** 붙는다
- `api.js` 는 이를 **01 의 CLI 래퍼와 같은 모델**(`userKey/kind/seq/text/at/direction`, rooms 의 `status/ended/lastSeq/lastText`)로 정규화한다 — 검수 시 두 래퍼의 반환 모델이 같은지 확인 (`sample-portability-constraints.md` §6)

## 4. 에러 코드와 재시도 원칙

| HTTP | code | 의미 | 재시도 |
|---|---|---|---|
| 401 | — | 토큰 없음/무효 (또는 다른 환경의 키) | ✗ |
| 403 | `FORBIDDEN` | 스코프 부족 | ✗ |
| 403 | `NO_BRAND_SCOPE` | 키가 이 브랜드에 인가되지 않음 | ✗ |
| 404 | `NO_BRAND` | 브랜드 없음 | ✗ |
| 400 | `EMPTY` / `BAD_RICH` | 필드 누락 / 리치 JSON 오류 | ✗ (수정 후) |
| 503 | `NO_PERSISTENCE` | 수신 영속 비활성 | ✓ |
| 2xx | 카카오 정규화 코드 | 세션 만료·중복 등 발신 실패 (예: `-502` 종료된 상담) | 새 수신 이벤트 뒤 |
| 400 | `NO_FILE` | 첨부 업로드 파일 없음 | ✗ (수정 후) |
| 402 | `QUOTA_EXHAUSTED` | 구독 상담 건수 소진 | 결제 후 |
| 2xx | `NOT_FOUND` / `NOT_DELETABLE` / `EXPIRED` | 발신 취소 실패 (본문 미발견 / 동의·인증 말풍선 / 24h 경과) | `NOT_FOUND` 만 serial 로 재시도 |

## 5. 검수 포인트

- 조회 실패는 throw, 발신 실패는 `{ok:false, code, raw}` — 01 의 `cliSend` 계약과 동일해야 한다. 발신 래퍼는 `serial` 을 올려야 한다(취소·echo 대조 키)
- multipart 발신은 `content-type` 을 직접 넣지 않는다(boundary 는 fetch 가 붙인다). Node 18 내장 `FormData`·`Blob` 만 — 의존성 0
- 첨부 썸네일·다운로드는 `parseAttachments` 를 거친 카카오 CDN URL 만 — 본문의 임의 URL 을 `<img>` 로 띄우면 P1
- 타임아웃(`AbortSignal.timeout`)이 있어야 웹훅 후처리가 REST 지연에 묶이지 않는다
- 오류 메시지에 **원인 + 다음 행동**(예: 401 → `TB_API_KEY`·환경 확인)이 있어야 한다
- 키·시크릿이 응답·로그·`/api/me` 로 새지 않는지 (`webhook-security-guard` B 항목)
