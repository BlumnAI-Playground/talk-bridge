# 자동응대봇 — 맥락 유지 설계와 자동응답 가드 (04 샘플, 실측 2026-09-14)

> 구현: [`sample-project/04-cli-autoreply-bot/`](../../sample-project/04-cli-autoreply-bot/) (`server/bot.js`, `openai.js`, `rules.js`)
> 계약 근거: [`talkbridge-webhook-contract.md`](talkbridge-webhook-contract.md), [`talkbridge-cli-spec.md`](talkbridge-cli-spec.md) §3

파트너가 "AI 상담봇" 을 얹을 때 반드시 지켜야 하는 것과, 04 가 그것을 어디서 지키는지의 기준표다.
검수 에이전트(웹훅 경비대장·이식 감독관)는 자동응답 코드를 이 문서로 판정한다.

## 1. 맥락 유지 — 세 가지 입력

| 입력 | 출처 | 검수 포인트 |
|---|---|---|
| 대화 이력 | CLI `rooms --user --json` (매 턴 재조회 → 재기동해도 유지) | **같은 세션만** 넣는가. 지난 상담이 섞이면 엉뚱한 단계로 이어진다 |
| 진행 상태 | 방별 `{scenarioId, stepIndex, collected}` — 모델이 매 턴 갱신해 JSON 으로 반환 | 모델이 준 id·단계를 **검증·보정**하는가 (없는 시나리오, 범위 밖 단계) |
| 규칙 | 페르소나 · 공통 지식 · 시나리오(의도·키워드·단계·완료 후) | 사실은 지식에서만. 없는 금액·약속을 지어내지 말라는 지침이 있는가 |

### 세션 경계 실측 (dev CLI v1.1.0)

- `kind:"message"` 항목에는 `sessionId` 가 있지만 **`agent` 항목에는 `sessionId` 가 없다** → `sessionId` 필터만 쓰면 지난 세션의 봇·상담원 발화가 섞인다 (P1)
- 04 의 규칙: `fromSeq = max(마지막 ended/expired seq + 1, 최신 고객 메시지 sessionId 의 첫 seq)` 이후의 `message`·`agent` 만
- 종료된 방은 transcript 가 비고, 새 문의가 오면 새 sessionId 로 시작한다 (실측: `OhF91h3aGCzI` #9 ended → 빈 맥락)
- 발신 직후 저널에 아직 없는 봇 답장·dry-run 답장은 로컬 `botReplies` 를 시각 순으로 끼워 넣어야 다음 턴 맥락이 끊기지 않는다

## 2. 자동응답 가드 — 누락 시 등급

| # | 가드 | 누락 시 사고 | 등급 |
|---|---|---|---|
| G1 | 트리거는 `kind:"message"` 뿐. `agent` echo 로 응답 생성 금지 | 내 발신이 내 발신을 부르는 **무한 발신** (건수 소진) | **P0** |
| G2 | 저널 재생 가드 — 부팅 시점 방별 `lastSeq` 이하 무시 + 메시지 시각 N초(기본 180) 초과 무시 | 게이트웨이 첫 기동·오프셋 유실 시 **과거 문의 전체에 답장** | **P0** |
| G3 | 방별 직렬화 (생성 중 새 메시지 → 끝난 뒤 재실행) | 동시 답장·순서 뒤바뀜 | P1 |
| G4 | 디바운스 (끊어 보낸 여러 줄을 모아 한 번) | 답장 폭주·건수는 같지만 UX 붕괴 | P2 |
| G5 | 방별 속도 제한 (04: 1분 5회 → 정지) | 이상 루프 방어선 부재 | P1 |
| G6 | 사람 개입 시 봇 정지 (화면 발신 즉시 · 봇 답장과 본문이 다른 `agent` echo) | 상담원과 봇이 동시에 답함 | P1 |
| G7 | AI 오류 시 안내 + 상담원 연결 (조용히 실패하지 않음) | 고객 방치 | P2 |
| G8 | 실발신 기본 OFF(dry-run) · 켤 때 확인 | 설정 중 실고객 오발신 | P1 |
| G9 | 세션 경계(`reference`/`ended`/`expired`)에서 방 상태 초기화 | 지난 상담의 단계·정지가 새 상담에 남음 | P2 |

- 서명 검증은 자동응답에서 더 중요하다 — 무서명 릴레이면 위조 요청이 **봇의 과금 발신**을 유발한다 (`doctor [4]` 경고 문구에 반영)
- 사람 개입 판별의 본문 일치는 샘플 수준. 운영은 발신 serial 로 (CF-008: echo 에 `serial` 없음 → 현재는 불가)

## 3. OpenAI 호출 규칙

| 항목 | 04 의 선택 | 이유 |
|---|---|---|
| API | Responses API `POST /v1/responses` | 추론 모델 권장 경로, `reasoning.effort` |
| 기본 모델 | `gpt-5.6-terra` · effort `medium` | 사용자 지정 (2026-09-14). `.env` `OPENAI_MODEL`/`OPENAI_REASONING_EFFORT` → 웹 [설정] 이 덮어씀 |
| 출력 | `text.format = json_schema, strict:true` | 봇 엔진이 reply·시나리오·단계·handoff 를 안전하게 읽는다 |
| 저장 | `store: false` | 상담 내용을 OpenAI 대화 저장소에 남기지 않음 — 맥락은 매 턴 우리가 보낸다 |
| temperature | 보내지 않음 | 추론 모델은 거부 |
| 응답 파싱 | `output[]` 중 `type:"message"` 의 `output_text` 만 | `reasoning` 항목이 섞일 수 있다 |
| 실측 | 턴당 1.9~5.8초 · 입력 ≈ 2.8~3.4천 토큰(대부분 지침) · 추론 토큰 0~133 | 지식이 커지면 검색(RAG)으로 |

## 4. 키 취급 — `.secret/` 규칙

- 찾는 순서: `OPENAI_API_KEY` → `OPENAI_KEY_FILE` → `<샘플>/.secret/openai.json` → `<저장소>/.secret/openai.json`
- `.gitignore`: `**/.secret/*` + `!**/.secret/*.tmp` — 실제 키 JSON 은 커밋 불가, 키 없는 `*.tmp` 템플릿만 커밋
- 템플릿은 머리에 `#` 주석이 있어 순수 JSON 이 아니다 → 로더가 `#` 줄을 버리고 파싱
- 화면·로그·오류에는 앞 7자·뒤 4자 마스킹만. OpenAI 오류 메시지에 키가 실리지 않게 상태코드별 안내로 감싼다
- 검수 포인트: `git check-ignore -v .secret/openai.json` 이 규칙을 가리키는가, `git grep -E "sk-(proj|svcacct)-"` 0건 (P0)

## 5. 모델 판단 품질 — 실측에서 고친 것

- **handoff 과잉**: "결제는 카드로 되나요?" 에 모델이 handoff=true → 봇 정지. 지침 5번을 "상담원이 직접 처리해야만 하는 요청일 때만,
  지식의 문의 창구 안내로 끝나는 질문은 handoff=false" 로 좁혀 해소 (재실행에서 안내 후 대화 지속)
- 한 대답이 여러 단계를 채우면 건너뛰기 — "도메인이 없어요" 가 연동 시나리오 1단계를 채워 2단계로 바로 진행 (실측)
- 주제 전환 시 `collected` 유지 — 요금 → 연동 → 오류로 전환해도 앞서 받은 정보가 남음 (실측)
