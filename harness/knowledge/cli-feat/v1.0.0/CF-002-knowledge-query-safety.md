# CF-002 · `knowledge query` — 쓰기가 실행되고, 배치 실패가 `(ok)` 로 가려진다

| | |
|---|---|
| 분류 | 결함 |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · LadybugDB v0.18.0 · 2026-09-09 |
| 영향 | 03 (`scripts/seed.mjs`), 그래프를 직접 다루는 모든 파트너 |
| 상태 | 구현됨(v1.1.0) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §4, `logs/tamer/2026-09-09-13-05-*` (실사고) |

## 현상 (실측)

`knowledge --help` 는 `query "<Cypher>"` 를 "Cypher 실행(디버그, 첫 컬럼 출력)" 으로 소개한다. 실제로는:

```
$ talkbridge-dev knowledge query "MATCH (n) DETACH DELETE n RETURN 1"
(출력 없음)
$ talkbridge-dev knowledge status
  그래프(LadybugDB) : 노드 0 · 엣지 0        ← 그래프가 지워졌다
```

반면 `search --cypher` 는 쓰기를 거부한다:
```
$ talkbridge-dev knowledge search --cypher "MATCH (n) DETACH DELETE n RETURN 1"
읽기전용 Cypher만 허용됩니다(MATCH/RETURN, 쓰기·DDL 금지).
```

배치(`;` 다중 문장) 실행 시 한 문장이 실패하면 **나머지가 중단되는데 종료 코드 0 과 `(ok)` 만 찍힌다**:
```
$ talkbridge-dev knowledge query "MATCH … MERGE (i:Inquiry …); MATCH (n:Response {…}), (e:Entity {…}) MERGE (n)-[:MENTIONS]->(e); MATCH … MERGE (i2:Inquiry …)"
(ok)
```
→ 두 번째 문장이 `Binder exception: Query node n violates schema` 로 실패했고 세 번째는 실행되지 않았다. 문장을 하나씩 실행해야 오류가 보인다.

## 파트너 영향

- "디버그" 라는 설명만 보고 `query` 를 화면·스크립트에 쓰면 임의 삭제가 가능하다 — 셀프 검증 도구의 경비대장 항목 E' 에서 **P0**
- 적재 스크립트가 반만 들어가도 성공으로 보인다. 03 의 1차 시드가 문의 25 중 18 만 들어갔지만 `(ok)` 였다

## 현재 우회

- 화면·서버는 `search --cypher` 만 쓴다 (`sample-project/03-cli-knowledge-graph/server/graph.js`)
- 적재는 `scripts/seed.mjs` 로 한정하고, 적재 후 **기대 수 / 실제 수를 대조**해 조용한 실패를 잡는다
- 대화 단위로 배치를 나눠 실패 범위를 줄인다

## 제안 스펙

1. `knowledge query` 는 기본 **읽기전용**. 쓰기·DDL 은 `--write` 를 명시해야 실행. 없으면 `search --cypher` 와 같은 거부 메시지
2. 배치 실행: 실패한 문장의 **번호와 오류**를 출력하고 **종료 코드 ≠ 0**. 옵션 `--stop-on-error`(기본) / `--continue-on-error`
3. 성공 시 문장별 결과 요약 (`#3 ok (2 rows)`), `(ok)` 단독 출력 폐지
4. 호환성: 기존 읽기 사용은 그대로. 쓰기 사용자는 `--write` 추가 필요 — 릴리스 노트에 명시

## 수용 기준

- `knowledge query "MATCH (n) DETACH DELETE n"` 이 `--write` 없이 거부되고 그래프가 변하지 않는다
- `--write` 로 3문장 배치 중 2번째가 스키마 위반이면 출력에 `#2` 와 `Binder exception` 이 있고 종료 코드가 0 이 아니다
- `--continue-on-error` 로 같은 배치를 실행하면 1·3 번은 반영되고 2 번만 오류로 보고된다
- 03 `seed.mjs` 의 수 대조가 그대로 통과한다(회귀 없음)

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨.**

```
$ knowledge query "CREATE (:Entity {name:'cf002-a', kind:'test'})"
오류: 읽기전용 Cypher만 허용됩니다(MATCH/RETURN, 쓰기·DDL 금지). 쓰기를 실행하려면 --write 를 명시하세요. 거부된 문장: #1   (exit 1, 그래프 무변경 ✓)

$ knowledge query --write "CREATE …cf002-a…; MATCH (r:Response) … CREATE (r)-[:MENTIONS]->(…); CREATE …cf002-b…"
#1 ok
#2 FAILED: Binder exception: Query node r violates schema. Expected labels are Inquiry.
1개 문장은 실행하지 않았습니다(앞 문장 실패 — 계속하려면 --continue-on-error).   (exit 1, cf002-a 만 존재 ✓)

$ knowledge query --write --continue-on-error "…c…; …(위반)…; …d…"
#1 ok / #2 FAILED … / #3 ok   (exit 1, c·d 존재 ✓)
```

- 03 `seed.mjs` 를 `--write` 로 바꾸고 데모 적재 → 기대/실제 수 대조 4항목 모두 일치 ✓ (회귀 없음)
- `(ok)` 단독 출력 폐지 ✓
