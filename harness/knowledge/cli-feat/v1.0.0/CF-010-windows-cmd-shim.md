# CF-010 · Windows `.cmd` shim — 프로그램에서 CLI 를 안전하게 부르는 경로가 문서에 없다

| | |
|---|---|
| 분류 | DX |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · Node 22.18 · Windows 11 · 2026-09-09 |
| 영향 | 01·03 (`server/cli.js`), CLI 를 스크립트/서버에서 spawn 하는 Windows 파트너 |
| 상태 | 부분 구현됨(v1.1.0) — CLI ✓ · 문서 미반영 — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-cli-spec.md`](../../talkbridge-cli-spec.md) §4, 01 README §6.1, 데모 데이터 `demo:c02` |

## 현상 (실측)

`talkbridge-dev` 는 npm 이 만든 `.cmd` shim 이다.

- `spawn('talkbridge-dev', args)` (shell:false) → Node 18.20+/20.12+ 가 CVE-2024-27980 패치로 **거부**(EINVAL)
- `shell:true` → 상담 메시지의 큰따옴표·`&`·`%`·`^` 가 cmd 파서에 먹혀 **인젝션·깨짐**
- 안전한 방법은 npm 전역 루트의 `@blumn-dev/talkbridge-cli/bin/talkbridge-dev.js` 를 `process.execPath` 로 직접 실행 — 이 경로·방법이 **공개 문서에 없다**. 샘플이 `npm root -g` 로 탐색해 찾는다

추가로, 타임아웃 시 런처(node)만 죽이면 자식 `talkbridge-dev.exe` 가 살아남아 그래프 DB 잠금을 쥔다 (03 실측, 트리 종료로 우회).

## 파트너 영향

- Windows 파트너가 첫 연동에서 EINVAL 또는 깨진 메시지를 겪는다 (데모 데이터의 `demo:c02` 가 바로 이 문의)

## 현재 우회

- 01/03 `server/cli.js` `resolveLauncher()`: `TB_CLI_BIN` → npm 전역 루트 탐색 → shell 폴백(경고). 타임아웃 시 `taskkill /T /F`

## 제안 스펙

1. 매뉴얼 "프로그램에서 호출하기" 절: 런처 JS 경로, `process.execPath` 실행 예제, 인자 배열 전달 원칙
2. `talkbridge env --json` 에 `launcherPath`(런처 JS 절대 경로)와 `binaryPath` 를 포함 → 파트너가 탐색 로직 없이 읽어 쓴다
3. 런처가 자식 바이너리에 **작업(Job) 객체/시그널 전파**를 걸어 부모 종료 시 자식도 종료
4. (선택) `npx talkbridge-dev` 대신 `node -e` 없이 쓸 수 있는 `.exe` 직접 배포 경로 문서화

## 수용 기준

- 매뉴얼 예제를 그대로 Windows Node 22 에서 실행하면 `" & % ^` 가 포함된 `--text` 가 원문 그대로 발신된다
- `talkbridge env --json` 이 `launcherPath` 를 돌려주고 그 경로가 존재한다
- 런처 프로세스를 강제 종료했을 때 `talkbridge-dev.exe` 가 남지 않는다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**부분 구현됨.**

- `talkbridge-dev env --json` → `"binaryPath":"…\\talkbridge-cli-win32-x64\\talkbridge-dev.exe","binaryArgs":[],"launcherPath":"…\\bin\\talkbridge-dev.js"` ✓, 두 경로 모두 존재 확인 ✓
- 런처를 `process.execPath` 로 띄우고 150ms 뒤 강제 종료 → `tasklist` 에 게이트웨이 외 `talkbridge-dev.exe` 잔존 없음 ✓ (1회 실측)
- 특수문자 `--text` 발신 실측은 생략(실제 고객 방 발신을 피함) — 03 `cli.js` 가 배열 인자로 Cypher 의 따옴표·백슬래시를 문제없이 전달하는 것으로 갈음
- 공개 문서 `/cli/install/`·`/cli/commands/` 에 "프로그램에서 호출하기" 절 없음 — **문서 항목은 미반영**, 상태는 부분 구현
