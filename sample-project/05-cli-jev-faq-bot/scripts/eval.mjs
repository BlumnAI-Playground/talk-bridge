#!/usr/bin/env node
/**
 * 한국어 평가 — 규칙이 실제 문의를 얼마나 맞게 고르는지, 임계값이 적절한지 숫자로 본다 (Jev 만 호출 · 카카오 발신 없음).
 *
 *   npm run eval                          data/eval-set.json × 현재 규칙(data/bot.json, 없으면 데모)
 *   npm run eval -- --set my-set.json     다른 평가 세트
 *   npm run eval -- --out report.json     결과를 파일로도
 *
 * 봇과 **같은 요청 조립(buildRequest)** 을 쓴다 — 평가와 실전의 질문이 어긋나지 않는다.
 *
 * 보는 것
 *   정답률(top-1)       Jev 가 고른 1순위가 기대값인가
 *   갈래(임계값 적용)   자동 답변 · 되묻기 · 모를 때 — 규칙의 settings 임계값 그대로
 *     ✓ 자동-정답   좋다              ✗ 자동-오답   **가장 나쁘다** (틀린 답을 확신하고 보냄)
 *     ? 되묻기       안전 (한 턴 손해)  · 모를 때     정답이 none 이면 정답, 아니면 놓침
 *   지연 p50/p95 · 입력 토큰 · 예상 비용
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.JEV_OFFLINE_OK = '1';
const { config } = await import('../server/config.js');
const { systemOne } = await import('../server/jev.js');
const { buildRequest, blankState } = await import('../server/bot.js');
const { loadRules, OFF_TOPIC } = await import('../server/rules.js');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const setFile = path.resolve(config.root, arg('--set') || 'data/eval-set.json');
const outFile = arg('--out');

if (!config.jev.apiKey) { console.error(`✗ ${config.jev.keyError}`); process.exit(1); }
const set = JSON.parse(fs.readFileSync(setFile, 'utf8'));
const rules = loadRules();
const S = rules.settings;
const BUILTIN = new Set(['greeting', 'thanks', 'none']);

console.log(`\nJev 한국어 평가 — ${path.relative(config.root, setFile)} · 의도 ${set.intent?.length || 0}건 · 단계 대답 ${set.steps?.length || 0}건`);
console.log(`임계값: 자동 답변 ≥ ${S.autoThreshold} · 되묻기 ≥ ${S.confirmThreshold} (규칙 settings)\n`);

/** 동시 4개 — 속도 제한에 걸리지 않을 정도로 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function route(choice, conf, isNoneLike) {
  if (isNoneLike(choice) || conf < S.confirmThreshold) return 'fallback';
  return conf >= S.autoThreshold ? 'auto' : 'clarify';
}

async function runIntent(c) {
  const state = blankState();
  const req = buildRequest(rules, state, [{ role: 'user', text: c.text }], [c.text]);
  const r = await systemOne({ state: req.state, questions: req.questions });
  const a = r.answers.intent;
  const rt = BUILTIN.has(c.expect) && c.expect !== 'none'
    ? (a.confidence >= S.confirmThreshold ? 'auto' : 'fallback')          // 인사·감사는 되묻지 않는다
    : route(a.choice, a.confidence, (x) => x === 'none');
  return { kind: 'intent', ...c, got: a.choice, conf: a.confidence, route: rt, ok: a.choice === c.expect, ms: r.ms, tokens: r.usage.input_tokens };
}

async function runStep(c) {
  const flow = rules.flows.find((f) => f.id === c.flow);
  const step = flow?.steps.find((s) => s.id === c.step);
  if (!step) return { kind: 'step', ...c, error: `규칙에 ${c.flow}/${c.step} 없음` };
  const state = { ...blankState(), flowId: flow.id, stepId: step.id };
  const req = buildRequest(rules, state, [{ role: 'assistant', text: step.ask }, { role: 'user', text: c.text }], [c.text]);
  const r = await systemOne({ state: req.state, questions: req.questions });
  const a = r.answers.step;
  // 엔진과 같게: 단계 대답은 되묻기 기준 이상이면 받아들인다
  const rt = a.choice === OFF_TOPIC || a.confidence < S.confirmThreshold ? 'fallback' : 'auto';
  return { kind: 'step', ...c, got: a.choice, conf: a.confidence, route: rt, ok: a.choice === c.expect, ms: r.ms, tokens: r.usage.input_tokens };
}

const t0 = Date.now();
const results = [
  ...(await pool(set.intent || [], 4, runIntent)),
  ...(await pool(set.steps || [], 4, runStep)),
];

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const mark = (x) => {
  if (x.error) return '!!';
  const noneLike = x.expect === 'none' || x.expect === OFF_TOPIC;
  if (x.route === 'fallback') return noneLike ? '✓·' : '··';
  if (x.route === 'clarify') return x.ok ? '?✓' : '?✗';
  return x.ok ? '✓ ' : '✗ ';
};

for (const x of results) {
  if (x.error) { console.log(`!! ${x.error}`); continue; }
  const where = x.kind === 'step' ? `[${x.flow}/${x.step}] ` : '';
  console.log(`${mark(x)} ${String(Math.round(x.conf * 100)).padStart(3)}% ${x.got.padEnd(16)} ${x.ok ? '' : `(기대 ${x.expect}) `}${where}${x.text}  · ${x.ms}ms`);
}

function summary(list, label) {
  const n = list.length;
  if (!n) return;
  const noneLike = (x) => x.expect === 'none' || x.expect === OFF_TOPIC;
  const top1 = list.filter((x) => x.ok).length;
  const autoOk = list.filter((x) => x.route === 'auto' && x.ok).length;
  const autoBad = list.filter((x) => x.route === 'auto' && !x.ok).length;
  const clar = list.filter((x) => x.route === 'clarify').length;
  const fbOk = list.filter((x) => x.route === 'fallback' && noneLike(x)).length;
  const miss = list.filter((x) => x.route === 'fallback' && !noneLike(x)).length;
  console.log(`\n${label} (${n}건)`);
  console.log(`  1순위 정답률     ${top1}/${n} = ${pct(top1, n)}`);
  console.log(`  ✓ 자동 답변 정답  ${autoOk} (${pct(autoOk, n)})`);
  console.log(`  ✗ 자동 답변 오답  ${autoBad} (${pct(autoBad, n)})   ← 0 이어야 한다`);
  console.log(`  ? 되묻기          ${clar} (${pct(clar, n)})`);
  console.log(`  ✓· 모름(정답)     ${fbOk} · ·· 놓침 ${miss}`);
  return { n, top1, autoOk, autoBad, clarify: clar, fallbackOk: fbOk, missed: miss };
}

const ok = results.filter((x) => !x.error);
const sI = summary(ok.filter((x) => x.kind === 'intent'), '의도 판정');
const sS = summary(ok.filter((x) => x.kind === 'step'), '단계 대답 판정');

const ms = ok.map((x) => x.ms).sort((a, b) => a - b);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const tok = ok.reduce((s, x) => s + (x.tokens || 0), 0);
console.log(`\n지연  p50 ${q(0.5)}ms · p95 ${q(0.95)}ms · max ${ms[ms.length - 1]}ms (요청 1회 = 봇 한 턴과 같은 질문 수)`);
console.log(`토큰  입력 평균 ${Math.round(tok / ok.length)} / 턴 · 합계 ${tok} → 약 $${((tok / 1e6) * 0.042).toFixed(5)} (입력 $0.042/MTok, 출력 무료 — 벤더 공시가)`);
console.log(`소요  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

if (outFile) {
  fs.writeFileSync(path.resolve(config.root, outFile), JSON.stringify({
    at: new Date().toISOString(), model: config.jev.model, thresholds: { auto: S.autoThreshold, confirm: S.confirmThreshold },
    summary: { intent: sI, steps: sS, p50: q(0.5), p95: q(0.95) }, results,
  }, null, 2) + '\n');
  console.log(`→ ${outFile}`);
}
