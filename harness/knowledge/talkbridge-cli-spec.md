# TalkBridge CLI 스펙 (샘플이 의존하는 범위)

> 원문: [`docs/talkbridge-manual-digest.md`](../../docs/talkbridge-manual-digest.md) §10,
> 실측: [`sample-project/01-cli-gateway/README.md`](../../sample-project/01-cli-gateway/README.md) §4, §6
> 래퍼 구현: [`sample-project/01-cli-gateway/server/cli.js`](../../sample-project/01-cli-gateway/server/cli.js)

## 1. 채널 — dev 와 prod 는 이름·스코프·설정 경로가 다르다

| | dev (개발환경) | prod (실환경) |
|---|---|---|
| REST 베이스 | `https://api.talkbridge-dev.com` | `https://api.talkbridge.io` — **파트너가 실환경으로 이해할 주소** |
| CLI 코어 엔드포인트 | `https://webhook.talkbridge-dev.com` | `https://webhook.talkbridge.io` |
| 센터(콘솔) | `https://console.talkbridge-dev.com` | (공개 매뉴얼 참조) |
| 실행 파일 | `talkbridge-dev` | `talkbridge` |
| npm 스코프 | `@blumn-dev/talkbridge-cli` | `@blumn-ai/talkbridge-cli` |
| 설정 파일 | `~/.bridge-agent/config.json` | `~/.talkbridge/config.json` |
| 게이트웨이 파일 | `~/.bridge-agent/gateway.pid`, `gateway.log`, `stream-offsets.json` | (문서 미기재 — 확인 필요) |

샘플 기본값은 dev(`TB_CLI=talkbridge-dev`). 파트너 전달용 코드는 양쪽을 모두 다뤄야 한다.
개발환경은 엔터프라이즈 구간의 파트너에게 실환경 착수 전 커스텀 개발용으로 제공될 수 있다 —
샘플의 `.env.example` 기본값은 **실환경**, 이 저장소의 검증은 **개발환경**에서 수행한다.
키는 발급한 환경에 묶인다 (실환경 키로 개발환경 호출 → 401).

## 2. 샘플이 사용하는 명령

| 명령 | 스코프 | 래퍼 | 비고 |
|---|---|---|---|
| `whoami` | — | `cliWhoami` | 이름·권한·엔드포인트·허용 브랜드 |
| `rooms --brand K --max N` | BrandRead | `cliRooms` | 상담방 목록 |
| `rooms --brand K --user U --max N` | BrandRead | `cliRoomMessages` | 방 메시지, **최신순** 출력 |
| `history --brand K` | BrandRead | `cliHistory` | `convId` 를 얻는 유일한 경로 (REST 대응 없음) |
| `send --brand K --to U --text T` | BrandWrite | `cliSend` | **과금** |
| `send --brand K --to U --file F [--text T]` | BrandWrite | `cliSendFile` | 공개 문서 미기재, 실측 존재 |
| `end-with-bot --brand K --to U [--event E]` | BrandWrite | `cliEndWithBot` | 순수 `end` 는 CLI 에 **없음** |
| `block` / `unblock --brand K --to U` | BrandWrite | `cliBlock` | |
| `delete --brand K --to U --serial S` 또는 `--text T [--within 초]` | BrandWrite | `cliDelete` | 발송 후 24h 내 |
| `setup --webhook-url --webhook-secret --webhook-brand --webhook-console` | — | `scripts/gateway.mjs setup` | sink 구성 |
| `gateway start/stop/restart/status` | — | `scripts/gateway.mjs` | 데몬 |
| `--version` | — | `scripts/doctor.mjs` | |

`--to` 와 `--user` 는 동의어(대상 고객 키).
`webhook-domain set` · `chat` · `schedule set` 은 **Admin** 스코프 필요 (BrandWrite 불가).

## 3. 출력 형식 — v1.1.0 부터 전역 `--json`, 텍스트에는 연도

**v1.1.0+**: 모든 조회 명령에 전역 `--json` — 한 줄 JSON, **필드명은 REST 와 동일**, 오류는 `{"ok":false,"error":"…"}` + 종료 코드 ≠ 0.

| 명령 | `--json` 형태 (실측) |
|---|---|
| `whoami` | `{"name","scope","endpoint","brands":[…]}` |
| `rooms --brand` | `[{"userKey","lastSeq","lastText","lastKind","lastTimestampUnixMs","count","ended"}]` |
| `rooms --brand --user` | `[{"seq","userKey","sessionId","kind","text","timestampUnixMs"}]` (최신순) |
| `history --brand` | `[{"brand","conversations":[{"convId","userKey","seq","sessionId","ended","count","last","lastActivityUnixMs"}]}]` |
| `gateway status` | `{"running","pid","log","knowledgeApi"}` |
| `env` | `{"channel","core","console","version","config","binaryPath","launcherPath","endpoint","knowledgeQueryPort",…}` |
| `knowledge status` | `{"enabled","lib","dbPath","queryPort","ai":{"configured","entityExtraction","naturalLanguageSearch"},"graph":{"via","error","nodes","edges","holderPid"}}` |
| `knowledge search --cypher` | `{"columns":[…],"types":[…],"rows":[[…]]}` — **모든 컬럼** |
| `knowledge search "<자연어>"` | `{"terms":[…],"hits":[{"nodeId","type","label","snippet"}]}` |

- 03 샘플은 `--json` 만 쓴다(`server/cli.js` `runJson()`). v1.0.0 CLI 에 `--json` 을 주면 텍스트가 나와 파싱 실패 → 버전 안내
- **텍스트 모드 타임스탬프에 연도가 붙었다** (`2026-09-09 10:30`; v1.0.0 은 `09-08 10:28`). v1.0.0 형식 정규식은 **0건**을 돌려준다(실측: 01·03 `doctor [6]`)
  → 01 파서는 두 형식 호환(`(?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}`). 검수 포인트: 파트너 코드에 v1.0.0 전용 정규식이 남아 있으면 P1
- `--version` 은 `--json` 을 줘도 텍스트(`talkbridge v1.1.0`)

**v1.0.0 (운영 채널 `talkbridge` 는 아직 이 버전)**: `--json` 없음. 01 이 텍스트를 파싱한다:

| 파서 | 실측 형식 |
|---|---|
| `parseRooms` | `· <userKey>     [진행중]   4건  최신#11  09-08 10:28  "<lastText>"` |
| `parseMessages` | `#10   [message] 09-08 10:23  <text>` |
| `parseWhoami` | `이름   : …` / `권한   : …` / `엔드포인트: …` / `브랜드 (1):` + `  - <key>` |
| `parseHistory` | rooms 형식 + 다음 줄 `convId=<hex>` |

ANSI 이스케이프는 제거 후 파싱한다. → [CF-007](cli-feat/v1.0.0/CF-007-cli-json-output.md)

## 4. Windows 실행 주의 (CVE-2024-27980)

- `talkbridge-dev` 는 npm 이 만든 `.cmd` shim. Node 18.20+/20.12+ 는 `shell:false` 에서 `.cmd` 실행을 막는다.
- `shell:true` 로 우회하면 상담 메시지의 큰따옴표·앰퍼샌드·퍼센트·캐럿 같은 문자가 cmd 파서에 먹혀 **인젝션·깨짐**.
- 정답: shim 을 타지 않고 **런처 JS 를 `process.execPath` 로 직접 실행** — 인자가 배열로 전달되어 안전.
- 해석 순서: `TB_CLI_BIN` → npm 전역 루트의 `@blumn-dev|@blumn-ai/talkbridge-cli/bin/<cli>.js` → PATH+shell 폴백(경고).
- v1.1.0: `env --json` 이 `launcherPath`·`binaryPath` 를 준다 — 탐색 로직 없이 그 값을 `TB_CLI_BIN` 에 넣으면 된다. 런처 강제 종료 시 자식 exe 잔존 없음(1회 실측) → [CF-010](cli-feat/v1.0.0/CF-010-windows-cmd-shim.md)

## 5. 상담지식 온톨로지 `knowledge` (03 샘플, 실측 2026-09-09 · v1.1.0)

| 하위 명령 | 동작 (v1.1.0) |
|---|---|
| `status` | 활성 / lib / **엔티티 추출(AI): 사용·미사용** / DB 경로 / 조회 API 포트 / 그래프 통계 (`--json` 지원) |
| `install` | OS 별 LadybugDB lib 설치 + 온톨로지 활성 + 스키마 — **AI 불필요** |
| `build [--brand]` | 과거 상담 일괄 적재, `ts` = **원 메시지 시각**, `loadedAt` = 적재 시각. AI 있으면 엔티티까지. **쓰기 → 게이트웨이 정지 필요** |
| `search "<자연어>"` | AI 필요(키워드 추출 → 노드 매칭). 미설정이면 `--cypher` 안내 |
| `search --cypher "<Cypher>"` | 읽기전용 (MATCH/RETURN), **전체 컬럼**, `--json` 은 `{columns,types,rows}` |
| `query "<Cypher>[; …]"` | **기본 읽기전용**. 쓰기·DDL 은 `--write`. 배치는 문장별 `#n ok/FAILED` + 종료 코드, `--stop-on-error`(기본)/`--continue-on-error` |
| `view [--port N]` / `view stop` / `stop-all` / `status` | 로컬 웹뷰(기본 8791). `localhost`·`127.0.0.1` 둘 다, `/cypher?q=`, cytoscape 로컬 자산 |
| `disable` | 비활성 (lib·DB 보존) |

- **게이트웨이가 떠 있으면 조회(status/search/view/읽기 query)는 조회 API `127.0.0.1:8790/knowledge/`(status·cypher·graph.json·search)를 자동 경유** — 잠금 충돌 없음.
  쓰기(build/query --write)는 `게이트웨이(pid N)가 그래프 DB 를 사용 중` 으로 거부 → `gateway stop` 후 실행 (03 `scripts/write-window.mjs`)
- **스키마·잠금·조회 규칙은 [`talkbridge-knowledge-graph.md`](talkbridge-knowledge-graph.md)**
- 검수 포인트: 샘플은 그래프를 **읽기만** 해야 한다(`search --cypher` 만, `query --write` 를 화면 경로에 노출하면 P0). `build`/적재는 화면이 아니라 스크립트로만

### ⚠️ `--help` 는 최상위 명령에서만 안전하다

- `setup --help` 는 v1.1.0 에서 고쳐졌다 (검증·저장 없음, `--dry-run` 추가) → [CF-005](cli-feat/v1.0.0/CF-005-setup-help-executes-setup.md) 구현됨
- **`knowledge <하위명령> --help` 는 아직 그 명령을 실행한다** — `view --help` 는 뷰를 띄우고, `build --help` 는 적재를 돌리고, `search --help` 는 "--help" 를 검색한다.
  하위 명령 도움말은 `knowledge help` / `knowledge --help` 로. 문서·스크립트에서 하위 명령 `--help` 를 권하지 말 것 → [CF-011](cli-feat/v1.1.0/CF-011-knowledge-subcommand-help.md)
- 비대화형 `setup` 은 준 플래그 그룹만 갱신한다 — AI 플래그만 주면 webhook sink 는 그대로.

## 6. 인증·과금

- `login` (OAuth 페어링, BrandWrite 자동 발급) 또는 `setup <키>` (비대화형)
- 발신형 명령은 구독 건수 소진. 조회·설정은 비과금. Free 는 30일 3건 → 샘플·테스트는 라이브 발신 최소화.
- 과금 단위 = 하루에 응대한 고객 1명 (KST 자정 경계)
