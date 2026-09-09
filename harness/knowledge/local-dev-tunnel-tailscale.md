# 로컬 개발 테스트 — Tailscale Funnel 로 웹훅 수신 열기

> 실측일 2026-09-09 · Tailscale 1.102.2 · Windows 11 · Git Bash
> 대상: 호스티드 게이트웨이(02-api-webhook) 또는 외부 URL sink 가 필요한 모든 로컬 테스트
> 관련: [`talkbridge-webhook-contract.md`](talkbridge-webhook-contract.md) §3 (도달 조건), [`sample-portability-constraints.md`](sample-portability-constraints.md) §2 (터널 대응)

## 1. 왜 필요한가

TalkBridge 호스티드 게이트웨이는 **HTTPS 공인 도메인**으로만 전달한다(사설 IP·SSRF 차단).
01(CLI 게이트웨이)은 `127.0.0.1` 릴레이라 터널이 필요 없지만, 02 로 가려면 로컬 서버를 공인 HTTPS 로 내놓아야 한다.
Tailscale Funnel 은 도메인·인증서·포트포워딩 없이 `https://<node>.<tailnet>.ts.net` 으로 이를 해결한다.

## 2. 절차 (실측 검증됨)

### 전제
- `tailscale status` 로 로그인 상태 확인
- tailnet ACL 에 Funnel 노드 속성이 허용되어 있어야 한다 — `tailscale status --json` 의 CapMap 에 `"funnel"` 이 있으면 OK.
  없으면 `tailscale funnel` 실행 시 관리 콘솔 링크를 안내한다
- Funnel 은 **443 / 8443 / 10000** 포트만 열 수 있다 (내부 대상 포트는 자유)

### 웹훅 경로만 노출한다 — 루트를 열지 않는다

```bash
# Git Bash 에서는 MSYS 경로 변환을 반드시 끈다 (아래 §4 함정)
export MSYS_NO_PATHCONV=1
tailscale funnel --bg --set-path=/webhook http://127.0.0.1:8787/webhook
tailscale funnel status
```

기대 출력:
```
https://<node>.<tailnet>.ts.net (Funnel on)
|-- /webhook proxy http://127.0.0.1:8787/webhook
```

- `--bg` 는 설정을 영속시켜 재부팅 뒤에도 유지된다
- `/webhook` **접두 마운트**라 `/webhook/extra` 도 프록시된다. 경로는 백엔드에 **그대로 보존**된다(strip 하지 않음)
- 루트(`/`)·`/api/*` 는 Funnel 이 `404 page not found` 를 돌려준다 → 인증 없는 상담 화면이 인터넷에 노출되지 않는다

### 백엔드가 받는 요청 (실측)

```json
{"method":"POST","url":"/webhook","host":"<node>.<tailnet>.ts.net",
 "xff":"<발신자 공인 IP>","proto":"https","body":"{...원본 그대로...}"}
```

- `x-forwarded-for`, `x-forwarded-proto: https` 가 붙는다. 본문 바이트는 변형되지 않으므로 **raw body 서명 검증이 그대로 통과**한다
- `Host` 는 ts.net 호스트명이다. 서버가 `req.headers.host` 로 URL 을 재구성하는 코드가 있으면 이 값을 받는다

### 끄기

```bash
tailscale funnel --https=443 off
```

## 3. 검증 방법 — 자기 자신을 호출하면 안 된다

Funnel 을 연 PC 에서 그 호스트명을 호출하면 **MagicDNS 가 tailnet IP(100.x.x.x)** 로 풀어 `:443` 접속이 타임아웃된다.
이것은 공개 경로 테스트가 아니다. 공개 DNS(8.8.8.8)는 Tailscale **인그레스 IP** 로 푼다. 그쪽으로 강제한다:

```bash
H=<node>.<tailnet>.ts.net
IP=$(nslookup $H 8.8.8.8 | awk '/^Address/ && !/#/ {ip=$2} END{print ip}')   # IPv4 하나
curl -s --resolve "$H:443:$IP" -X POST "https://$H/webhook" \
     -H 'content-type: application/json' -d '{"probe":1}' -w ' [http %{http_code}]'
```

`--resolve` 로 인그레스를 거치면 실제 인터넷 → Tailscale → 내 PC 경로를 탄다.
다른 네트워크(휴대폰 LTE)에서 호출해도 같은 결과여야 한다.

임시 수신기로 먼저 검증하면 샘플 서버를 띄우지 않고도 경로·헤더를 확인할 수 있다 (30초 자동 종료 에코 서버 → `curl` → 받은 요청 출력).

## 4. 함정

| 증상 | 원인 | 조치 |
|---|---|---|
| 마운트 경로가 `/C:/Program Files/Git/webhook` 로 등록됨 | Git Bash(MSYS)가 `/webhook` 을 Windows 경로로 변환 | `export MSYS_NO_PATHCONV=1` 후 재실행, 또는 PowerShell/cmd 에서 실행 |
| 로컬에서 `curl https://<node>...` 타임아웃 | MagicDNS 가 tailnet IP 로 풀림 (§3) | `--resolve` 로 인그레스 IP 강제, 또는 외부망에서 호출 |
| 첫 요청이 수 초~수십 초 걸림 | Let's Encrypt 인증서 최초 발급 | 한 번 기다리면 이후 즉시 |
| `tailscale funnel` 이 ACL 링크를 안내 | tailnet 에 Funnel 미허용 | 관리 콘솔에서 `nodeAttrs: funnel` 허용 |
| 8787 이 아닌 포트를 열려 함 | Funnel 공개 포트는 443/8443/10000 뿐 | `--https=8443` 식으로 공개 포트를 바꾸고 내부 대상은 그대로 |

## 5. TalkBridge 에 어디를 등록하나

| 용도 | 등록 위치 | 값 |
|---|---|---|
| **CLI 게이트웨이 sink 를 공개 URL 로** (01 을 HTTPS 경로로 테스트) | `.env` `TB_WEBHOOK_URL` → `npm run gateway:setup` | `https://<node>.<tailnet>.ts.net/webhook` |
| **호스티드 게이트웨이 → 내 서버** (02) | 톡브릿지 센터 "상담 받을 곳 연결 → Webhook" | 같은 URL. `whsec_` 는 Agent 키에서 파생되어 센터에서 확인 |

**`webhook-domain set` 은 이 용도가 아니다.** 그 값은 브랜드의 카카오 수신 도메인(현재 `https://webhook.talkbridge-dev.com`,
bypass 게이트웨이 구성)이며 요약 §6 이 "임의 변경 금지" 로 경고한다. Admin 스코프가 필요하고, 바꾸면 카카오 → TalkBridge 수신 자체가 끊길 수 있다.
`webhook-domain get` (BrandWrite 로 조회 가능) 으로 현재 값을 확인만 한다.

## 6. 보안 주의

- Funnel 은 **인터넷 전체**에 연다. 서명 검증 없는 엔드포인트를 절대 마운트하지 않는다 — `/webhook` 은 서명 실패 시 401 이므로 안전
- 루트를 마운트하면 인증 없는 상담 화면·`/api/send`(과금 발신)가 노출된다. **경로 마운트만 쓴다**
- ts.net 호스트명은 tailnet 을 드러내므로 공개 문서에는 자리표시자로 적는다
- 테스트가 끝나면 `tailscale funnel --https=443 off`
