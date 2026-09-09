# TalkBridge 파트너 연동 가이드 · 샘플

카카오 상담톡을 자체 시스템·AI 에이전트에 연결하는
[TalkBridge](https://api.talkbridge.io/) 의 **파트너용 참조 구현 모음**입니다.

파트너가 고객사 구축에 들어가는 시간을 줄이고, 코드 가이드로 삼을 수 있도록
공개 매뉴얼을 실측으로 검증해 정리하고, 연결 방식별로 동작하는 샘플을 제공합니다.

## 구성

| 경로 | 내용 |
|---|---|
| [`docs/`](docs/) | 공개 매뉴얼 요약 — 도메인 모델, API·CLI 스펙, 요금, 온보딩 |
| [`sample-project/`](sample-project/) | 연결 방식별 동작하는 샘플 (멀티 프로젝트) |

## 샘플

| # | 샘플 | 이런 때 쓰세요 | 연결 방식 | 공개 도메인 | 상태 |
|---|---|---|---|---|---|
| 01 | [`sample-project/01-cli-gateway`](sample-project/01-cli-gateway/) | CLI 로 **기본 채팅상담 화면**을 빠르게 만들고 싶을 때 — 노트북·사내망에서 도메인 없이 바로 검증, 사람이 답하는 상담 툴의 출발점 | CLI + 로컬 게이트웨이 | **불필요** | ✅ 완료 |
| 02 | [`sample-project/02-api-webhook`](sample-project/02-api-webhook/) | 이미 운영 중인 **서버·백엔드에 상담을 붙일 때** — REST 로 조회·발신, 웹훅으로 영속 전달·재시도. 운영 전환·다중 인스턴스의 기준 구현 | REST API + 호스티드 웹훅 | 필요 | ✅ 완료 |
| 03 | [`sample-project/03-cli-knowledge-graph`](sample-project/03-cli-knowledge-graph/) | **과거 상담을 분석하거나 자동 상담의 근거 데이터**를 만들고 싶을 때 — 고객→문의→응답 그래프를 Cypher 프리셋으로 조회, 온톨로지 설계 참고 | 01 + 상담지식 그래프 프리셋 조회 (AI 미사용) | **불필요** | ✅ 완료 |

[![01-cli-gateway 상담 화면](sample-project/01-cli-gateway/docs/screenshot.png)](sample-project/01-cli-gateway/)

01 은 게이트웨이 데몬이 **내 쪽에서 밖으로** 나가 붙기 때문에 공인 도메인·DNS·TLS·
방화벽 설정이 하나도 필요 없습니다. 사내망이나 노트북에서 바로 검증할 수 있습니다.
02 는 TalkBridge 가 **내 공개 엔드포인트로 들어오는** 방식이라 그 인프라가 필요한 대신,
전달이 영속되고 재시도가 넉넉합니다.

03 은 **톡브릿지 CLI 로 상담 Agent 기능을 확장하고자 할 때** 활용할 수 있는 샘플입니다 — 톡브릿지가 부가 기능인
**상담 분석 Agent** 로 어떻게 확장될 수 있는지를 보여주는 데모성 구현입니다. 그래프 기능은 상담 내역으로 온톨로지를 구축할 때
참고할 수 있는 연구 샘플이며, CLI 가 파트너사의 온톨로지를 위해 공식 제공하는 기능은 아닙니다. CLI 가 설치된 곳에서
**온디바이스로 가볍게 로컬 실험**을 할 수 있고, 실 운영에서는 여기서 확인한 스키마·조회 패턴을 바탕으로 규모에 맞는 그래프 DB 를
별도 구축·운영하는 것을 권장합니다.

[![03 상담지식 온톨로지 그래프](sample-project/03-cli-knowledge-graph/docs/screenshot-graph.png)](sample-project/03-cli-knowledge-graph/#talkbridge-cli--그래프-확장편)

03 의 그래프는 톡브릿지 이용 매뉴얼을 베이스로 테크 문의를 가상으로 연출한 데모입니다. 고객명은 개인정보라 TalkBridge 가 제공하지 않으며,
대화 중 파악되면 고객 메모 저장 기능으로 파트너가 관리합니다. 그래프 엣지를 따라 전문 분석이나 자동 상담 대응에 활용할 수 있습니다 —
[TalkBridge CLI — 그래프 확장편](sample-project/03-cli-knowledge-graph/#talkbridge-cli--그래프-확장편).

자세한 비교와 선택 기준은 [`sample-project/README.md`](sample-project/README.md) 를 보세요.

## 시작하기

```bash
# CLI 설치 + 로그인
npm install -g @blumn-ai/talkbridge-cli    # dev 채널은 @blumn-dev/talkbridge-cli
talkbridge login
talkbridge whoami                           # 브랜드 키 확인

# 01 샘플 실행
cd sample-project/01-cli-gateway
cp .env.example .env                        # TB_BRAND, TB_WEBHOOK_SECRET 채우기
npm run doctor                              # 진단
npm run gateway:setup && npm run gateway:start
npm start                                   # http://127.0.0.1:8787/
```

## 맞춤 상담 Agent 설계 — 블룸 정원의 하네스

이 저장소에는 **톡브릿지를 이해하는 하네스, 블룸 정원의 하네스**가 탑재되어 있습니다 ([`harness/`](harness/)).
하네스는 정원이고, 그 안에서 일하는 전문가 에이전트는 꽃입니다. 정원을 가꾸는 관리인이 **정원지기**입니다.
수신 웹훅 계약, CLI 스펙, 샘플 이식 제약 같은 도메인 지식과 그것을 기준으로 검수하는
전문가 에이전트가 들어 있어, 파트너가 샘플을 고객 맞춤으로 바꾸거나 AI 상담 Agent 를 얹을 때
**톡브릿지 규칙을 어기지 않았는지 설계 단계에서 점검하고 테스트**해 볼 수 있습니다.

Claude Code 에서 [정원의 하네스 플러그인 (harness-kakashi)](https://github.com/psmon/harness-kakashi)을 설치하면 바로 쓸 수 있습니다.

```
/plugin marketplace add psmon/harness-kakashi
/plugin install harness-kakashi@harness-kakashi-skills
```

```
/harness-creator            ← 정원지기를 부른다 (현재 상태와 사용법 안내)
/harness-creator 전체 점검해  ← 3 전문가가 샘플 전체를 검수하고 종합 보고
/harness-creator 변경 점검해  ← 내가 고친 부분만 관련 전문가가 검수
/harness-chakra             ← 작업 후 토큰(차크라) 사용량 감사
```

한 번 부른 뒤에는 슬래시 없이 `보안 점검해`, `문서 검증해` 처럼 바로 말하면 됩니다.

| 전문가 | 보는 것 |
|---|---|
| 웹훅 경비대장 | 서명 검증 · 시크릿 취급 · 멱등 · 인젝션 · `agent` echo 무한 루프 |
| 이식 감독관 | 의존성 0 · Node 18+ · Windows/macOS/Linux · dev/prod 채널 · README 와 실행 일치 |
| 문서 대조관 | 공개 매뉴얼 요약 ↔ README ↔ 코드의 스펙 드리프트 |
| 개선 수집관 | 실측으로 드러난 CLI·API·문서의 결함·제약을 **다음 개선 예고 스펙**으로 — [`harness/knowledge/cli-feat/`](harness/knowledge/cli-feat/) |

CLI 의 알려진 한계와 지금 쓸 우회, 그리고 다음 버전에서 바뀔 내용은(v1.0.0 기준 예고 10건 중 7건이 v1.1.0 에 구현됨)
[`harness/knowledge/cli-feat/README.md`](harness/knowledge/cli-feat/README.md) 에 한 표로 있습니다. 설계 전에 한 번 훑어보세요.

**커스텀 개발 요청 예시** — 샘플을 출발점으로 Claude Code 에 이렇게 요청하면, 하네스의 도메인 지식(웹훅 계약·CLI 스펙·이식 제약)을 기준으로 구현하고 점검합니다.

```
sample-project/01-cli-gateway 에 상담 분배 기능을 추가해줘
  → 새 상담(reference)이 오면 담당 상담원에게 라운드로빈으로 배정하고 화면에 담당자를 표시

sample-project/01-cli-gateway 에 업무시간 외 자동 응답을 넣어줘
  → schedule 밖 시간에 message 가 오면 안내 문구를 send 하고, agent echo 는 응답 대상에서 제외

sample-project/01-cli-gateway 를 기반으로 AI 상담봇을 만들어줘
  → webhook.js 본문 보강 직후 LLM 호출, 사람 이관 키워드가 오면 상담원 화면으로 넘김

sample-project/01-cli-gateway 의 인메모리 저장소를 SQLite 로 바꿔줘
  → delivery_id UNIQUE 멱등 테이블 + 메시지 테이블 (샘플 → 운영 전환의 첫 단계)
```

구현이 끝나면 `변경 점검해` 한 번으로 `agent` echo 필터 누락(무한 루프), 서명 검증 우회,
활성 세션 밖 발신 같은 톡브릿지 규칙 위반을 커밋 전에 잡습니다.
필요한 전문가를 더 심으려면 `새 에이전트 추가해` 라고 하면 됩니다.

하네스 구조와 검수 기준: [`harness/docs/README.md`](harness/docs/README.md)

## 참고

- 공개 매뉴얼: <https://api.talkbridge.io/>
- 매뉴얼 요약: [`docs/talkbridge-manual-digest.md`](docs/talkbridge-manual-digest.md)
- 기술 문의: TalkBridge 디스코드 커뮤니티 / `help@talkbridge.io`
