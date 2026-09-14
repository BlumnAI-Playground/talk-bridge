#!/usr/bin/env node
/**
 * 터미널 시뮬레이터 — 서버·게이트웨이·카카오 발신 없이 규칙과 맥락 유지를 확인한다 (OpenAI 만 호출).
 *
 *   npm run sim                                  대화형 (빈 줄: 종료, /reset: 초기화, /prompt: 지침 보기)
 *   npm run sim -- "요금이 궁금해요" "한 달 200명"   인자 = 고객 메시지를 차례로 보낸다
 *
 * 웹 화면의 [시뮬레이터] 와 같은 엔진(server/bot.js simulate)을 쓴다. 규칙은 data/bot.json (없으면 데모).
 */

import readline from 'node:readline';
import { config } from '../server/config.js';
import { simulate, resetSim, previewInstructions } from '../server/bot.js';
import { effectiveModel } from '../server/rules.js';

const SIM = 'terminal';
const { model, effort } = effectiveModel();
console.log(`\n자동응대 시뮬레이터 — ${model} · 추론 ${effort || '(모델 기본)'} · 키 ${config.openai.apiKey ? config.openai.keySource : '없음'}`);
if (!config.openai.apiKey) {
  console.error(`✗ ${config.openai.keyError}`);
  process.exit(1);
}

async function turn(text, echo = true) {
  if (echo) console.log(`\n고객 ▸ ${text}`);
  try {
    const r = await simulate(SIM, text);
    if (r.skipped) return console.log(`  (응답 없음) ${r.reason}`);
    const d = r.detail;
    console.log(`봇   ◂ ${r.reply}`);
    console.log(`       └ ${r.action} · ${d.scenario || '시나리오 없음'}${d.switched ? ' (전환)' : ''}${d.completed ? ' · 완료' : ''}` +
      `${d.collected && Object.keys(d.collected).length ? ` · 정보 ${JSON.stringify(d.collected)}` : ''}` +
      `${d.ms != null ? ` · ${d.ms}ms · in ${d.tokens?.input} / out ${d.tokens?.output} (추론 ${d.tokens?.reasoning ?? 0})` : ''}`);
    if (d.reason) console.log(`       └ 근거: ${d.reason}`);
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
  if (t === '/prompt') { console.log(previewInstructions(SIM)); return rl.prompt(); }
  rl.pause();
  await turn(t, false);
  rl.resume();
  rl.prompt();
});
rl.on('close', () => process.exit(0));
