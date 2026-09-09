# TalkBridge CLI 상담지식 그래프 (LadybugDB) — 스키마·제약·조회 규칙

> 실측일 2026-09-09 · `talkbridge-dev` v1.0.0 → **v1.1.0 재검수** · LadybugDB v0.18.0 (Kuzu 계열 임베디드 그래프 DB) · Windows 11
> 구현: [`sample-project/03-cli-knowledge-graph/`](../../sample-project/03-cli-knowledge-graph/) (`server/graph.js`, `scripts/seed.mjs`)
> 관련: [`talkbridge-cli-spec.md`](talkbridge-cli-spec.md) §5 (`knowledge` 명령군)
> **기능의 위치(2026-09-09 확정)**: CLI 상담지식 그래프는 상담 내역을 활용한 **온톨로지 구축 참고용 연구 샘플 제공 기능**이다.
> CLI 가 파트너사 온톨로지를 위해 공식 제공하는 기능이 아니며, CLI 설치 위치에서 온디바이스로 라이트웨이하게 동작한다.
> 파트너는 스키마·조회 패턴을 참고해 규모에 맞는 그래프 DB 를 채택해 적용한다. README(루트·샘플 인덱스·03)에 이 문구가 있어야 하며, "공식 기능"으로 읽히는 서술은 드리프트로 본다 (문서 대조관 검수 항목).

## 1. 스키마 (실측)

```
(:Customer {id = userKey, brand, name, phone, memo})
    -[:ASKED]-> (:Inquiry {id = "<convId>#<turn>", text, ts:TIMESTAMP, loadedAt:TIMESTAMP})
                    -[:ANSWERED]-> (:Response {id, text, byAgent:BOOL, ts, loadedAt})
                    -[:MENTIONS {confidence:DOUBLE}]-> (:Entity {name (PK), kind})
```

| 사실 | 검수 포인트 |
|---|---|
| `Customer.id` = 카카오 `userKey` | 상담 화면의 방과 그래프 고객을 같은 키로 잇는다 |
| `MENTIONS` 는 **Inquiry → Entity 만** | Response 에서 걸면 `Binder exception: Query node n violates schema` |
| `Entity` PK 는 `name` | 같은 이름 CREATE 는 실패 → `MERGE … ON CREATE SET e.kind` |
| `ts` 는 UTC | `knowledge build` 로 적재한 과거 상담의 `ts` 는 **적재 시각**(원 메시지 시각 아님) — CLI 결함 후보 |
| 스키마 조회 | `CALL show_tables() RETURN name`, `CALL table_info('Customer') RETURN name` (첫 컬럼만 찍히므로 `RETURN name`) |

## 2. 잠금 — 게이트웨이가 DB 를 쥔다, 조회는 조회 API 로 (v1.1.0)

게이트웨이는 기동 시 `온톨로지 sink 활성 → LadybugDB` 로 DB 를 열고 **계속 잡고 있다**. LadybugDB 는 READ_WRITE 하나가 열려 있으면
READ_ONLY 도 못 연다([공식](https://docs.ladybugdb.com/concurrency/)). 그래서:

| | v1.0.0 (관찰) | v1.1.0 (재검수) |
|---|---|---|
| `search --cypher` / `status` 통계 / `view` | `LadybugDB 열기 실패` / `초기화 실패` / 빈 그래프 | 게이트웨이의 **조회 API**(`127.0.0.1:8790/knowledge/` status·cypher·graph.json·search)를 **자동 경유** — 정상 |
| `build` / `query --write` | (query 는 쓰기까지 실행됨) | `게이트웨이(pid N)가 그래프 DB 를 사용 중 … 'gateway stop' 후 다시 실행` 으로 거부 |
| 03 샘플 | 조회 창 `gateway stop → Cypher → start` (서버가 게이트웨이를 멈춤) | 서버는 게이트웨이를 건드리지 않는다. **쓰기 스크립트(seed·build)만** `scripts/write-window.mjs` 로 잠시 멈춘다 |

- 멈춘 동안의 이벤트는 `stream-offsets.json` 으로 재기동 시 재생되어 유실되지 않는다(실측, v1.0.0/v1.1.0 동일)
- 조회 API 도 읽기전용을 강제한다: `GET /knowledge/cypher?q=MATCH (n) DETACH DELETE n` → 400
- `knowledge status --json` 의 `graph.via`(`"gateway"`|`"file"`)·`holderPid` 로 어느 경로인지 안다

**함정 (여전히 유효)**: 쓰기 창을 여는 프로세스가 둘이면(시드 스크립트 + 수동 `gateway start`) 잠금이 겹쳐 CLI 가 **60초 이상 멈춘다**.
런처(node)만 죽이면 자식 `talkbridge-dev.exe` 가 잠금을 쥔 채 남을 수 있다 → Windows 는 `taskkill /T /F` 로 트리 종료 (03 `cli.js` 타임아웃 처리).

검수 포인트: 파트너 서버 코드가 조회를 위해 `gateway stop` 을 부르면 v1.1.0 에서는 **불필요한 다운타임** — P2. 쓰기 경로에서만 허용.
→ [cli-feat/CF-001](cli-feat/v1.0.0/CF-001-graph-db-exclusive-lock.md) (구현됨 v1.1.0)

## 3. 출력 — `--json` 으로 전체 컬럼 (v1.1.0)

`search --cypher … --json` → `{"columns":["c.id","c.name"],"types":["STRING","STRING"],"rows":[["…",null],…]}`.
여러 컬럼을 그대로 `RETURN` 하면 된다. 숫자는 숫자(`INT64`), TIMESTAMP 는 `"2026-08-20 10:12:00"` 문자열, BOOL 은 `True`/`False` 문자열로 cast 하면 안전.

- v1.0.0 은 첫 컬럼만 텍스트로 찍어 `RETURN a + '\t' + cast(b AS STRING)` 으로 이어 붙여야 했다 — 03 은 이 우회를 제거했다(`graph.js`)
- 지원 확인된 문법: `label(n)`, `cast(x AS STRING)`, `coalesce`, `CONTAINS`, `STARTS WITH`, `WITH … count(*)`,
  `ORDER BY`/`LIMIT`, `OPTIONAL MATCH`, `WHERE NOT EXISTS { MATCH … }`, `timestamp('YYYY-MM-DD HH:mm:ss')`, `MERGE … ON CREATE SET`,
  `;` 로 잇는 다중 문장(`query` 에서). `toString()` 은 **없다** (`cast` 사용)
→ [cli-feat/CF-007](cli-feat/v1.0.0/CF-007-cli-json-output.md) (구현됨 v1.1.0)

## 4. `search --cypher` vs `query` vs `query --write` (v1.1.0)

| | `knowledge search --cypher` | `knowledge query` | `knowledge query --write` |
|---|---|---|---|
| 쓰기 | **거부** — `읽기전용 Cypher만 허용됩니다(MATCH/RETURN, 쓰기·DDL 금지)` | **거부** — `쓰기를 실행하려면 --write 를 명시하세요. 거부된 문장: #1` (exit 1) | **실행됨** — `DETACH DELETE` 포함 |
| 다중 문장 | — | 문장별 결과 | `;` 로. 문장별 `#n ok` / `#n FAILED: <오류>`, 실패 시 **중단 + exit 1**(기본 `--stop-on-error`) 또는 `--continue-on-error` |
| 게이트웨이 가동 중 | 조회 API 경유 | 조회 API 경유 | 거부 → 쓰기 창 |
| 샘플에서 | 서버·화면 조회 전용 | — | `seed.mjs` 적재만. 기대 수/실제 수 대조는 회귀 보험으로 유지 |

v1.0.0 은 `query` 가 `--write` 없이 쓰기까지 실행했고(실측으로 그래프를 지웠다가 `build` 로 복구) 배치 실패를 `(ok)` 로 가렸다.
→ [CF-002](cli-feat/v1.0.0/CF-002-knowledge-query-safety.md) 구현됨, [CF-003](cli-feat/v1.0.0/CF-003-knowledge-build-timestamp.md) 구현됨(`ts` 원 시각·`loadedAt`), [CF-004](cli-feat/v1.0.0/CF-004-knowledge-without-ai.md) 구현됨(AI 선택), [CF-006](cli-feat/v1.0.0/CF-006-knowledge-view.md) 구현됨(뷰)

검수 포인트: 파트너 코드가 `knowledge query --write` 를 화면 경로에 노출하면 **P0** (임의 쓰기·삭제 가능).
프리셋 파라미터는 문자열 리터럴에 삽입되므로 화이트리스트 정규식으로 강제 (`userKey` 영숫자·`_`·`-`, `keyword` 따옴표·역슬래시 금지).

## 5. 전제와 설치

- **v1.1.0: AI 설정은 선택.** `install`/`build` 는 AI 없이 되고, 미설정이면 `Entity/MENTIONS` 추출과 자연어 `search` 만 생략된다(`status` 에 `엔티티 추출(AI): 미사용`).
  v1.0.0 은 AI 를 전제로 검사해 자리표시자(`setup --ai-provider openai --ai-base http://127.0.0.1:9/v1 …`)가 필요했다 — 이 PC 의 config 에는 그 자리표시자가 아직 남아 있다(04 AI 샘플 전에 실제 프로바이더로 교체)
- `install` 은 LadybugDB lib 를 OS 별로 내려받아 `~/.bridge-agent/ladybug/` 에 두고 스키마를 만든다. 이후 **게이트웨이 재기동**해야 온톨로지 sink 가 붙는다
- `config.knowledge.dbPath` 가 null 이면 `~/.bridge-agent/knowledge.lbug`

## 6. 데모 데이터셋 규칙 (03)

- 시나리오: 톡브릿지 상담센터에 파트너 개발자 10명이 CLI·API 연동을 문의 — 고객 10 · 엔티티 36 · 대화 18 · 문의 25 · 응답 22 · 언급 65
- 모든 id 는 `demo` 로 시작 → `demo:unseed` 로 통째 제거. 엔티티는 남는 `MENTIONS` 가 없을 때만 삭제
- 응답의 mentions 는 스키마 때문에 직전 문의에 붙인다
- 검수 포인트: 데이터셋 문장에 실제 계약 규칙(서명·멱등·과금·스코프)이 정확히 반영되어 있는가 — 문서 대조관이 `talkbridge-webhook-contract.md` 와 대조
