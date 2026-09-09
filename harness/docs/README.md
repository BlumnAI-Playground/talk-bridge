# Harness — 정원

> "정원지기"라고 부르면 된다. 그것이 전부다.

**블룸 정원의 하네스** (블룸 = [블룸 AI](https://blumn.ai), TalkBridge 를 만드는 곳) — 카카오 상담톡 연동 샘플 프로젝트(CLI 게이트웨이, API 웹훅)의 코드 리뷰 워크플로우 관리.

이 저장소의 샘플은 파트너가 **그대로 복사해 가는 참조 구현**이다. 하네스는 그 코드가
보안 계약을 지키는지, 다른 환경에서 그대로 도는지, 문서와 어긋나지 않는지를 검수한다.

## 정원의 구조

```
harness/
├── harness.config.json   # 정원의 이름표
├── knowledge/            # Layer 1: 햇빛 — 도메인 지식
│   ├── talkbridge-webhook-contract.md      수신 웹훅 계약 (서명·신뢰성·도메인 모델)
│   ├── talkbridge-cli-spec.md              CLI 명령·스코프·출력 파싱·dev/prod 환경 매핑
│   ├── talkbridge-rest-api-spec.md         REST 엔드포인트·봉투 실측·에러 코드·CLI 와의 차이
│   ├── talkbridge-knowledge-graph.md       CLI 상담지식 그래프 — 스키마·단일 프로세스 잠금·query vs search·데모 데이터 규칙
│   └── cli-feat/                           ★ 현재 CLI 버전 기준 "다음 개선 예고" 스펙 (CF-001~010, 개선 수집관이 관리)
│       ├── README.md                       인덱스·상태 규칙·템플릿
│       ├── v1.0.0/CF-nnn-*.md              결함·제약·문서 갭·DX — 현상(실측)·파트너 영향·우회·제안 스펙·수용 기준·재검수(v1.1.0)
│       └── v1.1.0/CF-011-*.md              v1.1.0 에서 처음 관찰된 현상
│   ├── sample-portability-constraints.md   의존성 0·Node 18+·이식성·운영 경계
│   ├── local-dev-tunnel-tailscale.md       Tailscale Funnel 로 웹훅 수신 열기 (실측 절차·함정·등록 위치)
│   ├── windows-shell-encoding.md           Windows 셸에서 한글 페이로드가 깨지는 경로·안전한 경로 (실측 표)
│   └── review-methodology.md               공통 심각도·3축 평가·보고 형식
├── agents/               # Layer 2: 영양분 — 전문가 에이전트
│   ├── tamer.md                      정원지기 (기본 내장)
│   ├── webhook-security-guard.md     웹훅 경비대장 — 서명·시크릿·인젝션
│   ├── sample-portability-reviewer.md 이식 감독관 — 제약·환경·문서-실행 일치
│   ├── manual-digest-verifier.md     문서 대조관 — 요약↔README↔코드 드리프트
│   └── improvement-collector.md      개선 수집관 — 발견을 cli-feat 개선 예고 스펙으로
├── engine/               # Layer 3: 물길 — 워크플로우
│   ├── full-review.md        전체 점검 (3 에이전트 → 종합)
│   └── targeted-review.md    변경 점검 (git diff → 라우팅)
├── docs/                 # 정원 일지 (vX.Y.Z.md)
└── logs/                 # 활동 기록 ({agent|engine}/{timestamp}.md)
```

## 호출 방법

`/harness-creator` — 정원지기를 소환한다. 한 번 소환한 뒤에는 슬래시 없이 말해도 된다.
`/harness-chakra` — 작업이 끝난 뒤 토큰(차크라) 사용을 감사하는 차크라 감사관을 부른다.

## 사용법

```
꽃을 피우다 (수행부):
  전체 점검해                 ← full-review: 3 전문가 전체 검수 + 종합 보고
  변경 점검해                 ← targeted-review: git 변경분만, 관련 전문가만 투입
  보안 점검해                 ← webhook-security-guard 단독
  이식성 점검해               ← sample-portability-reviewer 단독
  문서 검증해                 ← manual-digest-verifier 단독
  개선사항 수집해             ← improvement-collector: 로그·문서의 발견을 cli-feat 스펙으로

꽃을 심다 (개선부):
  하네스를 설명해             ← 정원 상태 보고
  하네스를 개선해             ← 평가 후 개선안
  평가로그를 점검해           ← 로그 트렌드 분석
  새 에이전트 추가해          ← 새 꽃 심기
  스킬 복사해                 ← 접목(接木)
```

## 검수 기준 요약

- 심각도 P0(복사하면 사고) ~ P3(가독성) — `knowledge/review-methodology.md`
- 3축: 코드 안전성 / 아키텍처 정합성 / 테스트 가능성, 각 A~D
- 발견 항목은 반드시 `경로:줄번호` + knowledge 문서 근거를 단다

## 버전 히스토리

- [v1.2.2](v1.2.2.md) — CLI v1.1.0 재검수: cli-feat 상태 갱신(7 구현·1 부분·2 미반영·CF-011 신설), 03 샘플 재개, 01 파서 호환 (2026-09-09)
- [v1.2.1](v1.2.1.md) — 정원지기 네이밍 전환(카카시 → 정원지기, `/harness-creator`), 이름을 "블룸 정원의 하네스"로 (2026-09-09)
- [v1.2.0](v1.2.0.md) — 개선 수집관 영입 + cli-feat 개선 예고 10건 (CLI v1.0.0 기준) (2026-09-09)
- [v1.1.6](v1.1.6.md) — 03 완료: 그래프 스키마·잠금·query/search 규칙 지식, 경비대장 E' 항목 (2026-09-09)
- [v1.1.5](v1.1.5.md) — 03 샘플 착수: CLI `knowledge` 명령군·`setup --help` 함정 (2026-09-09)
- [v1.1.4](v1.1.4.md) — Windows 셸 한글 인코딩 사고 → 지식화 (2026-09-09)
- [v1.1.3](v1.1.3.md) — 02 실측 완료: REST 스펙 지식, agent 이중 echo 계약, 문서 대조관 REST 항목 (2026-09-09)
- [v1.1.2](v1.1.2.md) — 02 샘플 착수: 환경 매핑(dev/prod REST), 01↔02 공유 파일 규칙 (2026-09-09)
- [v1.1.1](v1.1.1.md) — 햇빛 한 줄기 더: Tailscale Funnel 로컬 개발 터널 지식 (2026-09-09)
- [v1.1.0](v1.1.0.md) — 첫 꽃을 심다: 전문가 3명 + 엔진 2개 + 지식 4편 (2026-09-09)
- v1.0.0 — 정원 개장: tamer 만 존재 (2026-09-09)
