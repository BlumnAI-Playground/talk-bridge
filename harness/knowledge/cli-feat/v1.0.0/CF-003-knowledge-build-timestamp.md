# CF-003 · `knowledge build` 의 `ts` 가 원 메시지 시각이 아니라 적재 시각

| | |
|---|---|
| 분류 | 결함 |
| 관찰 버전 | talkbridge-dev v1.0.0 (dev) · 2026-09-09 |
| 영향 | 03 고객 타임라인·최근 문의 프리셋, 시간 기반 분석 전부 |
| 상태 | 구현됨(v1.1.0) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-knowledge-graph.md`](../../talkbridge-knowledge-graph.md) §1, 03 README §6.4 |

## 현상 (실측)

브랜드 `crm-b3e696` 의 상담 메시지 #10 (2026-09-08 01:23 UTC), #14 (2026-09-09 01:24 UTC) 를 `knowledge build` 로 적재한 뒤:

```
$ talkbridge-dev knowledge search --cypher "MATCH (i:Inquiry) RETURN i.id + '\t' + cast(i.ts AS STRING)"
ad05d3f3799045318cc482c4345d6f06#1	2026-09-09 03:37:21.441
ad05d3f3799045318cc482c4345d6f06#5	2026-09-09 03:37:23.607
```

두 문의의 `ts` 가 모두 **build 를 실행한 12:37 KST(03:37 UTC)** 로 기록되었다. REST `messages` 에는 `timestampUnixMs` 가 있으므로 원 시각을 알 수 있는 상태다.
게이트웨이 실시간 적재(온톨로지 sink) 경로는 미실측 — 같은 코드라면 수신 시각으로 기록될 가능성이 있다.

## 파트너 영향

- "최근 문의", "고객 타임라인" 같은 시간순 조회가 적재 순서를 보여줄 뿐 실제 상담 시각을 반영하지 않는다
- 과거 상담을 백필하면 전부 같은 시각으로 뭉친다

## 현재 우회

- 03 README §6.4 에 명시. 정확한 시각이 필요하면 REST `messages.timestampUnixMs` 또는 웹훅 도착 시각을 별도 저장
- 데모 데이터(`demo:seed`)는 `timestamp('YYYY-MM-DD HH:mm:ss')` 로 직접 넣으므로 영향 없음

## 제안 스펙

1. `build` 는 `Inquiry.ts` / `Response.ts` 에 **원 메시지 시각**(`timestampUnixMs` → UTC TIMESTAMP)을 기록
2. 적재 시각이 필요하면 별도 속성 `loadedAt` 추가 (스키마 변경 → `install` 이 마이그레이션)
3. 게이트웨이 실시간 적재도 동일 규칙 (수신 페이로드에 시각이 없으므로 본문 조회 결과의 시각 사용)

## 수용 기준

- 2일 전 메시지를 `build` 로 적재한 뒤 `cast(i.ts AS STRING)` 이 그 메시지의 `timestampUnixMs` 와 일치한다
- 같은 대화의 문의·응답 `ts` 순서가 `seq` 순서와 일치한다
- `loadedAt` 이 있다면 build 실행 시각과 일치한다

## 재검수 (talkbridge-dev v1.1.0 · 2026-09-09)

**구현됨.**

- `rooms --user Vjpe_s_fc16k --json` 의 seq 14 "웹훅. 수신 테스트1" `timestampUnixMs: 1788917073907` (= 2026-09-09T01:24:33.907Z)
  ↔ 그래프 `Inquiry ad05…#5` `ts: 2026-09-09 01:24:33.906` — 원 메시지 시각 일치(1ms 반올림) ✓
- `i.loadedAt` 속성 존재(TIMESTAMP). 기존 노드는 null — 재적재 시 채워진다 (build --help 로 인한 재실행에서는 기존 노드 유지)
- help 문구: `build [--brand <키>] 과거 상담을 그래프에 일괄 적재(원 메시지 시각 보존)` ✓
- 03 README §6.4 갱신, `graph.js` 스키마 주석에 `loadedAt` 추가
