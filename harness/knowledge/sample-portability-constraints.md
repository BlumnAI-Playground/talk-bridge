# 샘플 이식성 제약 — 파트너가 "그대로 베껴 쓸" 코드의 조건

> 이 저장소의 샘플은 파트너가 복사해 가는 **참조 구현**이다.
> 근거: [`sample-project/README.md`](../../sample-project/README.md) "공통 전제",
> [`01-cli-gateway/README.md`](../../sample-project/01-cli-gateway/README.md) §0, §6, §7

## 1. 공통 전제 (모든 샘플)

| 제약 | 검수 포인트 |
|---|---|
| **Node.js 18+** | `package.json` `engines.node`, 18 에 없는 API 사용 여부 (예: `Array.prototype.toSorted` 는 20+) |
| **외부 의존성 0** | `dependencies` / `devDependencies` 비어 있음, `import` 가 전부 `node:` 내장 또는 상대 경로 |
| **프론트 바닐라 JS** | 프레임워크·번들러·CDN 스크립트 없음 |
| 독립 실행 | 각 샘플 디렉터리 안에서 `npm start` 만으로 동작. 다른 샘플·상위 디렉터리 파일 참조 금지 |

## 2. 환경 이식성

- **설정은 전부 환경변수/`.env`** — `.env.example` 이 모든 키를 설명하고, 필수/선택이 구분되어야 한다
- **하드코딩 금지 대상**: 브랜드 키, userKey, 시크릿, 절대 경로, 특정 사용자명, 특정 포트(기본값은 가능)
- **dev/prod 양쪽 대응**: CLI 이름·npm 스코프·설정 경로가 다르므로 (`talkbridge-cli-spec.md` §1) 둘 다 처리
- **OS 대응**: Windows(`.cmd` shim, 경로 구분자, `windowsHide`) · macOS · Linux 에서 같은 코드가 돌아야 한다
- **한글 페이로드**: Windows 셸에서 한글을 `curl -d '…'` 인자로 넘기면 CP949 로 깨진다 — 문서·스크립트 예시는 파일/stdin/Node 로 ([`windows-shell-encoding.md`](windows-shell-encoding.md))
- **터널 대응**: 로컬 sink 외에 `TB_WEBHOOK_URL` 로 외부 URL 을 지정할 수 있어야 한다

## 3. 문서-실행 일치

- README 의 "빠른 시작" 순서와 `package.json` `scripts` 가 일치
- README 가 언급하는 파일·함수명이 실제로 존재 (`server/webhook.js`, `cliSend` 등)
- `doctor.mjs` 가 검사하는 항목과 README "문제 해결" 표가 서로를 커버
- 검증 환경 표기(CLI 버전, Node 버전, OS)가 있고 오래되지 않았는지

## 4. 오류 메시지 명료성

파트너는 이 코드를 처음 보는 사람이다. 오류는 **원인 + 다음 행동**을 담아야 한다.

- 좋음: `필수 환경변수 TB_BRAND 가 없습니다. .env.example 을 복사해 .env 를 만드세요.`
- 나쁨: `Error: undefined`
- 시크릿은 오류·로그에서 **마스킹** (`gateway.mjs` 의 `***` 치환 패턴)

## 5. "샘플 → 운영" 경계가 명시되어 있는가

샘플은 의도적으로 단순화한 부분이 있다. 그 자리는 **코드 주석 또는 README §7 에 명시**되어야 파트너가 그대로 운영에 올리는 사고를 막는다.

| 샘플의 단순화 | 운영 대체 |
|---|---|
| 인메모리 저장소 (`store.js`) | DB — `delivery_id` UNIQUE 멱등 테이블 + 메시지 테이블 |
| 인증 없는 상담 화면 | 상담원 로그인·권한 |
| CLI 텍스트 파싱 | REST 직접 호출 (`02-api-webhook`) |
| 인메모리 3회 재시도 | 호스티드 게이트웨이 영속 재시도 |
| `HOST=127.0.0.1` 바인딩 | 외부 노출 시 인증·TLS 필수 |

## 6. 01 ↔ 02 공유 파일 규칙 (2026-09-09 실측)

| 파일 | 01 ↔ 02 | 규칙 |
|---|---|---|
| `server/signature.js`, `store.js`, `sse.js` | **바이트 단위 동일** | 한쪽을 고치면 반드시 다른 쪽에도 반영. `diff` 로 검수 |
| `server/webhook.js` | 코드 2줄만 다름 — import (`cli.js` `cliRoomMessages` ↔ `api.js` `roomMessages`) 와 `enrich()` 의 호출 1줄 + 주석의 CLI/REST 표기 | 그 외 로직은 동일해야 한다. `diff` 결과가 이 2줄·주석 외에 있으면 P1 |
| `public/index.html`, `app.js` | 문구·`/api/me` 필드(`cli` ↔ `apiBase`)만 다름 | 렌더·SSE 로직은 동일 |
| `server/index.js` | 같은 뼈대, 조회·발신 호출부만 CLI ↔ REST | 라우트 표가 README 와 일치해야 한다 |
| `server/cli.js` ↔ `server/api.js` | 대응 관계 | **반환 모델이 같아야 한다** (`userKey/kind/seq/text/at/direction`, rooms 의 `status/ended/lastSeq/lastText`) |

이 대응이 유지되어야 "01 로 검증하고 02 로 승격" 경로와 "파트너의 커스텀 로직이 그대로 살아남는다" 는 문서 약속이 참이 된다.
02 의 기본 포트는 8788 (01 은 8787) — 두 샘플을 나란히 띄울 수 있게 하기 위함.
