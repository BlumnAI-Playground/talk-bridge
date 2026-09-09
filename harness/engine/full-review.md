---
name: full-review
agents: [webhook-security-guard, sample-portability-reviewer, manual-digest-verifier]
triggers:
  - "전체 점검해"
  - "하네스 수행해"
  - "full review"
description: 세 전문가가 샘플 전체를 각자의 관점으로 검수하고, 정원지기가 하나의 보고서로 종합한다.
---

# Full Review — 전체 점검

## 목적

`sample-project/` 아래 모든 샘플과 `docs/` 를 대상으로 보안·이식성·문서 정합성을 한 번에 검수한다.
새 샘플이 추가되었거나, 릴리스 전, 또는 CLI 버전이 바뀐 뒤에 돌린다.

## Steps

1. **범위 확정** → agent: tamer
   - `sample-project/*/` 목록과 `docs/*.md` 를 나열하고, 각 샘플의 상태(✅ 완료 / 🚧 예정)를 README 표에서 읽는다
   - 🚧 예정 샘플은 디렉터리가 없으면 건너뛰고 보고서에 "미대상" 으로 남긴다
2. **보안 검수** → agent: webhook-security-guard
   - 체크리스트 A~F 전부
3. **이식성 검수** → agent: sample-portability-reviewer
   - 체크리스트 A~E 전부
4. **문서 대조** → agent: manual-digest-verifier
   - 대조 A~D 전부
5. **종합** → agent: tamer
   - 세 에이전트의 발견 항목을 심각도 내림차순으로 병합. 같은 위치를 두 에이전트가 지적하면 하나로 합치고 근거를 병기
   - `knowledge/review-methodology.md` §5 골격으로 보고서 작성
   - 3축 등급은 에이전트별 등급 중 **가장 낮은 것**을 종합 등급으로 한다

> 2~4 는 서로 독립이므로 병렬로 수행해도 된다. 단, 각 에이전트는 자기 로그를 따로 남긴다.

## Input

- 없음 (전체 대상). 선택적으로 특정 샘플 디렉터리를 지정하면 그 샘플만 검수한다: `전체 점검해 01-cli-gateway`

## Output

- 종합 보고서 (대화 출력)
- 로그: `harness/logs/full-review/{yyyy-MM-dd-HH-mm-full-review}.md` (종합)
- 로그: 각 에이전트 디렉터리에 개별 로그
- 후속: P0/P1 이 있으면 수정 우선순위 목록. 하네스 자체의 개선점(체크리스트 누락 등)이 드러나면 `하네스를 개선해` 를 제안

## 종료 후

차크라 감사관(`/harness-chakra`)이 활성화되어 있으면 토큰 사용 감사를 위임한다.
