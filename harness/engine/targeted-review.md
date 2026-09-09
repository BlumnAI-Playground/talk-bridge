---
name: targeted-review
agents: [webhook-security-guard, sample-portability-reviewer, manual-digest-verifier]
triggers:
  - "변경 점검해"
  - "변경사항 점검해"
  - "targeted review"
description: git 변경분만 대상으로, 바뀐 파일의 성격에 따라 필요한 전문가만 투입해 빠르게 검수한다.
---

# Targeted Review — 변경 점검

## 목적

커밋 전·PR 전에 **바뀐 것만** 본다. 전체 점검보다 가볍고, 변경 파일 유형에 따라 관련 에이전트만 부른다.

## Steps

1. **변경분 수집** → agent: tamer
   - `git status --short` + `git diff` (스테이지 포함: `git diff HEAD`). 인자로 커밋 범위가 오면 `git diff <range>`
   - 변경 파일이 없으면 "검수 대상 없음" 으로 종료 (로그는 남긴다)
2. **라우팅** → agent: tamer — 파일 경로로 담당을 정한다

   | 변경 파일 | 투입 에이전트 |
   |---|---|
   | `server/signature.js`, `webhook.js`, `store.js`, `index.js`, `cli.js` | webhook-security-guard **+** manual-digest-verifier |
   | `server/config.js`, `scripts/*.mjs`, `package.json`, `.env.example`, `.gitignore` | sample-portability-reviewer |
   | `public/**` | webhook-security-guard (E 항목만) + sample-portability-reviewer (A 항목만) |
   | `README.md`, `docs/*.md`, `sample-project/README.md`, `sample-project/*/README.md` | manual-digest-verifier **+** sample-portability-reviewer (C 항목만) |
   | 새 샘플 디렉터리 추가 (`sample-project/NN-*/`) | full-review 로 승격 제안 |
   | `harness/**` | 검수 대상 아님 — `하네스를 개선해` 로 안내 |

3. **검수** → 라우팅된 에이전트
   - 각 에이전트는 **변경된 줄과 그 영향 범위**만 본다. 체크리스트에서 무관한 항목은 "해당 없음" 으로 건너뛴다
   - 변경이 knowledge/ 문서의 계약을 바꾸는 성격이면(예: 서명 스킴 변경) 해당 knowledge 문서 갱신 필요를 함께 보고
4. **종합** → agent: tamer
   - 발견 항목 병합, 3축 등급(변경 범위 기준), 커밋 가능 여부 한 줄 판정

> 보조 도구: 표준 `/code-review` 스킬로 일반 결함 후보를 얻은 뒤, 하네스 계약 기준으로 재판정할 수 있다.

## Input

- 기본: 워킹트리 변경분 (`git diff HEAD`)
- 선택: `변경 점검해 HEAD~3..HEAD` 처럼 범위 지정

## Output

- 변경 검수 보고 (대화 출력) — 커밋 가능 / 수정 후 커밋 / 보류
- 로그: `harness/logs/targeted-review/{yyyy-MM-dd-HH-mm-targeted-review}.md`
- 투입된 에이전트별 개별 로그

## 종료 후

차크라 감사관(`/harness-chakra`)이 활성화되어 있으면 토큰 사용 감사를 위임한다.
