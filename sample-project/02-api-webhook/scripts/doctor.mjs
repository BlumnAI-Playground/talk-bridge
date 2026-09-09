#!/usr/bin/env node
/**
 * 진단 — 붙기 전에 무엇이 빠졌는지 한 화면에서 확인한다.
 *   node scripts/doctor.mjs
 *
 * 01 샘플과 달리 CLI·게이트웨이 데몬이 없다. 대신 REST 인증과 **공인 URL 도달성**을 본다.
 */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { config } from '../server/config.js';
import { call, me as apiMe, rooms as apiRooms } from '../server/api.js';
import { verifySignature } from '../server/signature.js';

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

console.log('\nTalkBridge 샘플 진단 (REST × 호스티드 웹훅)');
console.log('─'.repeat(60));

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
console.log('\n[1] 런타임');
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — 18 이상 필요`);
if (major < 21) warn('Node 18~20 은 fetch 가 experimental 이라 첫 호출에 경고 한 줄이 찍힐 수 있습니다(동작에는 무관)');

/* 2. 설정 */
console.log('\n[2] 설정 (.env)');
ok(`REST 베이스: ${config.apiBase}`);
config.apiKey.startsWith('blumnb-')
  ? ok('TB_API_KEY 형식 (blumnb-)')
  : warn('TB_API_KEY 가 blumnb- 로 시작하지 않습니다 — Agent API 키가 맞는지 확인');
config.webhookSecret.startsWith('whsec_')
  ? ok('TB_WEBHOOK_SECRET 형식 (whsec_)')
  : warn('TB_WEBHOOK_SECRET 이 whsec_ 로 시작하지 않습니다 — 센터 Webhook 연결의 시크릿을 넣었는지 확인');
if (config.apiKey === config.webhookSecret) bad('TB_API_KEY 와 TB_WEBHOOK_SECRET 이 같습니다 — 둘은 별개의 값입니다');

/* 3. 인증 */
console.log('\n[3] 인증 (GET /api/agent/me)');
let me = null;
try {
  me = await apiMe();
  ok(`이름: ${me.name}`);
  me.scope === 'BrandWrite' || me.scope === 'Admin'
    ? ok(`권한: ${me.scope} (발신 가능)`)
    : warn(`권한: ${me.scope} — 발신하려면 BrandWrite 이상이 필요합니다`);
  me.brands.includes(config.brand)
    ? ok(`브랜드 ${config.brand} 접근 가능`)
    : bad(`TB_BRAND=${config.brand} 가 허용 브랜드에 없음 (허용: ${me.brands.join(', ') || '없음'})`);
} catch (err) {
  bad(`인증 실패 — ${err.message}`);
}

/* 4. 상담 데이터 */
console.log('\n[4] 상담 데이터 (GET /api/agent/rooms)');
if (me) {
  try {
    const raw = await call('GET', 'api/agent/rooms', { query: { brand: config.brand, max: 5 } });
    const parsed = await apiRooms(5);
    ok(`상담방 ${parsed.length}개`);
    for (const r of parsed) console.log(`     · ${r.userKey}  [${r.status}]  최신#${r.lastSeq}  "${r.lastText}"`);
    if (!parsed.length && raw.ok) {
      warn('응답은 정상인데 방이 0개입니다 — 아직 상담이 없거나, 응답 봉투 구조가 바뀌었을 수 있습니다(server/api.js pick 확인)');
      console.log('     응답 키:', Object.keys(raw.body || {}).join(', '));
    }
  } catch (err) {
    bad(`rooms 실패: ${err.message}`);
  }
} else {
  warn('인증이 안 되어 건너뜀');
}

/* 5. 공개 URL 도달성 */
console.log('\n[5] 공개 수신 URL');
if (!config.publicUrl) {
  warn('TB_PUBLIC_URL 미설정 — 센터에 등록한 수신 URL 을 적어 두면 인터넷 경로로 도달 여부를 검사합니다');
} else {
  let u;
  try { u = new URL(config.publicUrl); } catch { u = null; }
  if (!u) bad(`TB_PUBLIC_URL 이 URL 형식이 아닙니다: ${config.publicUrl}`);
  else {
    u.protocol === 'https:' ? ok(`https: ${u.host}`) : bad('https 가 아닙니다 — 호스티드 게이트웨이는 HTTPS 공인 도메인으로만 전달합니다');
    if (u.pathname !== '/webhook') warn(`경로가 /webhook 이 아닙니다 (${u.pathname}) — 서버의 webhookPath 와 맞는지 확인`);

    // 사설/루프백 IP 는 SSRF 방어로 차단된다.
    const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd)/.test(ip);
    try {
      // 로컬 리졸버는 MagicDNS 등으로 사설 IP 를 줄 수 있어 공개 리졸버로 푼다.
      const r = new dns.Resolver();
      r.setServers(['8.8.8.8', '1.1.1.1']);
      const ips = (await r.resolve4(u.hostname).catch(() => [])).concat(await r.resolve6(u.hostname).catch(() => []));
      if (!ips.length) bad(`공개 DNS 에서 ${u.hostname} 을 풀지 못했습니다`);
      else {
        const pub = ips.filter((ip) => !isPrivate(ip));
        pub.length ? ok(`공개 DNS → ${pub.join(', ')}`) : bad(`공개 DNS 결과가 전부 사설 IP 입니다 (${ips.join(', ')}) — 전달되지 않습니다`);

        // 실제 인터넷 경로로 접속: 공개 IP 에 붙되 SNI/Host 는 호스트명으로 (curl --resolve 와 같음)
        const ip = pub.find((x) => net.isIPv4(x)) || pub[0];
        if (ip) {
          const status = await new Promise((resolve) => {
            const req = https.request({
              host: ip, servername: u.hostname, port: 443, method: 'POST', path: u.pathname,
              headers: { host: u.hostname, 'content-type': 'application/json' }, timeout: 10000,
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('timeout', () => { req.destroy(); resolve('timeout'); });
            req.on('error', (e) => resolve(`error: ${e.message}`));
            req.end('{"probe":1}');
          });
          if (status === 401) ok(`인터넷 경로 도달 → 401 (서명 없는 요청을 서버가 거부 — 정상)`);
          else if (status === 200) warn('인터넷 경로 도달 → 200 — 서명 없는 요청이 200 이면 서명 검증이 꺼져 있습니다');
          else if (typeof status === 'number') warn(`인터넷 경로 도달 → ${status} (서버가 안 떠 있으면 터널이 502/404 를 돌려줄 수 있습니다)`);
          else bad(`인터넷 경로 접속 실패 (${status}) — 터널/방화벽/DNS 확인`);
        }
      }
    } catch (err) {
      bad(`도달성 검사 실패: ${err.message}`);
    }
  }
}

/* 6. 서명 자기검증 — 성공뿐 아니라 실패 케이스도 본다 */
console.log('\n[6] 서명 로직 자기검증');
{
  const body = Buffer.from('{"userKey":"Uxxxx","kind":"message","seq":1,"brand":"' + config.brand + '"}', 'utf8');
  const sign = (secret, ts) => 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':').update(body).digest('hex');
  const now = String(Math.floor(Date.now() / 1000));
  const cases = [
    ['올바른 서명', { 'x-bridge-signature': sign(config.webhookSecret, now), 'x-bridge-timestamp': now }, true],
    ['잘못된 시크릿', { 'x-bridge-signature': sign('whsec_wrong', now), 'x-bridge-timestamp': now }, false],
    ['재직렬화된 본문(공백 추가)', { 'x-bridge-signature': sign(config.webhookSecret, now), 'x-bridge-timestamp': now }, true, Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1))],
    ['헤더 없음', {}, false],
  ];
  if (config.toleranceSec > 0) {
    const old = String(Math.floor(Date.now() / 1000) - config.toleranceSec - 60);
    cases.push(['오래된 타임스탬프(리플레이)', { 'x-bridge-signature': sign(config.webhookSecret, old), 'x-bridge-timestamp': old }, false]);
  } else {
    warn('TB_SIGNATURE_TOLERANCE_SEC=0 — 리플레이 검사가 꺼져 있습니다');
  }
  for (const [label, headers, expectOk, altBody] of cases) {
    const v = verifySignature(headers, altBody || body);
    const pass = altBody ? !v.ok : v.ok === expectOk; // 재직렬화 케이스는 "실패해야 정상"
    pass ? ok(`${label} → ${v.ok ? '통과' : `거부(${v.reason})`}`) : bad(`${label} → 기대와 다름: ${JSON.stringify(v)}`);
  }
}

console.log('\n' + '─'.repeat(60));
console.log('다음: 센터 "상담 받을 곳 연결 → Webhook" 에 TB_PUBLIC_URL 등록 → npm start → 카카오톡에서 문의 전송\n');
