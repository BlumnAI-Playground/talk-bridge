#!/usr/bin/env node
/**
 * 데모 워크스루 스크린샷 — docs/walkthrough/NN-*.png  (규칙 설정 → 시뮬레이터 동작 → 카드 보강 → 모니터)
 *
 *   node scripts/walkthrough.mjs
 *
 * 격리 인스턴스로 돈다: PORT=8794 · TB_BOT_FILE=<임시 파일> 로 서버를 직접 띄웠다가 끝나면 끈다.
 *   → 운영 규칙(data/bot.json)·실발신 상태를 건드리지 않는다. 데모 규칙은 실발신 OFF 로 시작하고, 켜져 있으면 중단한다.
 *   → Jev 만 호출한다 (약 20턴 ≈ $0.003). 카카오 발신 0건.
 *
 * Playwright 가 필요하다 (screenshot.mjs 와 같다). 브라우저 빌드가 어긋나면 TB_CHROMIUM=".../chrome.exe"
 */

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'walkthrough');
const PORT = Number(process.env.WALK_PORT || 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const BOT_FILE = path.join(os.tmpdir(), `tb-05-walkthrough-${process.pid}.json`);

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { /* 전역을 뒤진다 */ }
  const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  for (const rel of ['playwright', '@playwright/cli/node_modules/playwright']) {
    const entry = path.join(root, rel, 'index.mjs');
    if (fs.existsSync(entry)) return (await import('file:///' + entry.replace(/\\/g, '/'))).chromium;
  }
  throw new Error('Playwright 를 찾지 못했습니다 — npm i -g @playwright/cli && npx playwright install chromium');
}

/* ── 격리 서버 ─────────────────────────────────────────────────────── */

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TB_BOT_FILE: BOT_FILE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const stop = () => { try { server.kill(); } catch { /* 이미 종료 */ } try { fs.rmSync(BOT_FILE, { force: true }); } catch { /* 무시 */ } };
process.on('exit', stop);

for (let i = 0; i < 60; i++) {
  const ok = await fetch(BASE + '/api/stats').then((r) => r.ok).catch(() => false);
  if (ok) break;
  if (i === 59) { console.error('격리 서버가 뜨지 않았습니다'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`격리 서버 ${BASE} · 규칙 ${BOT_FILE}`);

/* ── 브라우저 ─────────────────────────────────────────────────────── */

const chromium = await loadChromium();
const browser = await chromium.launch(process.env.TB_CHROMIUM ? { executablePath: process.env.TB_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('dialog', (d) => d.accept()); // 초기화 확인창
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
async function shot(name, note) {
  await page.waitForTimeout(350);
  const file = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`✓ ${path.relative(ROOT, file)}  — ${note}`);
}

/** 설명할 요소에 빨간 테두리 (스크린샷용 · 다음 highlight 때 지운다) */
async function highlight(...selectors) {
  await page.evaluate((sels) => {
    document.querySelectorAll('[data-walk]').forEach((el) => { el.style.outline = ''; el.removeAttribute('data-walk'); });
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) { el.style.outline = '3px solid #e5484d'; el.style.outlineOffset = '2px'; el.setAttribute('data-walk', '1'); }
    }
  }, selectors);
}

async function scrollEditorTo(selector) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const box = document.getElementById('editor');
    if (el && box) box.scrollTop = el.offsetTop - box.offsetTop - 12;
  }, selector);
}

async function say(t) {
  await page.fill('#sim-input', t);
  await page.press('#sim-input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#sim-messages .typing'), null, { timeout: 60000 });
  console.log(`    고객 ▸ ${t}`);
}
async function resetSim() {
  await page.click('#btn-sim-reset');
  await page.waitForTimeout(200);
}

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#nav-faqs li[data-sel]', { timeout: 15000 });
if (await page.isChecked('#sw-live')) { console.error('실발신이 켜져 있어 중단합니다'); process.exit(1); }

// 1) FAQ 카드
await page.click('#nav-faqs li[data-sel="faq:3"]');
await highlight('[data-path="faqs.3.examples"]', '[data-path="faqs.3.notFor"]', '[data-path="faqs.3.answer"]');
await shot('faq-card', 'FAQ 카드 — Jev 가 고르는 기준(설명·예·경계) + 그대로 나가는 답변');

// 2) 시나리오 — 단계와 선택지
await page.click('#nav-flows li[data-sel="flow:0"]');
await scrollEditorTo('.step-card');
await highlight('.step-card');
await shot('flow-options', '선택지형 시나리오 — 고정 질문 · 판정 지시 · 선택지(라벨·대답 예·덧붙일 말·다음 단계)');

// 3) 판정 기준
await page.click('#nav-basic li[data-sel="settings"]');
await highlight('#gate-preview');
await shot('settings', '판정 기준 — 확신도 3구간 · 상담원 요청 · 매우 화남');

// 4) 봇 문구
await page.click('#nav-basic li[data-sel="persona"]');
await highlight('[data-path="persona.fallback"]', '[data-path="persona.clarify"]');
await shot('persona', '봇 문구 — 모를 때 · 되묻기 · 다시 묻기');

// 5) FAQ 즉답
await page.click('#nav-faqs li[data-sel="faq:0"]');
await say('건수 계산 기준이 머에요');
await highlight('[data-path="faqs.0.answer"]', '#jev-panel');
await shot('sim-faq', '시뮬레이터 — 오타가 섞인 질문에 FAQ 즉답 (Jev 판정 패널)');

// 6) 시나리오 + 곁가지 질문
await resetSim();
await page.click('#nav-flows li[data-sel="flow:0"]');
await scrollEditorTo('.step-card');
await highlight('#jev-panel');
await say('요금제 알려주세요');
await say('근데 환불은 어떻게 해요?');
await say('음 한 400명?');
await shot('sim-flow', '시나리오 — 곁가지 질문(환불)은 FAQ 로 답하고 복귀 → 짧은 대답을 선택지로 분류');

// 7) 첫 메시지에 답이 있으면 건너뛰기
await resetSim();
await page.click('#nav-flows li[data-sel="flow:2"]');
await scrollEditorTo('.step-card');
await say('웹훅이 계속 401이 떠요 ㅠ');
await page.evaluate(() => { const p = document.getElementById('jev-panel'); p.scrollTop = p.scrollHeight; });
await highlight('.step-card', '#jev-panel');
await shot('sim-prefill', 'speculative fan-out — 첫 메시지에 증상이 있어 1단계(증상)를 건너뛰고 2단계 질문');

// 8) 되묻기 → 아니요 → 전환
await resetSim();
await page.click('#nav-flows li[data-sel="flow:1"]');
await say('우리 서비스에 카톡 상담 붙이고 싶은데 어떻게 시작해요');
await highlight('#jev-panel');
await shot('sim-clarify', '되묻기 — 확신도가 자동 기준(80%) 미만이라 보내지 않고 확인');
await say('아뇨 채널 말고 연동 방법이요');
await shot('sim-clarify-no', '"아니요" → 확인 확률 낮음 → 이번 메시지로 다시 판정해 연동 상담 시작');

// 9) 카드 보강
const ex = '[data-path="flows.1.examples"]';
await page.click(ex);
await page.press(ex, 'End');
await page.evaluate((s) => { const t = document.querySelector(s); t.selectionStart = t.selectionEnd = t.value.length; }, ex);
await page.keyboard.type('\n우리 서비스에 카톡 상담 붙이고 싶어요');
await page.click('#btn-save');
await page.waitForFunction(() => document.getElementById('btn-save').textContent === '저장', null, { timeout: 10000 });
await scrollEditorTo(ex);
await highlight(ex);
await shot('tune-card', '카드 보강 — 되묻기가 난 표현을 "고객이 묻는 예" 에 한 줄 추가하고 저장');

// 10) 보강 후 같은 문장
await resetSim();
await say('우리 서비스에 카톡 상담 붙이고 싶은데 어떻게 시작해요');
await highlight('#jev-panel');
await shot('tune-result', '같은 문장 → 연동 상담으로 자동 판정 (규칙만 바꿨다 · 학습 없음)');

// 11) 상담원 연결
await resetSim();
await highlight();
await say('요금이 궁금해요');
await say('아 진짜 몇번을 말해요 짜증나네');
await say('여보세요?');
await shot('sim-handoff', '불만도 1.9/2 → 상담원 연결 · 이후 메시지에는 봇이 답하지 않음');

// 12) Jev 요청 보기
await resetSim();
await page.click('#btn-sim-request');
await page.fill('#request-sample', '연동하려는데 도메인이 없어요');
await page.click('#btn-request-refresh');
await page.waitForFunction(() => document.getElementById('request-text').textContent.includes('도메인이 없어요'));
await page.evaluate(() => {
  const pre = document.getElementById('request-text');
  const lines = pre.textContent.split(/\n/);
  const i = lines.findIndex((l) => l.includes('"wants_human"'));
  pre.scrollTop = Math.max(0, i - 3) * (pre.scrollHeight / lines.length);
});
await shot('request', 'Jev 요청 본문 — 한 번의 요청에 질문 6개 (의도 · 상담원 요청 · 불만 · 시나리오 첫 단계 3개)');
await page.keyboard.press('Escape');

// 13) 실시간 모니터
await page.click('.tab[data-view="monitor"]');
await page.waitForTimeout(1500);
const room = await page.$('#room-list li.room');
if (room) await room.click();
await page.waitForTimeout(1200);
await highlight('#activity', '.switch.live');
await shot('monitor', '실시간 모니터 — 실발신 OFF(dry-run) · 봇 활동에 Jev 판정 요약');

await browser.close();
stop();
console.log(`\n${n}장 → ${path.relative(ROOT, OUT)}`);
process.exit(0);
