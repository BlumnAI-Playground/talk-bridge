# 04 자동응대봇 — 개발 가이드 · 데모 워크스루

> 샘플 소개·빠른 시작은 [`../README.md`](../README.md). 이 문서는 **내부 동작과 구성 절차**를 코드 기준으로 설명하고,
> 페르소나 설정부터 시나리오 추가, 시뮬레이터 데모까지 실제 화면으로 따라갑니다.
> 데모는 전부 **시뮬레이터·dry-run** 으로 진행했습니다 — 카카오로 나가는 발신은 없습니다.

| | |
|---|---|
| 검증 환경 | `talkbridge-dev` v1.1.0 · brand `oty3kdyxmzlthyz-1a1637` · Windows 11 · Node 22.18 · 2026-09-16 |
| 모델 | OpenAI Responses API · `gpt-5.6-terra` · reasoning `medium` |
| 캡처 방법 | Playwright 로 별도 인스턴스(`PORT=8793`, `TB_BOT_FILE=<임시 파일>`)를 띄워 진행 — 운영 규칙(`data/bot.json`)은 건드리지 않음 |

---

## 1. 전체 구조

### 1.1 컴포넌트

```mermaid
flowchart LR
  K[고객<br/>카카오톡] -->|문의| TB[TalkBridge 서버]
  TB -->|SSE| GW[talkbridge-dev gateway<br/>내 PC 데몬]
  GW -->|서명된 POST /webhook<br/>본문 없는 신호| WH[server/webhook.js]
  WH -->|kind:message| BOT[server/bot.js<br/>봇 엔진]
  WH -->|kind:agent echo| BOT
  BOT -->|rooms --user --json| CLI[server/cli.js]
  BOT -->|POST /responses| OAI[(OpenAI<br/>Responses API)]
  BOT -->|실발신 ON: send| CLI
  CLI -->|CLI| TB
  RULES[(data/bot.json<br/>규칙)] --> BOT
  UI[public/<br/>규칙 편집 · 시뮬레이터 · 모니터] <-->|/api/bot/* · SSE| IDX[server/index.js]
  IDX --> RULES
  IDX --> BOT
```

| 파일 | 역할 |
|---|---|
| [`server/webhook.js`](../server/webhook.js) | 01·03 과 같은 수신 핸들러(서명 검증 → 즉시 200 → 멱등 → 본문 보강) + **봇 훅 3곳** |
| [`server/bot.js`](../server/bot.js) | 봇 엔진 — 지침 조립, 세션 이력, 한 턴 실행, 가드, 시뮬레이터 |
| [`server/openai.js`](../server/openai.js) | Responses API 호출 (`json_schema` strict · `reasoning.effort` · `store:false`) |
| [`server/rules.js`](../server/rules.js) | 규칙 정규화 · 저장(원자적 쓰기) · 기본 모델 계산 |
| [`server/config.js`](../server/config.js) | `.env` 로더 · OpenAI 키 탐색 · 봇 동작 기본값 |
| [`server/index.js`](../server/index.js) | HTTP 라우팅 · 부팅 백필(재생 가드용 `lastSeq`) |
| [`public/app.js`](../public/app.js) | 규칙 편집기 · 시뮬레이터 · 실시간 모니터 (바닐라 JS) |
| [`data/demo-bot.json`](../data/demo-bot.json) | 데모 규칙 — 톡브릿지 상담센터(요금·연동·오류) |

### 1.2 규칙 데이터 모델

`data/bot.json` 하나가 봇의 전부입니다. 웹에서 저장하면 [`rules.js` `normalize()`](../server/rules.js) 가 길이·id·enum 을 정리해 씁니다.

```jsonc
{
  "settings":  { "enabled": true, "live": false, "model": "", "reasoningEffort": "", "maxReplyChars": 350, "historyLimit": 30 },
  "persona":   { "name": "브릿지봇", "tone": "…", "instructions": "…" },
  "knowledge": [ { "id": "plans", "title": "요금제", "content": "…" } ],
  "scenarios": [ {
      "id": "pricing", "name": "요금제 안내", "enabled": true,
      "when": "가격·요금·과금 기준…이 궁금할 때",         // 모델이 의도 판별에 쓴다
      "keywords": ["요금", "가격"],                     // 있으면 "후보" 힌트 — 확정은 맥락
      "steps": [ { "id": "volume", "instruction": "한 달에 몇 명…묻는다", "collect": "월예상고객수" } ],
      "knowledge": "규모를 모르면 Free 로 검증 권유…",   // 이 시나리오에서만 쓰는 지식
      "onComplete": "stay"                             // stay | handoff | end
  } ],
  "handoff":   { "keywords": ["상담원"], "message": "…", "errorMessage": "…" }
}
```

`settings.model` / `reasoningEffort` 가 비어 있으면 `.env` 의 `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` 가 쓰입니다 ([`rules.js` `effectiveModel()`](../server/rules.js)).

---

## 2. 한 턴이 처리되는 순서

### 2.1 라이브 경로 (게이트웨이 → 카카오)

```mermaid
sequenceDiagram
  autonumber
  participant GW as gateway
  participant WH as webhook.js
  participant BOT as bot.js
  participant CLI as cli.js (talkbridge-dev)
  participant OAI as OpenAI

  GW->>WH: POST /webhook {userKey, kind:"message", seq}
  WH-->>GW: 200 (즉시)
  WH->>CLI: rooms --user --json (본문 보강)
  WH->>BOT: onCustomerMessage(userKey, msg)
  Note over BOT: 가드: 봇 꺼짐? 부팅 전 seq? 180초 초과? 방 정지?
  BOT->>BOT: 디바운스 2.5s (끊어 보낸 줄 모으기)
  BOT->>CLI: rooms --user --json (같은 세션 이력)
  BOT->>BOT: transcriptFor() → transcript + pending
  BOT->>BOT: buildInstructions(rules, state, pending)
  BOT->>OAI: POST /responses (instructions + input, json_schema)
  OAI-->>BOT: {reply, scenario_id, step_index, collected, scenario_completed, handoff, reason}
  BOT->>BOT: 상태 갱신·보정 (없는 시나리오/단계 교정)
  alt 실발신 ON
    BOT->>CLI: send --to userKey --text reply
    CLI-->>GW: (잠시 뒤) kind:"agent" echo
    GW->>WH: POST /webhook {kind:"agent", seq}
    WH->>BOT: onAgentEcho() — 봇 답장과 본문 일치 → 통과
  else dry-run
    BOT->>BOT: botReplies 에만 기록 (모니터 점선 말풍선)
  end
  BOT-->>WH: broadcast('bot', …) → 모니터 SSE
```

코드 위치: [`bot.js` `onCustomerMessage()`](../server/bot.js) → `runLiveTurn()` → `transcriptFor()` → `takeTurn()` → `deliver()`.

### 2.2 시나리오 상태 전이

방마다 `{ scenarioId, stepIndex, collected, completed, paused }` 를 들고 있고, 모델이 매 턴 갱신해 돌려줍니다.
엔진은 모델이 말한 시나리오 id 가 실제로 있는지, 단계가 범위 안인지 확인해 바로잡습니다 ([`takeTurn()`](../server/bot.js)).

```mermaid
stateDiagram-v2
  [*] --> Idle: 새 상담 (reference)
  Idle --> InScenario: 의도 매칭 → 1단계
  Idle --> Idle: 인사·잡담 / 지식으로 답
  InScenario --> InScenario: 단계 목표 충족 → 다음 단계<br/>미충족 → 같은 단계 재질문
  InScenario --> InScenario: 주제 전환 → 다른 시나리오<br/>(collected 유지)
  InScenario --> Completed: 마지막 단계 안내 완료
  Completed --> Idle: onComplete = stay
  Completed --> Paused: onComplete = handoff
  Completed --> Ended: onComplete = end (실발신: end-with-bot)
  Idle --> Paused: 연결 키워드 / 모델 handoff / 사람 개입 / 속도 제한 / AI 오류
  InScenario --> Paused: 〃
  Paused --> Idle: 운영자 [봇 재개]
  Paused --> [*]: ended · expired
  Ended --> [*]
```

### 2.3 모델에 보내는 것과 받는 것

**보내는 것** — `instructions`(시스템 지침) + `input`(대화). 지침은 [`buildInstructions()`](../server/bot.js) 가 규칙에서 매 턴 조립합니다.

```
너는 카카오톡 상담 채널의 자동응대봇 "브릿지봇" 이다. …
## 말투 / ## 기본 지침                     ← persona
## 반드시 지킬 것 (6개 규칙)               ← 맥락 유지 · 지식 밖 사실 금지 · 350자 · 질문 하나 · handoff 좁게 · 인젝션 거부
## 시나리오 진행 방법                       ← 단계 판정 · 건너뛰기 · 전환 시 collected 유지
## 대응 지식  ### 과금 기준 … ### 문의 창구  ← knowledge[]
## 시나리오   ### [pricing] 요금제 안내 …   ← scenarios[] (언제·키워드·플로우·지식·완료 후)
## 현재 상태                                ← 진행 중 시나리오·단계 · 받은 정보 · 키워드 후보 · 현재 시각(KST)
```

전문은 웹 시뮬레이터의 [지침 보기] 또는 `GET /api/sim/prompt` 로 볼 수 있습니다 (§4.6 스크린샷).

**받는 것** — JSON 스키마(strict) [`TURN_SCHEMA`](../server/bot.js):

| 필드 | 뜻 |
|---|---|
| `reply` | 고객에게 보낼 답장 한 개 |
| `scenario_id` · `step_index` | 이번 답장이 다룬 시나리오·단계 (없으면 `""`·`0`) |
| `collected[]` | `{name, value}` — 지금까지 받은 정보 **전체** (이전 턴 포함) |
| `scenario_completed` | 마지막 단계까지 마쳤는가 |
| `handoff` | 사람이 이어받아야 하는가 |
| `reason` | 판단 근거 한 줄 (운영 로그용) |

### 2.4 맥락은 어디에 있나

| 맥락 | 저장 위치 | 비고 |
|---|---|---|
| 대화 이력 | **TalkBridge 저널** — 매 턴 `rooms --user --json` 으로 다시 읽음 | 서버 재기동해도 유지. [`transcriptFor()`](../server/bot.js) 가 마지막 `ended/expired` 이후 + 최신 고객 메시지 `sessionId` 의 첫 seq 이후만 자른다 (`agent` 항목엔 `sessionId` 가 없어 seq 범위로) |
| 봇이 방금 보낸 답장 · dry-run 답장 | 방 상태 `botReplies` | 저널에 아직 없거나(발신 직후) 영원히 없는(dry-run) 답장을 시각 순으로 끼워 넣는다 |
| 진행 상태 | 방 상태 `{scenarioId, stepIndex, collected}` (인메모리) | 재기동 시 초기화 — 이력은 남으므로 모델이 대화로부터 다시 추정한다. 운영은 DB/Redis (README §8) |
| OpenAI 쪽 | 없음 — `store:false` | 대화를 OpenAI 저장소에 남기지 않는다 |

---

## 3. 자동응답 가드

```mermaid
flowchart TD
  A[webhook kind:message] --> B{settings.enabled?}
  B -- 아니오 --> X[무시]
  B --> C{seq ≤ 부팅 시점 lastSeq?}
  C -- 예 --> X2[skip: 저널 재생]
  C --> D{메시지 시각 > TB_BOT_MAX_AGE_SEC?}
  D -- 예 --> X2
  D --> E{방 paused?}
  E -- 예 --> X3[skip: 정지 사유 로그]
  E --> F[디바운스 TB_BOT_DEBOUNCE_MS]
  F --> G{방 busy?}
  G -- 예 --> H[dirty 표시 → 끝난 뒤 재실행]
  G --> I{1분 5회 초과?}
  I -- 예 --> P[pause: 속도 제한]
  I --> J{pending 고객 메시지 있음?}
  J -- 없음 --> X4[이미 답함]
  J --> K{연결 키워드 포함?}
  K -- 예 --> P2[연결 안내 발신 · pause]
  K --> L[OpenAI 호출]
  L -- 오류 --> M[errorMessage 발신 · pause]
  L --> N[reply · handoff · end 판정]
```

| 가드 | 코드 | 없으면 |
|---|---|---|
| `agent` echo 로 응답 생성 금지 | [`webhook.js`](../server/webhook.js) `case 'message'` 분기에서만 `onCustomerMessage` | 내 발신이 내 발신을 부르는 무한 발신 |
| 저널 재생 — 부팅 `lastSeq` + 나이 제한 | [`index.js`](../server/index.js) `rememberBootSeq()` · [`onCustomerMessage()`](../server/bot.js) | 게이트웨이 첫 기동 시 과거 문의 전부에 답장 (이번 검증에서 #1~#11 재생분 0건 응답) |
| 사람 개입 판별 | [`onAgentEcho()`](../server/bot.js) — `botReplies` 에 없는 본문이면 pause; 화면 `/api/send` 는 즉시 pause | 상담원과 봇이 동시에 답함 |
| 세션 경계 초기화 | [`onSessionBoundary()`](../server/bot.js) ← `reference` / `ended` / `expired` | 지난 상담의 단계·정지가 새 상담에 남음 |
| 실발신 기본 OFF | `demo-bot.json` `live:false` · 켤 때 확인창 ([`app.js`](../public/app.js)) | 설정 중 오발신 |

---

## 4. 워크스루 — 페르소나부터 시나리오 추가, 시뮬레이터 데모까지

> 아래 화면은 별도 인스턴스(`PORT=8793`, 임시 규칙 파일)에서 진행했습니다. 실발신 OFF, 카카오 발신 없음.
> 새로 추가하는 시나리오는 **"데모 신청"** — 회사명 → 도입 시기 → 이메일을 받아 접수하고 상담원에게 넘기는 3단계 플로우입니다.

### 4.1 봇 페르소나

`구성 → 봇 페르소나`. 이름·말투·기본 지침을 적습니다. 사실 정보는 여기가 아니라 [대응 지식]에, 절차는 [시나리오]에 둡니다.

![봇 페르소나 편집](walkthrough/01-persona.png)

→ 지침의 머리 부분(`너는 … "브릿지봇" 이다` · `## 말투` · `## 기본 지침`)이 됩니다.

### 4.2 대응 지식 카드 추가

`구성 → 대응 지식 → ＋ 지식 추가`. 제목 + 내용 카드 하나가 지침의 `### 제목` 절 하나가 됩니다. 봇은 **여기 있는 사실만** 말합니다.
새 시나리오를 위해 "데모·도입 상담" 카드(데모는 무료, 담당자가 일정 조율)를 추가했습니다.

![대응 지식 카드 추가](walkthrough/02-knowledge.png)

### 4.3 시나리오 추가

`시나리오 → ＋ 추가`. 위쪽 플로우 미리보기가 입력을 바로 따라옵니다.

| 항목 | 입력값 |
|---|---|
| 이름 · id | 데모 신청 · `demo-request` |
| 언제 (문의 의도) | 도입을 검토 중이거나 데모·미팅·견적을 요청할 때 |
| 키워드 | 데모, 도입, 미팅, 견적, 검토 |
| 1단계 | 회사명과 업종을 묻는다 → 받을 정보 `회사명` |
| 2단계 | 도입 희망 시기와 예상 상담 규모를 묻는다 (앞에서 말했으면 건너뛴다) → `도입시기` |
| 3단계 | 연락받을 이메일을 묻고, 접수 내용을 요약한 뒤 담당자가 일정을 잡아 연락한다고 안내한다 → `이메일` |
| 완료 후 | **상담원 연결** |
| 시나리오 지식 | 데모는 무료. 이메일이 없다고 하면 카카오톡으로 연락드린다고 안내한다. |

![시나리오 추가 — 이름·의도·키워드](walkthrough/03-scenario-new.png)

![시나리오 추가 — 플로우 단계·완료 후 동작](walkthrough/04-scenario-steps.png)

### 4.4 저장

[저장] (또는 Ctrl+S). 서버가 [`normalize()`](../server/rules.js) 로 정리해 `data/bot.json` 에 쓰고, 확인할 점이 있으면 `warnings` 로 돌려줍니다
(예: 의도·키워드가 모두 없는 시나리오, 단계 없는 시나리오). 시뮬레이터로 보내면 자동 저장됩니다.

![저장 완료](walkthrough/05-saved.png)

### 4.5 상담원 연결 · 모델 설정

- **상담원 연결**: 연결 키워드는 모델을 부르지 않고 결정적으로 처리합니다(비용 0, 즉시). AI 오류 시 안내 문구를 비우면 오류 때 아무것도 보내지 않습니다.
- **모델 · 동작 설정**: 모델·추론 강도(비우면 `.env` 기본값), 답장 최대 글자 수, 맥락 메시지 수. 키는 마스킹된 출처만 보입니다.

![상담원 연결 설정](walkthrough/06-handoff.png)

![모델 · 동작 설정](walkthrough/07-settings.png)

### 4.6 시뮬레이터 데모 — 새 시나리오 4턴

카카오 발신 없이 같은 엔진([`simulate()`](../server/bot.js))을 돌립니다. 아래 상태 칸이 매 턴 갱신됩니다.

| # | 고객 | 봇 | 엔진 판단 · 시간 |
|---|---|---|---|
| 1 | 안녕하세요, 도입 검토 중인데 데모를 볼 수 있을까요? | 안녕하세요! 무료 데모 신청을 도와드릴게요. 회사명과 업종을 알려주세요. | 데모 신청 **1/3** 시작 · 3.5s |
| 2 | 블룸커머스라고 쇼핑몰이에요 | 블룸커머스 쇼핑몰로 확인했어요. 도입을 희망하시는 시기는 언제인가요? | 2/3 · `회사명=블룸커머스 / 업종=쇼핑몰` · 4.0s |
| 3 | 다음 달쯤 시작하고 싶고 월 300명 정도요 | 다음 달 도입 희망, 월 300명 규모로 확인했어요. 연락받으실 이메일 주소를 알려주세요. | 3/3 · `도입시기=다음 달 / 월예상고객수=월 300명` · 3.3s |
| 4 | dev@example.com 으로 주세요 | 블룸커머스(쇼핑몰), 다음 달 도입 희망·월 300명 규모, dev@example.com으로 접수했어요. 무료 데모 일정은 담당자가 이메일로 연락드릴게요. | **완료 → 상담원 연결 (봇 정지)** · 3.8s |

![시뮬레이터 — 데모 신청 4턴, 완료 후 상담원 연결](walkthrough/08-simulator.png)

눈여겨볼 점:
- 2턴에서 "블룸커머스라고 쇼핑몰이에요" 한 마디로 `회사명` 과 `업종` 두 값을 뽑아 기록했습니다 (`collected` 는 자유 이름).
- 3턴에서 시기와 규모를 한 번에 받았습니다 — 단계 지침의 "앞에서 말했으면 건너뛴다" 가 동작.
- 4턴은 지식에 있는 "데모는 무료" 만 말하고 일정·비용을 지어내지 않았습니다.
- 완료 후가 `handoff` 라 봇이 정지했고, 이후 메시지에는 답하지 않습니다(운영에선 [실시간 모니터 → 봇 재개]).

**[지침 보기]** — 이 턴에 모델이 실제로 받은 지침입니다. `## 현재 상태` 에 `직전 답장이 3단계를 다뤘다 · 플로우 완료됨` 과 받은 정보 5개가 들어 있습니다.

![모델 지침 전문](walkthrough/09-prompt.png)

### 4.7 주제 전환 — 터미널 시뮬레이터

같은 규칙으로 `npm run sim` (OpenAI 만 호출):

```
고객 ▸ 요금이 궁금해요
봇   ◂ 한 달에 대략 몇 명의 고객을 상담하실 예정인가요?
       └ reply · 요금제 안내 1/3 (전환) · 2701ms · in 3120 / out 75 (추론 0)

고객 ▸ 한 달에 250명 정도요
봇   ◂ 하루에 응대한 고객 1명당 1건으로 계산돼요. 월 250명 규모라면 Pro 300을 추천드리며, 월 45,000원(VAT 포함 49,500원)에 300건을 이용하실 수 있어요.
       └ reply · 요금제 안내 2/3 · 정보 {"월예상고객수":"250명"} · 3134ms · in 3156 / out 157 (추론 25)

고객 ▸ 아 근데 저희 도메인이 없는데 연동은 뭘로 해야 돼요?
봇   ◂ 도메인이 없으시면 공인 주소 없이 연결 가능한 CLI+게이트웨이 방식이 적합해요. 지금은 빠른 연동 검증이 목표이신가요, 아니면 24시간 운영 서비스 구축이 목표이신가요?
       └ reply · 연동 방식 상담 2/3 (전환) · 정보 {"월예상고객수":"250명","공인도메인":"없음"} · 4252ms · in 3312 / out 182 (추론 37)
```

요금 → 연동으로 **시나리오를 전환**하면서 앞서 받은 `월예상고객수` 를 유지했고, "도메인이 없는데" 가 연동 시나리오 1단계(공인 도메인)를 채워 **2단계로 바로** 갔습니다.

### 4.8 실시간 모니터 (dry-run)

`실시간 모니터` 탭. 왼쪽 상담방은 CLI `rooms --json`, 가운데는 실제 대화, 위 띠는 이 방의 봇 상태, 오른쪽은 봇 활동 로그입니다.
실발신이 꺼져 있으면 봇 답장은 점선 말풍선(dry-run)으로만 표시되고 카카오로 나가지 않습니다.
아래 화면의 대화(#12~#17)는 이 문서 이전에 실채널에서 확인한 이력이며, 이 워크스루에서 새로 발신한 것은 없습니다.

![실시간 모니터 — 방별 봇 상태와 활동 로그](walkthrough/10-monitor.png)

버튼: **봇 정지/재개**(방 단위), **전송**(상담원 직접 답장 — 보내는 순간 그 방의 봇이 정지, 실제 발신·과금).

---

## 5. 서버 API 와 화면의 대응

| 화면 동작 | 요청 | 서버 |
|---|---|---|
| 규칙 로드 / 저장 / 데모 초기화 | `GET`·`PUT /api/bot/rules` · `POST /api/bot/rules/reset` | [`index.js`](../server/index.js) → [`rules.js`](../server/rules.js) |
| 시뮬레이터 보내기 / 초기화 / 지침 보기 | `POST /api/sim/message` · `POST /api/sim/reset` · `GET /api/sim/prompt` | [`bot.js`](../server/bot.js) `simulate()` `resetSim()` `previewInstructions()` |
| 상담방 · 대화 | `GET /api/rooms` · `GET /api/rooms/:userKey/messages` | [`cli.js`](../server/cli.js) `cliRooms()` `cliRoomMessages()` + 방별 봇 상태 |
| 봇 활동 · 정지/재개 | `GET /api/bot/activity` · `POST /api/bot/rooms/:userKey/pause|resume` | `recentActivity()` `pause()` `resume()` |
| 상담원 직접 답장 | `POST /api/send` | `pause()` 후 `cliSend()` |
| 실시간 갱신 | `GET /api/events` (SSE) — `inbound` · `bot` · `bot-state` · `rules` | [`sse.js`](../server/sse.js) |

상단 [봇 켜기]·[실발신] 스위치는 `settings.enabled` / `settings.live` 를 바로 저장합니다.

---

## 6. 직접 붙일 때 바꾸는 곳

| 하고 싶은 것 | 바꾸는 곳 |
|---|---|
| 우리 회사 지식·시나리오로 교체 | 웹에서 편집 후 `data/bot.json` — 또는 `data/demo-bot.json` 을 복사해 초기 규칙으로 |
| 모델·추론 강도 변경 | `.env` `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT`, 또는 웹 [설정] (규칙 단위 덮어쓰기) |
| OpenAI 호환 엔드포인트 | `.env` `OPENAI_BASE_URL` — Responses API 호환이어야 한다 ([`openai.js`](../server/openai.js)) |
| 답장 구조에 필드 추가 (예: 감정, 카테고리) | [`TURN_SCHEMA`](../server/bot.js) 에 필드 추가 → `takeTurn()` 에서 읽기 → `log()` detail 로 모니터에 노출 |
| 지식이 커져 지침이 무거워짐 | `buildInstructions()` 의 `## 대응 지식` 조립을 검색 결과(03 그래프·벡터)로 교체 |
| 규칙·상태를 DB 로 | `rules.js` `loadRules/saveRules`, `bot.js` `rooms` Map — README §8 |
| 상담시간 밖 안내 | `buildInstructions()` `## 현재 상태` 에 `schedule get` 결과를 넣고 시나리오 지침으로 처리 |

---

## 7. 재현 방법

```bash
# 격리 인스턴스 (운영 규칙·포트와 분리)
PORT=8793 TB_BOT_FILE=/tmp/walkthrough-bot.json npm start
#   PowerShell: $env:PORT='8793'; $env:TB_BOT_FILE="$env:TEMP\walkthrough-bot.json"; npm start

# 터미널 시뮬레이터 (같은 규칙 파일)
TB_BOT_FILE=/tmp/walkthrough-bot.json npm run sim -- "요금이 궁금해요" "한 달에 250명 정도요"

# 규칙 편집 + 시뮬레이터 3턴 스크린샷
npm run screenshot
```

이 워크스루의 화면은 Playwright 로 §4 순서를 그대로 자동화해 찍었습니다 — 규칙 입력(`input`/`textarea[data-path=…]`) → 저장 → 시뮬레이터 4턴 → 지침 보기 → 모니터.

## 8. 참고

- 샘플 README: [`../README.md`](../README.md) — 빠른 시작 · 안전장치 · 운영 전환 · 문제 해결
- 하네스 지식: [`../../../harness/knowledge/talkbridge-autoreply-bot.md`](../../../harness/knowledge/talkbridge-autoreply-bot.md) — 가드 등급표(G1~G9), 세션 경계 실측
- 웹훅 계약: [`../../../harness/knowledge/talkbridge-webhook-contract.md`](../../../harness/knowledge/talkbridge-webhook-contract.md)
- OpenAI Responses API: <https://platform.openai.com/docs/api-reference/responses>
