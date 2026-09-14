#!/usr/bin/env node
/**
 * 진단 — 붙기 전에 무엇이 빠졌는지 한 화면에서 확인한다.
 *   node scripts/doctor.mjs
 *
 * 01 의 진단 7종 + [8] OpenAI 키·모델 호출 + [9] 자동응대 규칙.
 * 이 샘플은 CLI v1.1.0+ (`--json` — sessionId 로 대화 맥락을 자른다) 를 요구한다 — [2] 에서 확인.
 * [8] 은 OpenAI 를 한 번 짧게 호출한다(수십 토큰). 카카오 발신은 하지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config, maskKey } from '../server/config.js';
import {
  launcherInfo, cliVersion, versionAtLeast, MIN_CLI_VERSION,
  cliWhoami, cliRooms, cliGatewayStatus,
} from '../server/cli.js';
import { respondJson } from '../server/openai.js';
import { loadRules, effectiveModel } from '../server/rules.js';

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

console.log('\nTalkBridge 샘플 진단 (CLI × 게이트웨이 + 자동응대봇)');
console.log('─'.repeat(60));

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
console.log('\n[1] 런타임');
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — 18 이상 필요 (내장 fetch)`);

/* 2. CLI 위치·버전 */
console.log('\n[2] CLI');
const L = launcherInfo();
if (L.mode === 'shell') {
  warn(`런처 JS 를 못 찾아 PATH+shell 폴백 사용 (${L.target})`);
  warn('  메시지에 " & % 같은 문자가 있으면 깨질 수 있습니다 — 봇 답장에도 해당합니다.');
  warn(`  ${config.cli} env --json 의 launcherPath 를 TB_CLI_BIN 으로 지정하는 것을 권장합니다.`);
} else {
  ok(`${config.cli} → ${L.mode}: ${L.target}`);
}

const ver = await cliVersion();
if (!ver) bad(`--version 실패 — ${config.cli} 가 설치되어 있나요? (npm install -g @blumn-dev/talkbridge-cli)`);
else if (versionAtLeast(ver)) ok(`버전: v${ver} (요구: v${MIN_CLI_VERSION}+)`);
else bad(`버전: v${ver} — 이 샘플은 v${MIN_CLI_VERSION}+ 가 필요합니다 (--json). npm install -g @blumn-dev/talkbridge-cli@latest`);

/* 3. 인증 */
console.log('\n[3] 인증 (whoami)');
try {
  const me = await cliWhoami();
  ok(`이름: ${me.name}`);
  ok(`엔드포인트: ${me.endpoint}`);
  me.scope === 'BrandWrite' || me.scope === 'Admin'
    ? ok(`권한: ${me.scope} (발신 가능)`)
    : warn(`권한: ${me.scope} — 봇이 답장하려면 BrandWrite 이상이 필요합니다`);
  me.brands.includes(config.brand)
    ? ok(`브랜드 ${config.brand} 접근 가능`)
    : bad(`TB_BRAND=${config.brand} 가 허용 브랜드에 없음 (허용: ${me.brands.join(', ') || '없음'})`);
} catch (err) {
  bad(`whoami 실패 — ${config.cli} login 으로 먼저 인증하세요 (${err.message})`);
}

/* 4. 설정 파일 */
console.log('\n[4] CLI 설정 파일');
const candidates = [
  path.join(os.homedir(), '.bridge-agent', 'config.json'),
  path.join(os.homedir(), '.talkbridge', 'config.json'),
];
const cfgPath = candidates.find((p) => fs.existsSync(p));
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
        warn(`sink 가 이 서버 포트(${config.port})가 아닙니다 — 다른 샘플용 설정입니다. 봇이 메시지를 못 받습니다 → npm run gateway:setup`);
      }
      if (secret && secret !== config.webhookSecret) {
        bad('CLI 의 webhook secret 과 .env 의 TB_WEBHOOK_SECRET 이 다릅니다 → 서명 검증이 전부 401 로 떨어집니다');
      } else if (secret) {
        ok('서명 시크릿 일치');
      } else {
        warn('서명 시크릿이 비어 있습니다 — 무서명 릴레이라 위조 요청을 막을 수 없습니다 (봇이 위조 메시지에 답할 수 있음)');
      }
    }
    // CLI 자체 AI 설정은 이 샘플과 무관하다 — 봇은 서버가 직접 OpenAI 를 부른다.
  } catch (err) {
    warn(`설정 파싱 실패: ${err.message}`);
  }
}

/* 5. 게이트웨이 */
console.log('\n[5] 게이트웨이');
try {
  const gw = await cliGatewayStatus();
  gw.running ? ok(`실행 중 (pid ${gw.pid})`) : warn('중지됨 — npm run gateway:start (시뮬레이터는 게이트웨이 없이 됩니다)');
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

/* 8. OpenAI */
console.log('\n[8] OpenAI (자동응대)');
const rules = loadRules();
const { model, effort } = effectiveModel(rules);
if (!config.openai.apiKey) {
  bad(config.openai.keyError);
} else {
  ok(`키: ${maskKey(config.openai.apiKey)} (${config.openai.keySource})`);
  ok(`모델: ${model} · 추론 강도: ${effort || '(모델 기본)'}${rules.settings.model || rules.settings.reasoningEffort ? ' — 웹 [설정] 값' : ' — .env 기본값'}`);
  try {
    const r = await respondJson({
      instructions: '진단 요청이다. ok 를 true 로 답한다.',
      input: [{ role: 'user', content: 'ping' }],
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      schemaName: 'doctor',
      model, effort,
    });
    r.data.ok ? ok(`호출 성공 ${r.ms}ms · Responses API · JSON 스키마 응답 확인`) : warn('호출은 됐지만 응답이 예상과 다릅니다');
  } catch (err) {
    bad(err.message);
  }
}

/* 9. 규칙 */
console.log('\n[9] 자동응대 규칙');
ok(`파일: ${fs.existsSync(config.botFile) ? path.relative(config.root, config.botFile) : `${path.relative(config.root, config.botDemoFile)} (데모 — 웹에서 저장하면 data/bot.json 생성)`}`);
rules.settings.enabled ? ok('봇: 켜짐') : warn('봇: 꺼짐 — 웹 상단 [봇 켜기]');
rules.settings.live
  ? warn('실발신: 켜짐 — 실제 고객에게 답장이 발송되고 건수를 소진합니다')
  : ok('실발신: 꺼짐 (dry-run — 답장을 만들어 모니터에만 보여줌)');
const active = rules.scenarios.filter((s) => s.enabled);
ok(`시나리오 ${active.length}/${rules.scenarios.length}개 사용 · 공통 지식 ${rules.knowledge.length}개 · 연결 키워드 ${rules.handoff.keywords.length}개`);
for (const s of active) console.log(`     · [${s.id}] ${s.name} — ${s.steps.length}단계 → 완료 후 ${s.onComplete}`);

console.log('\n' + '─'.repeat(60));
console.log('다음: npm run gateway:setup → npm run gateway:start → npm start');
console.log('규칙만 먼저 볼 때: npm start 후 웹 시뮬레이터, 또는 npm run sim\n');
