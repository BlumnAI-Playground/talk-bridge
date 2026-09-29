# TypeSafe Jev — System One 모델과 간편 FAQ 자동응답 설계 기준 (조사·실측 2026-09-29)

> 출처: [공식 발표](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [docs.typesafe.ai](https://docs.typesafe.ai/) (`/api`, `/primitives/choice`, `/confidence`, `/patterns`, `/concepts/system-one`, `/sdk/javascript`) · [typesafe-sdk-js v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js) · [system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python)
> 상태: **Early access (2026-09 발표)**. §1~§5 는 공식 문서 조사, **§6 은 이 저장소에서 실제 호출한 실측**이다 (`jev-1.13.0`).
> 구현: [`sample-project/05-cli-jev-faq-bot/`](../../sample-project/05-cli-jev-faq-bot/) (`server/jev.js`, `bot.js` `buildRequest`/`decide`, `scripts/eval.mjs`)
> 연관: [`talkbridge-autoreply-bot.md`](talkbridge-autoreply-bot.md) (G1~G9 가드), [`sample-portability-constraints.md`](sample-portability-constraints.md) (의존성 0)

## 1. Jev 는 무엇인가

- TypeSafe AI 의 첫 **System One 모델**. "비정형 상태(state) 입력 → **타입이 정해진 확률적 판정** 출력" 을 하는 함수 호출형 AI
- **문장을 생성하지 않는다.** 답장 작성·코드 생성·추론 설명 불가 — 가능한 출력과 구조를 **미리 정의**하고 그중에서 고른다
  → 스키마 밖 값이 나올 수 없으므로 "환각 0%" 라고 주장 (고른 답이 **틀릴** 수는 있다 — 그래서 확률·confidence 를 준다)
- 병렬 샘플러로 모든 질문을 한 번의 쿼리로 평가. 학습법: RLCD(Reinforcement Learning for Calibrated Decisions) — 확률이 **보정(calibrated)** 되도록 학습
- 입력: 텍스트만 (문자열·JSON 객체·텍스트 배열). 이미지·음성·영상 미지원
- 벤더 주장 수치: 응답 **70–500ms**, 입력 **$0.042 / MTok**, 출력 무료. LLM 대비 40–200배 빠름

| 적합 | 부적합 |
|---|---|
| 의도 분류·라우팅, FAQ 매칭, 감정/긴급도 점수, 예/아니오 판정, LLM 출력 가드레일, 대량 데이터 분류 | 답장 문장 생성, 요약, 추출한 값을 **문자열로** 돌려받기, 이미지 입력 |

## 2. HTTP API (공식 문서 기준)

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

요청:

| 필드 | 타입 | 설명 |
|---|---|---|
| `state` | string \| object \| array | 판정 대상. 구조화 상태(JSON)를 권장 |
| `model` | string | `"jev-latest"` (응답에는 실제 버전 예: `"jev-1.13.0"`) |
| `questions` | map<key, Question> | 키는 자유. **한 요청에 여러 질문 → 병렬 평가** (시간 거의 동일) |

### 질문 3종 (Primitives)

| type | 용도 | `criteria` | 응답 필드 | 제약 |
|---|---|---|---|---|
| `choice` | 목록에서 하나 고르기 | `{ 라벨: 설명 }` | `choice`, `probabilities{라벨:p}`, `confidence` | 옵션 **최대 255** |
| `score` | 순서 있는 루브릭 점수 | `["레벨0", "레벨1", …]` | `score`(확률 가중 실수), `legend`, `probabilities`, `confidence` | 레벨 **2–10** |
| `noul` | 참/거짓 확률 | `{ "true": …, "false": … }` (선택) | `noul` (0–1) | **confidence 필드 없음** |

- 모든 질문은 `type` + `instructions` 필수, `criteria` 는 의미 보강
- choice 설명은 문자열로 시작하고, **자주 헷갈리는 옵션은 객체 형식**(`what`, `not_for`, `examples`)으로 경계를 준다 (JS 타입상 설명값은 string | object | array | null)
- 열린 질문에는 `"other"` / `"none"` 옵션을 반드시 넣는다 — 없으면 모든 입력이 가장 가까운 옵션으로 **강제 배정**된다

응답 예 (choice):

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "faq": { "type": "choice", "choice": "pricing", "confidence": 0.81,
             "probabilities": { "pricing": 0.88, "setup": 0.12, "none": 0.0 } }
  },
  "usage": { "input_tokens": 296, "output_tokens": 20 }
}
```

오류: `401` 키 오류 · `422` 요청 검증 실패 · `429` 속도 제한 · `529` 과부하 — 429/529 는 지수 백오프 재시도.

### SDK (참고 — 샘플에서는 쓰지 않는다)

- JS `@typesafe-ai/sdk` (Node **20+**), `new TypeSafeClient()` → `client.systemOne({ state, questions })`, 헬퍼 `choice()`
  기본값: baseURL `https://api.typesafe.ai`, model `jev-latest`, timeout **10000ms**, retry maxRetries 2 · backoff 500→5000ms · jitter 0.25 · `Retry-After` 존중(≤60s)
- Python `typesafe-sdk` (3.10+) — `TypeSafeClient`, `Choice`, `Noul`, `Score`
- **이 저장소의 키 위치**: `.secret/jev.json` (`{ "api_key": … }`) — 커밋되는 것은 키 없는 템플릿 `.secret/jev.json.tmp` 뿐 (`.gitignore`: `**/.secret/*`, `!**/.secret/*.tmp`). 샘플은 `TYPESAFE_API_KEY` env 를 우선하고 없으면 이 파일을 읽는 식으로 둘 다 받는다
- 둘 다 env `TYPESAFE_API_KEY` 를 읽는다. JS 는 브라우저 사용을 `dangerouslyAllowBrowser` 로만 허용 — **키는 서버 전용**
- 이 저장소 샘플은 **의존성 0 · Node 18+** 이므로 SDK 대신 내장 `fetch` 로 REST 직접 호출 (SDK 도입 = P1, `sample-portability-constraints.md`). SDK 의 재시도 기본값은 직접 구현의 기준값으로 삼는다
- `system-one-adapter-python` — 같은 인터페이스로 OpenAI/Anthropic/Gemini 를 호출하는 비교용 어댑터. "Jev vs LLM" 정확도·지연 비교 실험에 쓸 수 있다

## 3. confidence — 두 번째 판정 축

- choice/score 에 대해 확률 분포가 한 옵션에 **얼마나 몰렸는지**를 0–1 로 요약한 통계. 1 = 한 옵션에 전부, 0 = 균등
- 공식 예(3지선다): `(3 × 최대확률 − 1) / 2` → 일반화하면 `(n·pmax − 1)/(n − 1)` 로 **추정**(문서 미명시). 옵션 수가 많을수록 같은 pmax 라도 confidence 가 높게 나온다는 점에 유의
- 공식 권장 3구간 (도메인별로 반드시 재조정):

| 구간 | 권장 동작 |
|---|---|
| **> 0.9** | 자동 처리 |
| **0.5 – 0.9** | 조심스럽게 — 사용자 확인 또는 검토 표시 |
| **< 0.5** | 사람에게 넘기거나 되묻기 |

- **위험 비례 임계값**: 되돌릴 수 없는 동작(발신·결제·종료)일수록 더 높은 임계값. 읽기 전용은 낮게
- noul 은 confidence 가 없다 → `noul` 값 자체를 0.5 에서 얼마나 먼지로 해석 (예: ≥0.85 참, ≤0.15 거짓, 사이 = 불확실)

## 4. 공식 패턴

| 패턴 | 요지 | FAQ 봇에서의 쓰임 |
|---|---|---|
| Speculative Fan-Out | 필요할지 모르는 질문까지 한 번에 보내고 코드가 고른다 | FAQ 매칭 + 상담원 요청 + 불만 점수 + 개인정보 포함 여부를 **1회 호출**로 |
| Confidence-Gated Routing | confidence 를 두 번째 축으로 | 즉답 / 되묻기 / 상담원·LLM 폴백 3갈래 |
| Composite Scoring | 여러 차원을 하나의 점수로 | 에스컬레이션 우선순위 |
| Intent Routing | 싼 분류기로 핸들러 선택 | 결정적 핸들러(FAQ 고정답) ↔ LLM(04 봇) ↔ 사람 |

## 5. 톡브릿지 간편 FAQ 자동응답 — 설계 기준

Jev 는 **답을 쓰지 않고 고른다.** 그러므로 FAQ 봇 = "사람이 미리 쓴 정답 카드" + "Jev 가 카드 id 를 고름" + "confidence 로 발신 여부 결정".

```
고객 메시지(kind:"message") ─▶ 가드 G1·G2 ─▶ Jev 1회 호출 (fan-out)
                                                 ├ faq: choice(FAQ id… + "none")
                                                 ├ wants_human: noul
                                                 └ frustration: score(3단계)
   wants_human ≥ τ  또는  frustration 최상단 ─▶ 상담원 연결 안내 + 봇 정지 (G6)
   faq = none  또는  confidence < 0.5        ─▶ 폴백 (상담원 / 04 식 LLM)
   0.5 ≤ confidence < τ_auto                 ─▶ 되묻기 "혹시 ○○ 문의이신가요?" (상위 2개 제시)
   confidence ≥ τ_auto (기본 0.9)            ─▶ 해당 FAQ 카드의 **고정 답변** 발신
```

설계 규칙 (검수 체크리스트의 근거):

1. **답변 본문은 사람이 쓴 카드에서만** — Jev 출력은 카드 id 뿐. id → 카드 매핑이 없거나 비활성이면 발신하지 않고 폴백
2. choice 에 **`none`(해당 없음) 옵션 필수**. 카드가 255개를 넘으면 계층 분류(카테고리 choice → 카드 choice, 2회 호출 또는 카테고리별 질문 fan-out)
3. 카드 설명(criteria)은 "고객이 묻는 방식" 으로 — 제목만 넣지 말고 대표 질문 예시. 헷갈리는 카드쌍은 `not_for` 로 경계
4. 임계값은 설정값(`τ_auto`, `τ_confirm`)으로 노출하고 판정 결과(choice·confidence·top-2 확률·model 버전)를 모니터에 남긴다 — 운영자가 임계값을 데이터로 조정할 수 있어야 한다
5. **state 는 구조화**: `{ message: 최신 고객 발화, recent: [최근 몇 턴], channel: "kakao" }` — 같은 세션만 (04 세션 경계 규칙 그대로)
6. 되묻기 후 고객의 "네/아니오" 는 다음 턴에서 noul 로 판정 (`"고객이 제시한 FAQ 주제가 맞다고 확인했다"`)
7. 오류(401/422/429/529/timeout)는 **조용히 실패하지 않는다** — 재시도 소진 시 G7 안내 문구 + 상담원 연결. 401/422 는 재시도하지 않는다
8. 04 의 G1~G9 가드는 그대로 전부 적용 (특히 G1 echo 무시, G2 저널 재생, G5 속도 제한, G8 dry-run 기본)
9. `TYPESAFE_API_KEY` 는 `.env` 전용, 로그·화면·오류 메시지에 노출 금지, 브라우저로 내려보내지 않는다
10. 비용·지연 기록: `usage.input_tokens` 와 왕복 ms 를 로그에 — 벤더 주장(70–500ms)을 **실측으로 교체**하는 근거

## 6. 실측 (2026-09-29 · jev-1.13.0 · Windows 11 · 한국에서 호출)

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| U1 | **한국어 정확도** | ✅ 의도 45건 1순위 **98%** · 단계 대답 22건 **100%** · 임계값 0.8/0.5 에서 **자동 답변 오답 0** · 오타(`환뷸`)·구어체·줄임말·인젝션 문장 모두 처리 | 05 `npm run eval` |
| U2 | state 크기 · 질문 수 | 질문 **7개**(choice 5 · noul 2 · score 1) · 입력 3.4k 토큰까지 문제 없음. 상한은 아직 미확인 | 05 시뮬레이터 |
| U3 | 속도 제한 | 동시 4개 × 67건 연속 호출에서 429 없음. 수치 상한은 미확인 | eval |
| U4 | 버전 | `jev-latest` → 응답 `model: "jev-1.13.0"`. 헤더 `x-typesafe-request-id` 제공 — 로그에 남긴다 | probe |
| U5 | **지연** | 질문 1개 170~230ms · 질문 6~7개 180~350ms · eval p50 **205ms** / p95 280ms / max 369ms — 질문 수에 거의 무관 (병렬 평가 확인) | eval |
| U6 | choice 설명 객체 | ✅ `{ what, examples, not_for }` 그대로 200 · 선택지 1개짜리 choice 도 422 없이 200 (서버 검증은 느슨 — 샘플이 스스로 2개 이상을 경고) | probe |

실측으로 알게 된 것 (설계 규칙에 반영):

- **직전 봇 질문을 state 에 넣으면** 짧은 대답이 정확히 분류된다 — `"한달 250명정도?"` → `월 101~300명` 99%. 판정 지시에 계산 규칙을 적으면 따른다(`"하루 30명"` × 30 → 월 501~1,000명)
- **Speculative fan-out 이 실용적이다** — 시나리오마다 첫 질문을 미리 넣어도 지연이 그대로라, 첫 메시지에 답이 있으면 단계를 건너뛸 수 있다 (`"도메인이 없어요"` → 없음 96%). 추측이므로 자동 답변 기준으로 엄격하게 적용
- **확신도 분포가 양극단**이다 — 대부분 95~100% 이거나, 헷갈리면 70~85% 로 뚜렷하게 내려온다. 그래서 0.8 기준이 한국어에서 오답 0 · 되묻기 4% 로 잘 갈랐다 (공식 권장 0.9 보다 낮춰도 안전했던 근거 — 규칙이 바뀌면 재측정)
- 예시가 빈약한 카드(`디스코드 있나요?` 79~82%)는 경계에 걸린다 → 카드 `examples` 가 확신도를 가장 크게 움직인다
- noul `wants_human`: "상담사랑 직접 얘기하고 싶어요" 0.97 · 일반 문의 0.06~0.16 · 짜증 문장 0.5~0.63. score `frustration`: 짜증 문장 1.89~1.91/2 · "계속 401이 떠요" 0.9~1.0 → 1.5 기준이 적절
- 인사와 감사는 **다른 내장 선택지**로 둬야 한다 — 하나로 두면 "고마워요" 에 "안녕하세요" 로 답한다

남은 미확인: state·질문 수의 공식 상한, 429 수치, 데이터 보관 정책(고객 메시지가 외부로 나간다 — 05 README §5 에 고지)
