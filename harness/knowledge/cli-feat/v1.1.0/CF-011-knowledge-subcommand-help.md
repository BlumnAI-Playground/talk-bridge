# CF-011 · `knowledge <하위명령> --help` 가 help 대신 하위명령을 실행한다

| | |
|---|---|
| 분류 | 결함 |
| 관찰 버전 | talkbridge-dev v1.1.0 (dev) · 2026-09-09 |
| 영향 | 03, `knowledge` 를 스크립트·문서에서 안내하는 모든 파트너 (CF-005 의 잔여) |
| 상태 | 예고 |
| 근거 | 개선 수집관 로그 `harness/logs/improvement-collector/2026-09-09-16-10-recheck-cli-v1.1.0.md`, [CF-005](../v1.0.0/CF-005-setup-help-executes-setup.md) |

## 현상 (실측)

CF-005 로 `setup --help` 는 고쳐졌다(검증·저장 없음, `--dry-run` 추가). 그러나 `knowledge` 의 **하위 명령** 뒤에 붙인 `--help` 는
help 가 아니라 그 명령을 실행한다. `--help` 가 하위 명령의 첫 인자(검색어·포트 등)로 흡수되거나 무시된다.

```
$ talkbridge-dev knowledge view --help
✓ 지식뷰 시작됨 (port 8791, pid 10568) — http://localhost:8791/        ← 뷰 프로세스가 실제로 뜬다

$ talkbridge-dev knowledge build --help
[ontology] 엔티티 추출 실패(무시): … (127.0.0.1:9)
✓ 적재 완료 — 대화 1 · 턴 2 → 그래프(LadybugDB) 노드 98 · 엣지 116     ← 실제 적재가 돈다

$ talkbridge-dev knowledge search --help
검색어: --help
  [Inquiry ] setup --help 를 쳤더니 설정이 저장됐다고 나오는데 뭔가 바뀐 건가요?   ← "--help" 를 검색

$ talkbridge-dev knowledge query --help
오류: 읽기전용 Cypher만 허용됩니다(…). 거부된 문장: #1                          ← "--help" 를 Cypher 로 취급 (부작용은 없음)

$ talkbridge-dev knowledge status --help     → status 출력 (부작용 없음)
$ talkbridge-dev knowledge install --help    → install 실행 (이미 설치돼 있으면 "이미 설치됨", 처음이면 실제 설치)
```

`knowledge --help` / `knowledge help`(하위명령 없이) 는 정상적으로 도움말을 낸다.

## 파트너 영향

- 문서·튜토리얼에서 흔히 하는 `<명령> --help` 탐색이 **부수효과**(뷰 프로세스 기동, 적재 실행, 처음이면 lib 설치)를 일으킨다
- 특히 `build --help` 는 게이트웨이가 꺼져 있으면 실제 적재가 돌아 시간·(AI 설정 시) LLM 비용이 든다

## 현재 우회

- 하위 명령 help 는 `talkbridge knowledge help` 또는 `talkbridge knowledge --help` 로 본다 (전체 하위 명령이 한 화면에 있다)
- 03 README §6.1 에 이 주의를 적었다. 03 의 스크립트는 `--help` 를 쓰지 않는다

## 제안 스펙

1. 모든 하위 명령(`knowledge status/install/build/search/query/view/disable`, 그리고 `gateway`, `schedule`, `model` 등 서브커맨드 군 전체)에서
   `--help`/`-h` 가 **인자 위치와 무관하게** help 만 출력하고 부수효과가 없다 — CF-005 규칙 1 을 최상위 `setup` 뿐 아니라 서브커맨드 파서에도 적용
2. help 는 그 하위 명령 것만 짧게 (예: `knowledge search --help` → 자연어/`--cypher`/`--json` 설명)
3. 호환성: 인자 문자열로 `--help` 를 쓰는 경우는 없으므로 기존 동작에 영향 없음

## 수용 기준

- `knowledge view --help` 실행 뒤 `knowledge view status` 가 "실행 중인 지식뷰 없음" 이다
- `knowledge build --help` 실행 전후 `knowledge status --json` 의 `graph.nodes/edges` 가 같다
- `knowledge search --help` 출력에 "검색어:" 가 없고 사용법이 있다
- `knowledge query --help` 가 오류 대신 사용법(`--write`, `--continue-on-error`)을 낸다, 종료 코드 0
