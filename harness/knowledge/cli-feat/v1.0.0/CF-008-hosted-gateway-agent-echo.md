# CF-008 · 호스티드 게이트웨이의 이중 `agent` echo — 문서화와 식별 필드

| | |
|---|---|
| 분류 | 문서 갭 (+ 페이로드 개선 제안) |
| 관찰 버전 | 호스티드 게이트웨이 (dev) · 2026-09-09 · 02 샘플 |
| 영향 | 02, 웹훅으로 자동응답·화면을 만드는 모든 파트너 |
| 상태 | 수용 (v1.1.0 미반영) — 재검수 2026-09-09 (아래 "재검수" 절) |
| 근거 | [`talkbridge-webhook-contract.md`](../../talkbridge-webhook-contract.md) §3.1, 02 README §6.5, `logs/tamer/2026-09-09-10-36-*` |

## 현상 (실측)

`POST /api/agent/send` 1건 뒤 웹훅으로 `kind:"agent"` 가 **두 번** 온다:

```
[webhook:debug] {"x-bridge-event":"agent","x-bridge-timestamp":"1788917411",…} {"userKey":"Vjpe_s_fc16k","kind":"agent","brand":"crm-b3e696"}
[webhook:debug] {"x-bridge-event":"agent","x-bridge-timestamp":"1788917412",…} {"userKey":"Vjpe_s_fc16k","kind":"agent","seq":17,"brand":"crm-b3e696"}
```

① 발신 직후 **seq 없는** 페이로드, ② ~1초 뒤 저널 항목(seq 있음). 공개 매뉴얼 §9 는 `agent` 를 "내 발신 echo → 무시" 라고만 적고 두 번 온다는 언급이 없다. CLI 게이트웨이(01)도 같은지는 미실측.

## 파트너 영향

- ①을 메시지로 저장하면 답장 하나가 말풍선 두세 개로 보인다 (02 에서 재현)
- 멱등을 `(brand, seq)` 로만 걸면 ①은 seq 가 없어 항상 통과한다

## 현재 우회

- `webhook.js`: `kind === 'agent' && seq == null` 이면 저장하지 않고 SSE `ack` 로만 (01·02 공유 코드)
- `store.js`: seq 확정 echo 가 오면 같은 본문의 pending 말풍선 제거

## 제안 스펙

1. 공개 매뉴얼 §9.1 에 이중 echo 를 표로 명시: ① 접수 신호(seq 없음) ② 저널 항목
2. ①에 식별 필드 추가 — 예: `"phase":"accepted"` (②는 `"phase":"journaled"` 또는 생략) — 헤더 `X-Bridge-Event: agent.accepted` 도 대안
3. ①에 `serial`(`send` 응답의 `bw-…`) 포함 → 낙관적 말풍선과 정확히 매칭 가능
4. CLI 게이트웨이도 같은 동작이면 동일 규칙, 다르면 문서에 게이트웨이별 차이 표

## 수용 기준

- 매뉴얼 §9 에 두 이벤트의 순서·필드·권장 처리가 있다
- ① 페이로드에 `phase` 또는 동등한 식별 필드와 `serial` 이 있다
- 02 `webhook.js` 가 `seq == null` 추정 대신 식별 필드로 분기해도 말풍선이 하나만 보인다

## 재검수 (v1.1.0 · 2026-09-09) — 미반영

호스티드 게이트웨이(Tailscale Funnel → 원시 로거 8788)로 REST `send` 1건을 보내 수신 페이로드를 그대로 기록했다:

```
06:34:44.181Z  X-Bridge-Event: agent  delivery=140774e7-…  {"userKey":"Vjpe_s_fc16k","kind":"agent","brand":"crm-b3e696"}            ← ① seq 없음
06:34:44.466Z  X-Bridge-Event: agent  delivery=9400f108-…  {"userKey":"Vjpe_s_fc16k","kind":"agent","seq":18,"brand":"crm-b3e696"}   ← ② 285ms 뒤, 저널
send 응답: {"ok":true,"serial":"bw-1788935684192-446f"}
```

- 이중 echo 그대로, `phase`·`serial` 식별 필드 없음, 헤더도 둘 다 `agent`
- 공개 문서 `/webhooks/payload/`(dev) 에 이중 전달 설명 없음 — 필드는 `brand, userKey, kind, seq` 만
- 02 `webhook.js` 는 계속 `seq == null` 추정으로 분기한다. 상태 `수용` 유지, 다음 릴리스에서 재검수
