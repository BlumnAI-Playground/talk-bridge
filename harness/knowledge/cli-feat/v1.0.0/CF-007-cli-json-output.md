# CF-007 · CLI `--json` 출력 부재 — 프로그램이 텍스트를 파싱해야 한다

| | |
|---|---|
| 분류 | DX |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · 2026-09-09 |
| 영향 | 01·03 (`server/cli.js` 파서 4종 + 그래프 결과 파싱), CLI 로 자동화하는 모든 파트너 |
| 상태 | 구현됨(v1.1.0) · 호환성 주의 — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-cli-spec.md`](../../talkbridge-cli-spec.md) §3, [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §3, 01 README §6.2 |

## 현상 (실측)

CLI 는 사람이 읽는 텍스트만 출력한다. 샘플은 정규식으로 파싱한다:

```
  · Vjpe_s_fc16k     [진행중]   4건  최신#11  09-08 10:28  "[첨부]"        ← rooms
  #10   [message] 09-08 10:23  톡브릿지 가격이 어떻게되나요?                 ← rooms --user
  이름   : CLI login 2026-09-08 / 권한   : BrandWrite / 브랜드 (1): - crm-b3e696   ← whoami
```

- 타임스탬프에 **연도가 없다** → 파서가 현재 연도로 보정하고 연말 경계를 추정
- `knowledge search --cypher` 는 **첫 컬럼만** 출력 → 여러 값은 `'\t'` 로 이어 붙여야 한다. 노드/관계 구조 RETURN 은 아무것도 안 찍힌다
- 표기가 바뀌면 파서가 조용히 0건을 돌려준다 (01 `doctor [6]` 이 "출력은 있는데 0건" 을 경고하는 이유)

## 파트너 영향

- 파서 유지보수 부담이 파트너에게 전가되고, CLI 마이너 업데이트가 연동을 깨뜨릴 수 있다
- 그래프 결과의 타입(숫자·시각·불리언)이 전부 문자열로 뭉개진다

## 현재 우회

- 01/03 `server/cli.js` 의 파서 4종 + `toIso()` 연도 보정, 03 `graph.js` 의 탭 결합 규약
- 02 처럼 REST 를 직접 호출하면 JSON 을 받는다 (단 REST 에는 `history`/`delete` 가 없음 → CF-009)

## 제안 스펙

1. 전역 플래그 `--json`: `whoami`, `rooms`, `history`, `send`, `delete`, `gateway status`, `knowledge status/search/query` 가 **한 줄 JSON**(또는 배열)을 stdout 으로, 진단 메시지는 stderr 로
2. 필드는 REST 응답과 **같은 이름**(`userKey`, `lastSeq`, `timestampUnixMs`, `kind`, `text` …) — 01↔02 승격 시 모델이 같아진다
3. `knowledge search --cypher --json`: `{"columns":[…],"rows":[[…],…]}` 로 **모든 컬럼**과 타입 보존
4. 텍스트 출력에도 연도 포함(`2026-09-08 10:28`) — 파서 호환을 위해 `--json` 없이도 개선
5. 호환성: 기본 출력은 유지(연도 추가만), `--json` 은 opt-in

## 수용 기준

- `rooms --brand X --json | jq '.[0].userKey'` 가 동작한다
- `knowledge search --cypher "MATCH (c:Customer) RETURN c.id, c.name" --json` 이 2컬럼을 모두 돌려준다
- 01 `server/cli.js` 의 파서를 `JSON.parse` 로 교체해도 `doctor [6]` 이 통과한다
- 텍스트 모드 타임스탬프에 연도가 있다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨.** 전역 `--json` — 도움말 첫 줄에 `전역 옵션: --json 결과를 한 줄 JSON 으로 출력(프로그램 연동용, 필드명은 REST 와 동일). 오류는 ok=false + error 필드`.

- `rooms --brand X --json` → `[{"userKey","lastSeq","lastText","lastKind","lastTimestampUnixMs","count","ended"}]` (REST `/api/agent/rooms` 의 `rooms` 와 동일 필드) ✓
- `rooms --user --json` → `[{"seq","userKey","sessionId","kind","text","timestampUnixMs"}]`, `history --json` → `[{"brand","conversations":[{"convId",…}]}]`, `whoami --json`, `gateway status --json`(`knowledgeApi` 포함), `env --json`, `knowledge status --json` ✓
- `knowledge search --cypher "MATCH (c:Customer) RETURN c.id, c.name" --json` → `{"columns":["c.id","c.name"],"types":["STRING","STRING"],"rows":[[…]]}` 2컬럼 ✓
- 텍스트 모드 타임스탬프에 연도 ✓ (`2026-09-09 10:30`)
- 오류: `{"ok":false,"error":"조회 실패(NO_BRAND_SCOPE): …"}` + exit 1 ✓

**호환성 주의 (실측)**: 연도 추가로 v1.0.0 형식에 맞춘 01·03 의 텍스트 파서가 **0건**을 돌려준다(`doctor [6]` "출력은 있는데 파싱 0개").
→ 01 `server/cli.js` 파서를 두 형식 호환으로, 03 은 `--json` 으로 전환. "기본 출력은 유지" 조건은 지켜졌지만 **파서를 가진 파트너 코드는 갱신이 필요**하다 — 릴리스 노트에 명시 권장.
