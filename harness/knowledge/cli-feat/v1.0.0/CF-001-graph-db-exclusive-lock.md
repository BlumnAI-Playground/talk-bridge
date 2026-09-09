# CF-001 · 게이트웨이가 그래프 DB 를 상시 점유 — 다른 프로세스는 읽을 수 없다

| | |
|---|---|
| 분류 | 제약 (채택 기술 LadybugDB 의 동시성 모델에서 기인) |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · LadybugDB v0.18.0 · 2026-09-09 |
| 영향 | 03 전체, `knowledge search/query/view/status`, 온톨로지를 조회하려는 모든 파트너 |
| 상태 | 구현됨(v1.1.0) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §2, 03 README §5.1, [LadybugDB Concurrency](https://docs.ladybugdb.com/concurrency/) |

## 현상 (실측)

게이트웨이는 기동 시 온톨로지 sink 로 DB 를 열고 **종료할 때까지 잡고 있다**:

```
2026-09-09 12:39:06 온톨로지 sink 활성 → LadybugDB
2026-09-09 12:39:06 게이트웨이 워커 시작 — … sinks=2
```

그동안 다른 프로세스는 전부 실패한다:

```
$ talkbridge-dev knowledge search --cypher "MATCH (n) RETURN label(n)"
지식 스토어 초기화 실패(무시): LadybugDB 열기 실패: C:\Users\…\knowledge.lbug (buffer_pool=54704347545, max_db=8796093022208)
온톨로지 미설정/미설치 — 'knowledge install' 먼저.      ← 원인을 오도하는 메시지
$ talkbridge-dev knowledge status
  그래프(LadybugDB) : 초기화 실패
$ curl localhost:8791/graph.json                             ← knowledge view
{"nodes":[],"edges":[]}                                      ← 오류 없이 빈 그래프
```

`gateway stop` 직후에는 모두 정상이다. 게이트웨이 재기동 후 밀린 이벤트는 `stream-offsets.json` 으로 재생된다(실측: `since crm-b3e696:17`).

## 왜 — LadybugDB 의 동시성 규칙 (공식 문서)

LadybugDB(Kuzu 계열 임베디드 그래프 DB)는 파일 열기 시 권한 플래그를 **경량 잠금**으로 쓴다:

1. `READ_WRITE` Database 객체는 DB 당 **하나**
2. `READ_WRITE` 객체가 있는 동안에는 **별도의 `READ_ONLY` 객체도 같은 DB 를 조회할 수 없다**
3. `READ_ONLY` 객체끼리는 **여러 프로세스가 동시에** 열 수 있다
4. 잠금은 객체가 파괴되거나 프로세스가 끝날 때 풀린다 (`Could not set lock on file`)

게이트웨이는 쓰기(적재)를 하므로 `READ_WRITE` 로 열어야 하고, 그 순간 규칙 2 에 의해 모든 외부 조회가 막힌다.
**따라서 CLI 쪽 플래그(`read_only`)로는 해결되지 않는다** — 게이트웨이가 열어 둔 채로는 어떤 읽기 프로세스도 들어갈 수 없다.
이것은 버그가 아니라 채택한 DB 의 모델이며, 해법은 "누가 DB 를 여는가" 를 바꾸는 것뿐이다.

## 파트너 영향

- 상담을 받으려면 게이트웨이가 떠 있어야 하고, 그래프를 보려면 게이트웨이를 내려야 한다 — **동시에 할 수 없다**
- 오류 메시지가 "미설치" 라고 하고 뷰는 빈 그래프를 그려서, 파트너가 설치·적재를 의심하며 시간을 쓴다
- 두 프로세스가 번갈아 열면(서버의 조회 창 + 수동 `gateway start`) CLI 가 60초 이상 멈춘다(실측)

## 현재 우회 (03 샘플)

`sample-project/03-cli-knowledge-graph/server/graph.js` `withGraphWindow()`:
`gateway status` → `gateway stop`(≈0.4s, 종료 확인 폴링) → Cypher 들(건당 ≈0.5s, 잠금 재시도 3회) → `gateway start`(≈0.5s).
파라미터 없는 프리셋 7종은 한 창(≈4s)에서 스냅샷으로 캐시. 창은 서버 안에서 직렬화. 타임아웃 시 프로세스 트리 종료.
파트너에게는 "조회 빈도를 낮추고 스냅샷 주기로 운영" 을 권장.

## 제안 스펙 (권장순)

**A. 게이트웨이가 조회 API 를 제공 (권장)** — DB 를 연 프로세스가 곧 조회 서버가 된다. 잠금과 무관.
- `gateway start` 시 로컬 HTTP `http://127.0.0.1:<port>/knowledge/cypher?q=…` (읽기전용, MATCH/RETURN 검사), `/knowledge/status`, `/knowledge/graph.json`
- CLI `knowledge search --cypher` / `status` / `view` 는 게이트웨이가 떠 있으면 **자동으로 이 API 를 경유**하고, 없으면 지금처럼 파일을 직접 연다 → 파트너 코드 변경 없음
- 응답은 CF-007 의 `--json` 형식과 동일(`{"columns":[…],"rows":[…]}`)
- 포트는 `config.knowledge.queryPort`(기본 8790), 바인딩은 루프백만

**B. 게이트웨이가 쓰기 시점에만 연다** — 이벤트 적재 때 `READ_WRITE` 로 열고 닫는다. 그 사이 외부 `READ_ONLY` 조회 가능.
- 구현이 단순하지만, 조회 프로세스가 열고 있는 동안 도착한 이벤트의 적재가 실패/지연 → 재시도 큐 필요. 이벤트가 잦은 브랜드에서는 조회가 계속 밀린다. A 의 보조로만 권장

**C. 읽기용 스냅샷** — 게이트웨이가 주기적으로(또는 적재 후) `EXPORT DATABASE`/파일 복사로 `knowledge-ro.lbug` 를 만들고, 조회 명령은 스냅샷을 `READ_ONLY` 로 연다.
- 최신성은 스냅샷 주기에 묶이지만 잠금 충돌이 사라진다. A 를 도입하기 전 중간 단계로 적합

**D. 서버형 그래프 DB 로 교체** — 동시성 문제는 사라지나 "설치 없이 CLI 하나" 라는 제품 특성과 충돌. 비권장

공통: `LadybugDB 열기 실패` 시 메시지를 **"게이트웨이(pid N)가 DB 를 사용 중 — gateway stop 후 재시도 또는 조회 API 사용"** 으로 바꾼다. "미설치" 안내는 lib 부재일 때만.

## 수용 기준

- 게이트웨이 실행 중 `knowledge search --cypher "MATCH (n) RETURN count(n)"` 이 정상 결과를 돌려준다 (A 또는 C)
- 같은 상태에서 `knowledge status` 의 그래프 통계가 숫자로 나온다
- 같은 상태에서 `knowledge view` 의 `/graph.json` 이 실제 노드를 돌려준다
- 03 샘플에서 `withGraphWindow()` 의 stop/start 를 제거해도 프리셋 10종이 통과한다 (창 없이 조회)
- 잠금 충돌이 남는 경우 오류 메시지에 점유 프로세스와 조치가 명시된다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨 — 대안 A(게이트웨이 조회 API).**

- 게이트웨이 기동 로그: `지식 조회 API 활성 → http://127.0.0.1:8790/knowledge/ (status·cypher·graph.json·search)`. `gateway status --json` 에 `knowledgeApi` 필드
- 게이트웨이 가동 중 `knowledge search --cypher "MATCH (n) RETURN count(n)" --json` → `{"columns":["COUNT(n._ID)"],"types":["INT64"],"rows":[[98]]}` ✓
- `knowledge status --json` → `"graph":{"via":"gateway","error":null,"nodes":98,"edges":116,"holderPid":36660}` ✓
- `GET /knowledge/cypher?q=MATCH (n) DETACH DELETE n` → 400 `읽기전용 Cypher만 허용됩니다` (API 도 읽기전용 강제) ✓
- `knowledge view` 의 `/graph.json` 이 게이트웨이 가동 중 실제 노드를 돌려줌 ✓ (CF-006)
- 03 샘플에서 `withGraphWindow()` 를 제거하고 프리셋 10종 통과 (스냅샷 7종 4.8s, 조건 프리셋·사용자 Cypher 정상) ✓
- 잠금 충돌 메시지: 쓰기 시 `오류: 게이트웨이(pid 36660)가 그래프 DB 를 사용 중입니다 — 조회(status/search/view)는 게이트웨이 조회 API 로 자동 처리되고, 쓰기(build/query --write)는 'talkbridge gateway stop' 후 다시 실행하세요.` ✓

**잔여(설계상)**: 쓰기(`build`, `query --write`)는 여전히 게이트웨이를 멈춰야 한다(대안 B 미채택). 03 은 `scripts/write-window.mjs` 로 쓰기 스크립트 동안만 멈춘다.
