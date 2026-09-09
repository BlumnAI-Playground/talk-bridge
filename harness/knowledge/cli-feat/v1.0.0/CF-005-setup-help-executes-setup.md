# CF-005 · `setup --help` 가 help 대신 setup 을 실행한다

| | |
|---|---|
| 분류 | 결함 |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · 2026-09-09 |
| 영향 | 전체 (첫 사용자, 문서에서 `--help` 를 권하는 모든 곳) |
| 상태 | 구현됨(v1.1.0) · 잔여 → CF-011 — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-cli-spec.md`](../../talkbridge-cli-spec.md) §5 함정, 03 README §6.1, 데모 데이터 `demo:c18` |

## 현상 (실측)

```
$ talkbridge-dev setup --help
브릿지(https://webhook.talkbridge-dev.com)에 키를 검증하는 중...
✓ 저장 완료 → C:\Users\…\.bridge-agent\config.json
  이름: CLI login 2026-09-08   권한: BrandWrite   브랜드: 1개
  Webhook: http://127.0.0.1:8787/webhook [console-log]  → 'gateway start' 로 릴레이
  CRM 프로바이더: SQLite(기본)  → /cs-memo · /cs-who 사용 가능
```

help 가 아니라 비대화형 setup 이 실행되어 config 가 재저장된다. 기존 값은 유지되었다(실측). `knowledge --help` 는 정상적으로 help 를 낸다.

## 파트너 영향

- 사용법을 보려다 설정 파일이 갱신되고 서버에 키 검증 요청이 나간다. 값이 유지되어 실해는 없지만, 다른 플래그와 섞이면(예: `--help --ai-key …`) 의도치 않은 저장이 될 수 있다
- 문서·샘플에서 `setup --help` 를 권할 수 없다

## 현재 우회

- 문서에서 `setup --help` 를 권하지 않는다. 플래그 목록은 공개 매뉴얼 §10 을 참조

## 제안 스펙

1. 모든 하위 명령에서 `--help`/`-h` 는 help 만 출력하고 부수효과가 없다 — 특히 `setup`, `login`
2. `setup` 은 인자가 없을 때만 TUI, 알 수 없는 플래그가 있으면 오류 + help
3. 저장이 일어나는 명령은 `--dry-run` 을 지원해 무엇이 바뀌는지 미리 보여줌 (선택)

## 수용 기준

- `setup --help` 실행 전후 `config.json` 의 mtime 과 내용이 같다
- 출력에 `--webhook-url`, `--ai-provider` 등 플래그 그룹 설명이 있다
- `setup --no-such-flag` 는 저장 없이 오류와 help 를 낸다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨 (setup).**

- `setup --help` 실행 전후 `config.json` md5·mtime 동일 ✓. 출력에 `[키·엔드포인트] [Outbound · Discord/Slack/Webhook] [CS · CRM] [AI 챗봇] [지식 온톨로지]` 플래그 그룹 ✓, `--dry-run` 추가 ✓
- `setup --no-such-flag` → `오류: 알 수 없는 setup 옵션: --no-such-flag` + 도움말, config 무변경 ✓

**잔여**: `knowledge <하위명령> --help` 는 여전히 그 명령을 실행한다(`view --help` 가 뷰를 띄움, `build --help` 가 적재 실행) → [CF-011](../v1.1.0/CF-011-knowledge-subcommand-help.md)
