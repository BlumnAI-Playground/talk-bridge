# CF-009 · 공개 문서 갭 — rich 스키마, REST `delete`/`history`, userKey 표기, 엔드포인트 2개

| | |
|---|---|
| 분류 | 문서 갭 |
| 관찰 버전 | 공개 매뉴얼 2026-09-08 기준 · talkbridge-dev v1.0.0 · 2026-09-09 |
| 영향 | 전체 (특히 02 REST 파트너) |
| 상태 | 수용 (v1.1.0 미반영) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`docs/talkbridge-manual-digest.md`](../../../../docs/talkbridge-manual-digest.md) §15, [`talkbridge-rest-api-spec.md`](../../talkbridge-rest-api-spec.md) §2, 01 README "공개 문서와 다른 점", 데모 데이터 `demo:c13`·`c17` |

## 현상 (실측·확인)

| # | 갭 | 실측 |
|---|---|---|
| 1 | **rich 봉투 스키마** — `chat_bubble_type` 필수라는 언급만 있고 전체 스키마 없음 | 미해소. 02 `sendRich` 는 문자열 직렬화만 구현 |
| 2 | **REST 에 `delete` 없음** — 발신 취소는 CLI 에만 | 02 README "01 과 다른 점" 표 |
| 3 | **REST 에 `history`/`convId` 없음** — 대화 단위 식별자를 REST 로 얻을 수 없음. 그래프의 `Inquiry.id` 가 `<convId>#<turn>` 이라 REST 파트너는 이 키를 만들 수 없다 | 03 스키마 실측 |
| 4 | **userKey 표기** — 문서 예시 `user_ab12cd34`(API) / `kakao:Uabc123`(CLI) vs 실측 `Vjpe_s_fc16k` | 실측으로 통일 필요 |
| 5 | **엔드포인트 2개** — REST `api.talkbridge.io` vs CLI `webhook.talkbridge.io`; 개발환경은 `api.talkbridge-dev.com`/`webhook.talkbridge-dev.com`/`console.talkbridge-dev.com` | 세 호스트 모두 `/api/agent/me` 401 응답(존재) |
| 6 | **`me` 응답 봉투** — 문서는 `{ok,…}` 봉투를 전제하지만 `GET /api/agent/me` 는 봉투 없이 `{name,scope,brands}` | 02 실측 |
| 7 | **`send --file`** 존재(CLI), **순수 `end`** 부재(CLI), 설정 변경 3종 **Admin** 스코프 | 01 README 실측 표 |
| 8 | **개발환경 제공 정책** — 엔터프라이즈 구간 사전 테스트용 개발환경, 키는 발급 환경에 묶임 | 사용자 확인 |

## 파트너 영향

- 리치 메시지·발신 취소·대화 단위 집계를 REST 로 설계하다 막힌다 (데모 데이터의 미응답 문의 `c13`·`c17` 이 정확히 이 지점)
- 문서 예시대로 userKey 형식을 검증하면 실제 값을 거부한다

## 현재 우회

- 01/02/03 README 와 `harness/knowledge/talkbridge-*-spec.md` 가 실측 표를 제공
- 발신 취소·convId 는 CLI 경유 (01 `cliDelete`, `cliHistory`)

## 제안 스펙

1. 매뉴얼에 **rich 봉투 전체 스키마**(필수/선택 필드, 예시 3종) 추가
2. REST 에 `POST /api/agent/delete {brandKey,userKey,serial|text,withinSec}` 와 `GET /api/agent/history?brand=` 추가 (CLI 와 동일 의미)
3. userKey 형식을 문서에 정의(문자 집합·길이·안정성 보장) 하고 예시를 실제 형식으로 교체
4. "환경" 절 신설: 실환경/개발환경 호스트 3종, 키의 환경 종속, 개발환경 제공 조건
5. `me` 응답을 봉투로 통일하거나 예외임을 명시
6. CLI 명령 표에 `send --file`, 순수 `end` 부재, Admin 스코프 3종 반영

## 수용 기준

- 매뉴얼의 rich 예시를 그대로 `send/rich` 로 보내 성공한다
- `POST /api/agent/delete` 로 24h 내 발신을 취소하면 고객 방에 삭제 표시가 남는다
- REST 만으로 `convId` 를 얻어 그래프의 `Inquiry.id` 와 대조할 수 있다
- 문서의 userKey 예시가 정규식 정의와 일치하고 실측 값을 통과한다

## 재검수 (v1.1.0 · 2026-09-09) — 미반영

- `GET https://api.talkbridge-dev.com/api/agent/history?brand=crm-b3e696` → **404**, `POST /api/agent/delete` → **404** (같은 키로 `/api/agent/me`·`/rooms` 는 200)
- 공개 문서 `/api/reference/` 404, 랜딩·`/cli/commands/`·`/cli/install/` 에 rich 스키마·userKey 정의·환경 절 없음
- CLI 쪽은 `--json` 으로 REST 와 필드명이 같아졌고(CF-007) `history --json` 이 `convId` 를 준다 — CLI 경로로는 해결, REST 경로는 미반영. 상태 `수용` 유지
