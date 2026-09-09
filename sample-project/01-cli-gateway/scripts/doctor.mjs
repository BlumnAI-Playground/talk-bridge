#!/usr/bin/env node
/**
 * 진단 — 붙기 전에 무엇이 빠졌는지 한 화면에서 확인한다.
 *   node scripts/doctor.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../server/config.js';
import { runCli, launcherInfo, parseWhoami, parseRooms } from '../server/cli.js';

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

console.log('\nTalkBridge 샘플 진단');
console.log('─'.repeat(60));

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
console.log('\n[1] 런타임');
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — 18 이상 필요`);

/* 2. CLI 위치 */
console.log('\n[2] CLI');
const L = launcherInfo();
if (L.mode === 'shell') {
  warn(`런처 JS 를 못 찾아 PATH+shell 폴백 사용 (${L.target})`);
  warn('  메시지에 " & % 같은 문자가 있으면 깨질 수 있습니다.');
  warn('  TB_CLI_BIN 으로 실행파일 경로를 직접 지정하는 것을 권장합니다.');
} else {
  ok(`${config.cli} → ${L.mode}: ${L.target}`);
}

const ver = await runCli(['--version']);
ver.code === 0 ? ok(`버전: ${ver.stdout.trim()}`) : bad(`--version 실패: ${ver.stderr.trim()}`);

/* 3. 인증 */
console.log('\n[3] 인증 (whoami)');
const who = await runCli(['whoami']);
if (who.code !== 0) {
  bad(`whoami 실패 — ${config.cli} login 으로 먼저 인증하세요`);
  console.log(who.stdout + who.stderr);
} else {
  const me = parseWhoami(who.stdout);
  ok(`이름: ${me.name}`);
  ok(`엔드포인트: ${me.endpoint}`);
  me.scope === 'BrandWrite' || me.scope === 'Admin'
    ? ok(`권한: ${me.scope} (발신 가능)`)
    : warn(`권한: ${me.scope} — 발신하려면 BrandWrite 이상이 필요합니다`);

  me.brands.includes(config.brand)
    ? ok(`브랜드 ${config.brand} 접근 가능`)
    : bad(`TB_BRAND=${config.brand} 가 허용 브랜드에 없음 (허용: ${me.brands.join(', ') || '없음'})`);
}

/* 4. 설정 파일 */
console.log('\n[4] CLI 설정 파일');
// dev 채널은 ~/.bridge-agent, 운영 채널은 ~/.talkbridge 를 쓴다.
const candidates = [
  path.join(os.homedir(), '.bridge-agent', 'config.json'),
  path.join(os.homedir(), '.talkbridge', 'config.json'),
];
let cfgPath = candidates.find((p) => fs.existsSync(p));
if (!cfgPath) {
  bad('CLI 설정 파일 없음 — login/setup 을 먼저 실행하세요');
} else {
  ok(`설정: ${cfgPath}`);
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const wh = raw.webhook;
    if (!wh || (typeof wh === 'string' && !wh.trim())) {
      warn('webhook sink 미구성 — npm run gateway:setup 을 실행하세요');
    } else {
      const url = wh.url || wh.Url;
      const secret = wh.secret || wh.Secret;
      ok(`webhook sink: ${url || '(url 없음)'}`);
      if (secret && secret !== config.webhookSecret) {
        bad('CLI 의 webhook secret 과 .env 의 TB_WEBHOOK_SECRET 이 다릅니다 → 서명 검증이 전부 401 로 떨어집니다');
      } else if (secret) {
        ok('서명 시크릿 일치');
      } else {
        warn('서명 시크릿이 비어 있습니다 — 무서명 릴레이라 위조 요청을 막을 수 없습니다');
      }
    }
  } catch (err) {
    warn(`설정 파싱 실패: ${err.message}`);
  }
}

/* 5. 게이트웨이 */
console.log('\n[5] 게이트웨이');
const gw = await runCli(['gateway', 'status']);
const gwOut = (gw.stdout + gw.stderr).trim();
/실행 중/.test(gwOut) ? ok(gwOut) : warn(`${gwOut || '상태 불명'} — npm run gateway:start`);

/* 6. 상담방 */
console.log('\n[6] 상담 데이터');
const rooms = await runCli(['rooms', '--brand', config.brand, '--max', '5']);
if (rooms.code !== 0) {
  bad(`rooms 실패: ${(rooms.stderr || rooms.stdout).trim()}`);
} else {
  const parsed = parseRooms(rooms.stdout);
  ok(`상담방 ${parsed.length}개 파싱됨`);
  for (const r of parsed) console.log(`     · ${r.userKey}  [${r.status}]  최신#${r.lastSeq}  "${r.lastText}"`);
  if (!parsed.length && rooms.stdout.trim()) {
    warn('출력은 있는데 파싱된 방이 0개입니다 — CLI 출력 형식이 바뀌었을 수 있습니다(server/cli.js 파서 확인)');
  }
}

/* 7. 서명 자기검증 */
console.log('\n[7] 서명 로직 자기검증');
{
  const body = Buffer.from('{"userKey":"Uxxxx","kind":"message","seq":1,"brand":"' + config.brand + '"}', 'utf8');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', config.webhookSecret)
    .update('v0:' + ts + ':').update(body).digest('hex');
  const { verifySignature } = await import('../server/signature.js');
  const v = verifySignature({ 'x-bridge-signature': sig, 'x-bridge-timestamp': ts }, body);
  v.ok ? ok('HMAC 검증 통과') : bad(`HMAC 검증 실패: ${v.reason}`);
}

console.log('\n' + '─'.repeat(60));
console.log('다음: npm run gateway:setup → npm run gateway:start → npm start\n');
