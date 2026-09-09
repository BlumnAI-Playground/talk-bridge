# CF-004 · AI 미설정이면 `knowledge install/build` 가 거부된다

| | |
|---|---|
| 분류 | 제약 |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · 2026-09-09 |
| 영향 | 03 (AI 없이 그래프만 쓰는 파트너), 온보딩 |
| 상태 | 구현됨(v1.1.0) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §5, 03 README §2 |

## 현상 (실측)

```
$ talkbridge-dev knowledge install
오류: 온톨로지는 AI 모델이 전제입니다. 먼저 'talkbridge setup' 에서 AI 프로바이더·모델을 설정하세요.
$ talkbridge-dev model list
오류: AI 프로바이더가 설정되지 않았습니다. …
```

자리표시자(`setup --ai-provider openai --ai-base http://127.0.0.1:9/v1 --ai-key placeholder --ai-model placeholder --ai-api chat`)를 넣으면 install 이 통과하고, `build` 는

```
[ontology] 엔티티 추출 실패(무시): 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (127.0.0.1:9)
✓ 적재 완료 — 대화 1 · 턴 2 → 그래프(LadybugDB) 노드 5 · 엣지 4
```

즉 **AI 없이도 고객→문의→응답 그래프는 정상 적재**되며, 관문만 AI 설정 유무를 검사한다.

## 파트너 영향

- 그래프 조회만 쓰려는 파트너(03 시나리오)가 가짜 AI 설정을 넣어야 한다 — 온보딩 문서에 쓰기 민망한 절차
- `chatbot` 등 다른 기능이 자리표시자 AI 를 실제로 부르려다 실패한다

## 현재 우회

- 자리표시자 설정 (03 README §2, `.env.example` 주석). 04(AI 회차) 전에 실제 프로바이더로 교체

## 제안 스펙

1. `knowledge install` 은 AI 설정을 요구하지 않는다 (lib·스키마와 무관)
2. `knowledge build` / 게이트웨이 온톨로지 sink: AI 미설정이면 **엔티티 추출을 건너뛰고** 기본 그래프만 적재. 시작 시 한 줄 안내 (`AI 미설정 — Entity/MENTIONS 는 생략됩니다`)
3. `knowledge status` 의 "전제(AI모델)" 을 "엔티티 추출(AI): 사용/미사용" 으로 바꿔 전제가 아닌 선택임을 드러냄
4. 자연어 `search "<질문>"` 만 AI 필수 — 미설정이면 `--cypher` 를 안내

## 수용 기준

- AI 설정이 없는 새 환경에서 `knowledge install` 이 성공한다
- 같은 환경에서 `knowledge build --brand X` 가 오류 없이 Customer/Inquiry/Response 를 적재하고 Entity 는 0 이다
- `knowledge search "자연어"` 는 AI 미설정 안내와 함께 `--cypher` 를 권한다
- 03 샘플의 자리표시자 절차를 README 에서 삭제할 수 있다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨** (config 의 `ai` 를 null 로 바꿔 실측, 실측 후 원복).

- `knowledge install` → `✓ 온톨로지 활성 … AI 미설정 — 엔티티(Entity/MENTIONS) 추출과 자연어 검색은 생략됩니다. 필요하면 'talkbridge setup' 에서 AI 를 설정하세요(선택).` ✓
- `knowledge status` → `엔티티 추출(AI): 미사용 — 고객→문의→응답 그래프만 적재(선택: setup 에서 AI 설정)` ✓ (전제 → 선택으로 표기 변경)
- `knowledge search "웹훅 서명"` → `오류: AI 미설정 — 자연어 검색은 AI 프로바이더가 필요합니다. … 'knowledge search --cypher "MATCH … RETURN …"' 로 직접 검색하세요.` ✓
- `knowledge build --brand X` (AI 없이) — 게이트웨이 가동 중이라 쓰기 거부(CF-001 메시지)로 종료. AI 없는 실제 적재는 help·install 안내로만 확인 (**미실측**, 자리표시자 환경에서의 적재는 v1.0.0 때 확인)
- 03 README §2 의 자리표시자 절차 삭제 ✓, `.env.example` 안내 갱신
