#!/usr/bin/env node
/**
 * 진단 — 붙기 전에 무엇이 빠졌는지 한 화면에서 확인한다.
 *   node scripts/doctor.mjs
 *
 * 01 의 진단 7종 + [8] 상담지식 그래프(온톨로지) 준비 상태.
 * 이 샘플은 CLI v1.1.0+ (`--json`, 게이트웨이 조회 API, `query --write`) 를 요구한다 — [2] 에서 확인.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../server/config.js';
import {
  launcherInfo, cliVersion, versionAtLeast, MIN_CLI_VERSION,
  cliWhoami, cliRooms, cliGatewayStatus, cliKnowledgeStatus,
} from '../server/cli.js';

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

console.log('\nTalkBridge 샘플 진단 (CLI × 게이트웨이 + 상담지식 그래프)');
console.log('─'.repeat(60));

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
console.log('\n[1] 런타임');
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — 18 이상 필요`);

/* 2. CLI 위치·버전 */
console.log('\n[2] CLI');
const L = launcherInfo();
if (L.mode === 'shell') {
  warn(`런처 JS 를 못 찾아 PATH+shell 폴백 사용 (${L.target})`);
  warn('  메시지에 " & % 같은 문자가 있으면 깨질 수 있습니다.');
  warn(`  ${config.cli} env --json 의 launcherPath 를 TB_CLI_BIN 으로 지정하는 것을 권장합니다.`);
} else {
  ok(`${config.cli} → ${L.mode}: ${L.target}`);
}

const ver = await cliVersion();
if (!ver) bad(`--version 실패 — ${config.cli} 가 설치되어 있나요? (npm install -g @blumn-dev/talkbridge-cli)`);
else if (versionAtLeast(ver)) ok(`버전: v${ver} (요구: v${MIN_CLI_VERSION}+)`);
else bad(`버전: v${ver} — 이 샘플은 v${MIN_CLI_VERSION}+ 가 필요합니다 (--json · 게이트웨이 조회 API · query --write). npm install -g @blumn-dev/talkbridge-cli@latest`);

/* 3. 인증 */
console.log('\n[3] 인증 (whoami)');
let me = null;
try {
  me = await cliWhoami();
  ok(`이름: ${me.name}`);
  ok(`엔드포인트: ${me.endpoint}`);
  me.scope === 'BrandWrite' || me.scope === 'Admin'
    ? ok(`권한: ${me.scope} (발신 가능)`)
    : warn(`권한: ${me.scope} — 발신하려면 BrandWrite 이상이 필요합니다`);
  me.brands.includes(config.brand)
    ? ok(`브랜드 ${config.brand} 접근 가능`)
    : bad(`TB_BRAND=${config.brand} 가 허용 브랜드에 없음 (허용: ${me.brands.join(', ') || '없음'})`);
} catch (err) {
  bad(`whoami 실패 — ${config.cli} login 으로 먼저 인증하세요 (${err.message})`);
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
      if (url && !url.includes(`:${config.port}/`)) {
        warn(`sink 가 이 서버 포트(${config.port})가 아닙니다 — 01 등 다른 샘플용 설정일 수 있습니다. npm run gateway:setup 으로 이 샘플로 향하게 하세요`);
      }
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
try {
  const gw = await cliGatewayStatus();
  gw.running
    ? ok(`실행 중 (pid ${gw.pid})${gw.knowledgeApi ? ` · 지식 조회 API ${gw.knowledgeApi}` : ''}`)
    : warn('중지됨 — npm run gateway:start');
} catch (err) {
  warn(`상태 불명 (${err.message}) — npm run gateway:start`);
}

/* 6. 상담방 */
console.log('\n[6] 상담 데이터');
try {
  const rooms = await cliRooms(5);
  ok(`상담방 ${rooms.length}개 (rooms --json)`);
  for (const r of rooms) console.log(`     · ${r.userKey}  [${r.status}]  최신#${r.lastSeq}  "${r.lastText}"`);
  if (!rooms.length) warn('상담방이 없습니다 — 고객이 카카오톡에서 문의를 보내면 나타납니다');
} catch (err) {
  bad(`rooms 실패: ${err.message}`);
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

/* 8. 상담지식 그래프 (03) */
console.log('\n[8] 상담지식 그래프 (knowledge)');
const s = await cliKnowledgeStatus();
if (!s.ok) {
  bad(`knowledge status 실패: ${s.error} — CLI v${MIN_CLI_VERSION}+ 인지 [2] 를 확인하세요`);
} else {
  s.libInstalled ? ok(`LadybugDB lib: ${s.lib}`) : warn('LadybugDB lib 미설치 — npm run knowledge:install');
  s.active ? ok('온톨로지 활성') : warn('온톨로지 비활성 — npm run knowledge:install 이 활성까지 처리합니다');
  if (s.dbPath) ok(`DB: ${s.dbPath}`);
  s.ai?.entityExtraction
    ? ok('엔티티 추출(AI): 사용 — 게이트웨이가 Entity/MENTIONS 를 채웁니다')
    : ok('엔티티 추출(AI): 미사용 — 고객→문의→응답만 적재 (이 샘플은 AI 를 쓰지 않으므로 정상)');
  if (s.nodes != null) {
    ok(`그래프: 노드 ${s.nodes} · 엣지 ${s.edges}${s.via === 'gateway' ? ` (게이트웨이 pid ${s.holderPid} 조회 API 경유)` : ''}`);
    if (s.nodes === 0) warn('그래프가 비어 있습니다 — npm run demo:seed (데모 데이터) 또는 npm run knowledge:build (과거 상담)');
  } else if (s.error) {
    warn(`그래프 통계를 읽지 못했습니다: ${s.error}`);
  }
}

console.log('\n' + '─'.repeat(60));
console.log('다음: npm run gateway:setup → npm run gateway:start → npm start');
console.log('그래프: npm run knowledge:install → npm run demo:seed (AI 설정 불필요)\n');
