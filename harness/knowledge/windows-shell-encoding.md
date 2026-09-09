# Windows 셸에서 한글 페이로드 보내기 — 인코딩이 깨지는 경로와 안전한 경로

> 실측일 2026-09-09 · Windows 11 · 콘솔 코드페이지 949 · Git Bash (MSYS2) · curl 8.7.1 (mingw) · PowerShell 5/7 · Node 22
> 사고: 02 검증 중 `curl -d '{"text":"…한글…"}'` 로 보낸 답장 2건이 **깨진 채 고객에게 발송**됨 (테스트 계정이라 실해 없음)
> 관련: [`sample-portability-constraints.md`](sample-portability-constraints.md) §2 (OS 대응), [`talkbridge-rest-api-spec.md`](talkbridge-rest-api-spec.md)

## 1. 무엇이 깨지는가 (실측 — 로컬 에코 서버로 도착 바이트 비교)

기대값 `"한글 테스트"` = UTF-8 16바이트 `ed959c eab880 20 ed858c ec8aa4 ed8ab8`

| # | 방식 | 도착 바이트 | 판정 |
|---|---|---|---|
| A | Git Bash `curl -d '{"text":"한글 테스트"}'` — **명령행 인자** | `efbfbd d1b1 efbfbd …` (19B) | ❌ 깨짐 |
| B | `curl --data-binary @body.json` (UTF-8 파일) | 정확 | ✅ |
| C | `curl --data-binary @- <<'EOF' … EOF` (stdin) | 정확 | ✅ |
| D | `node -e 'fetch(url,{body:JSON.stringify({text:"한글"})})'` | 정확 | ✅ |
| E | PowerShell `Invoke-RestMethod -Body ([Text.Encoding]::UTF8.GetBytes($json))` | 정확 | ✅ |
| F | PowerShell `Invoke-RestMethod -Body '{"text":"한글"}'` (문자열, 인코딩 미지정) | `3f3f 20 3f3f3f` = `?? ???` | ❌ 깨짐 |

## 2. 왜

- **A**: Git Bash 는 UTF-8 로 인자를 만들지만, `curl.exe` 는 Windows 네이티브(mingw) 바이너리라 **ANSI 코드페이지(949)** 로 `argv` 를 받는다.
  UTF-8 바이트가 CP949 로 재해석되어 `U+FFFD` 와 엉뚱한 한글이 섞인다. `--data-binary` 든 `-d` 든 **인자에 한글이 있으면** 같다.
- **F**: `Invoke-RestMethod` 는 문자열 바디를 기본 `ISO-8859-1` 로 인코딩한다. 한글은 전부 `?` 가 된다.
- B·C·D·E 는 페이로드가 **바이트로** 전달되어 코드페이지를 거치지 않는다.

`chcp 65001` 로 콘솔을 UTF-8 로 바꾸면 A 가 해결되는 환경도 있으나, 세션·터미널 종류마다 달라 **재현 가능한 절차로 삼지 않는다.**

## 3. 규칙

1. **한글(비ASCII)은 명령행 인자로 넘기지 않는다.** 파일·stdin·코드 안의 문자열로 넘긴다
2. curl 은 `--data-binary @file` 또는 `@-`(히어독). 파일은 UTF-8 (BOM 없음) 으로 저장
3. PowerShell 은 `-Body ([System.Text.Encoding]::UTF8.GetBytes($json))` + `-ContentType 'application/json; charset=utf-8'`
4. 가장 안전한 것은 **Node 스크립트**(`fetch`) — 샘플 `doctor.mjs`·`screenshot.mjs` 가 이 방식이다
5. **고객에게 실제로 가는 발신은 셸 한 줄로 하지 않는다.** 화면(`/api/send` 를 브라우저가 호출) 또는 스크립트로. 발신은 과금이고 취소가 제한적이다(REST 에 `delete` 없음)
6. 검증은 먼저 **로컬 에코 서버**로 도착 바이트를 hex 로 확인한 뒤 실발신한다

## 4. 검수 포인트 (이식 감독관 · 경비대장)

- README·스크립트의 curl 예시에 한글이 `-d '…'` 인자로 들어 있지 않은가 → 있으면 P2 (Windows 파트너가 그대로 따라 하면 깨진 메시지가 고객에게 감)
- 샘플 서버는 바이트를 변형하지 않는다 — `readBody` 가 Buffer 를 그대로 모으고 `JSON.parse(buf.toString('utf8'))` — 깨짐은 항상 **보내는 쪽** 문제. 서버를 의심하기 전에 §1 표로 발신 경로를 판별
- 문서 예시에 `curl` 을 쓸 때는 영문 본문으로 쓰거나 `--data-binary @-` 히어독 형태로 쓴다
