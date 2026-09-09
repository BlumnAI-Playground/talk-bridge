# CF-006 · `knowledge view` — 호스트명 제한, `/search` 직렬화 오류, 잠금 시 빈 그래프

| | |
|---|---|
| 분류 | 결함 |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · 2026-09-09 |
| 영향 | 03, 그래프를 눈으로 확인하려는 모든 사용자 |
| 상태 | 구현됨(v1.1.0) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §2, 03 README §6.5 |

## 현상 (실측)

1. **호스트명**: `http://127.0.0.1:8791/` → `HTTP Error 400. The request hostname is invalid.` (HttpListener 프리픽스가 `localhost` 만). `http://localhost:8791/` 은 정상
2. **`/search`**: 자연어 검색 엔드포인트가 직렬화 오류를 JSON 으로 돌려준다
   ```
   {"error":"JsonTypeInfo metadata for type 'System.String' was not provided by TypeInfoResolver …"}
   ```
   (AI 미설정 환경에서 관찰 — AI 설정 시 재현 여부 미확인)
3. **잠금**: 게이트웨이가 떠 있으면 뷰가 정상 기동된 것처럼 보이지만 `/graph.json` 이 `{"nodes":[],"edges":[]}` — 오류 없이 **빈 그래프**를 그린다 (CF-001 의 파생)
4. 페이지가 `https://unpkg.com/cytoscape@3` 를 CDN 으로 로드 — 사내망(01/03 의 핵심 사용자)에서는 렌더링 실패

## 파트너 영향

- "그래프가 비어 있다" 로 오해 → 적재를 다시 시도하거나 버그로 보고
- 사내망 파트너는 뷰를 아예 못 쓴다

## 현재 우회

- `localhost` 로 열고, 게이트웨이를 멈춘 뒤 본다 (03 `scripts/knowledge.mjs view` 가 안내)
- 03 화면은 뷰에 의존하지 않고 프리셋 테이블로 대신한다

## 제안 스펙

1. 리스너 프리픽스를 `http://+:port/` 또는 `localhost` + `127.0.0.1` 둘 다로
2. `/search` 의 JSON 직렬화 컨텍스트 수정(소스 생성 `JsonSerializerContext` 에 `string` 등록 또는 리플렉션 리졸버). AI 미설정이면 `{"error":"AI 미설정 — /cypher 를 사용하세요"}` 로 명시
3. DB 를 열지 못하면 `/graph.json` 이 `{"error":"locked","holder":"gateway"}` 와 HTTP 503 을 돌려주고 화면에 배너 표시
4. cytoscape 를 CLI 자산으로 번들해 오프라인 동작 (CDN 폴백 없이)
5. 읽기전용 Cypher 엔드포인트 `/cypher?q=` 추가 — 03 이 CLI 프로세스 spawn 없이 뷰 API 로 조회할 수 있어 CF-001 완화에도 도움

## 수용 기준

- `http://127.0.0.1:<port>/` 가 200
- 게이트웨이 실행 중 `/graph.json` 이 503 + `locked` 를 돌려주고 페이지에 안내가 뜬다
- 인터넷 차단 환경에서 페이지가 그래프를 그린다
- `/search?q=…` 가 AI 설정/미설정 각각에서 JSON 오류 없이 응답한다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨.** (게이트웨이 가동 중 `knowledge view --port 8791`)

- `http://127.0.0.1:8791/` 200, `http://localhost:8791/` 200 ✓
- `/graph.json` 이 게이트웨이 가동 중 **실제 노드**를 돌려줌 (503+locked 대신 조회 API 경유 — 스펙보다 나은 해법) ✓
- `/search?q=웹훅` → `{"terms":["웹훅"],"ids":[…]}` JSON 오류 없음 ✓ (AI 자리표시자 환경; `--json` 은 `hits` 배열)
- `/cypher?q=…` 읽기전용 엔드포인트 추가 ✓
- 페이지가 `src="/cytoscape.min.js"` 로 CLI 자산을 로드(CDN 폴백 없음) ✓ — 인터넷 차단 환경 실측은 하지 않음
- 화면 상단 `상담지식 온톨로지 — 98 노드 · 116 엣지 · 게이트웨이 경유` (03 README 스크린샷)
