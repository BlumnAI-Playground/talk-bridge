#!/usr/bin/env node
/**
 * 터미널 시뮬레이터 — 서버·게이트웨이·카카오 발신 없이 규칙과 Jev 판정을 확인한다 (Jev 만 호출).
 *
 *   npm run sim                                     대화형 (빈 줄: 종료, /reset: 초기화, /request: Jev 요청 보기)
 *   npm run sim -- "요금이 궁금해요" "한 달 250명"     인자 = 고객 메시지를 차례로 보낸다
 *
 * 웹 화면의 [시뮬레이터] 와 같은 엔진(server/bot.js simulate)을 쓴다. 규칙은 data/bot.json (없으면 데모).
 * TB_BRAND·TB_WEBHOOK_SECRET 없이도 돈다 (카카오에 붙지 않으므로).
 */

import readline from 'node:readline';

process.env.JEV_OFFLINE_OK = '1';
const { config } = await import('../server/config.js');
const { simulate, resetSim, previewRequest } = await import('../server/bot.js');

const SIM = 'terminal';
console.log(`\nJev 자동응대 시뮬레이터 — ${config.jev.model} · 키 ${config.jev.apiKey ? config.jev.keySource : '없음'}`);
if (!config.jev.apiKey) {
  console.error(`✗ ${config.jev.keyError}`);
  process.exit(1);
}

const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const top = (a) => (a?.top || []).map((t) => `${t.id} ${pct(t.p)}`).join(' · ');

async function turn(text, echo = true) {
  if (echo) console.log(`\n고객 ▸ ${text}`);
  try {
    const r = await simulate(SIM, text);
    if (r.skipped) return console.log(`  (응답 없음) ${r.reason}`);
    const d = r.detail;
    const j = d.jev;
    console.log(`봇   ◂ ${r.reply.replace(/\n/g, '\n       ')}`);
    console.log(`       └ ${r.action} · ${d.route} · ${d.reason || ''}${d.flow ? ` · 진행 ${d.flow}` : ''}` +
      `${Object.keys(d.collected || {}).length ? ` · 받은 정보 ${JSON.stringify(d.collected)}` : ''}`);
    if (j) {
      console.log(`       └ Jev ${j.ms}ms · in ${j.tokens.input} / out ${j.tokens.output} · 질문 ${j.questions.join(',')}`);
      console.log(`         의도 ${top(j.intent)}${j.step ? `  |  대답 ${top(j.step)}` : ''}`);
      console.log(`         상담원요청 ${pct(j.human)} · 불만 ${j.frustration ? j.frustration.score.toFixed(2) : '-'}/2${j.confirm != null ? ` · 확인 ${pct(j.confirm)}` : ''}`);
    }
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
}

const args = process.argv.slice(2);
if (args.length) {
  for (const a of args) await turn(a);
  console.log('');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n고객 ▸ ' });
rl.prompt();
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return rl.close();
  if (t === '/reset') { resetSim(SIM); console.log('  (대화 초기화)'); return rl.prompt(); }
  if (t === '/request') { console.log(JSON.stringify(previewRequest(SIM), null, 2)); return rl.prompt(); }
  rl.pause();
  await turn(t, false);
  rl.resume();
  rl.prompt();
});
rl.on('close', () => process.exit(0));
