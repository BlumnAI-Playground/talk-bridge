#!/usr/bin/env node
/**
 * 소개용 스크린샷 생성 — docs/screenshot.png (규칙 편집 + 시뮬레이터 대화)
 *
 *   node scripts/screenshot.mjs [출력경로]
 *
 * 샘플 자체는 의존성이 0개입니다. 이 스크립트만 Playwright 를 씁니다(선택).
 *   npm i -g @playwright/cli   또는   npx playwright install chromium
 * 브라우저 빌드가 어긋나면: TB_CHROMIUM=".../chrome.exe" npm run screenshot
 *
 * 서버(`npm start`)가 떠 있어야 합니다.
 * 시뮬레이터로 대화를 3턴 돌립니다 — OpenAI 만 호출하고 카카오 발신은 하지 않습니다.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../server/config.js';

const BASE = `http://${config.host}:${config.port}`;
const OUT = process.argv[2] || path.join(config.root, 'docs', 'screenshot.png');
const TURNS = ['안녕하세요, 요금이 궁금해요', '한 달에 250명 정도 상담할 것 같아요', '결제는 어디로 문의하면 되나요?'];

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch { /* 로컬에 없으면 전역을 뒤진다 */ }
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8', shell: process.platform === 'win32',
    }).trim();
    for (const rel of ['playwright', '@playwright/cli/node_modules/playwright']) {
      const entry = path.join(root, rel, 'index.mjs');
      if (fs.existsSync(entry)) return (await import('file:///' + entry.replace(/\\/g, '/'))).chromium;
    }
  } catch { /* 무시 */ }
  console.error('Playwright 를 찾지 못했습니다. 설치 후 다시 실행하세요:');
  console.error('  npm i -g @playwright/cli && npx playwright install chromium');
  process.exit(1);
}

const res = await fetch(BASE + '/api/stats').catch(() => null);
if (!res?.ok) {
  console.error(`서버가 응답하지 않습니다 (${BASE}). 먼저 npm start 로 띄우세요.`);
  process.exit(1);
}

const chromium = await loadChromium();
const browser = await chromium.launch(process.env.TB_CHROMIUM ? { executablePath: process.env.TB_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); // SSE 때문에 networkidle 은 오지 않는다
await page.waitForSelector('#nav-scenarios li[data-sel]', { timeout: 15000 });
await page.click('#nav-scenarios li[data-sel="scenario:0"]');

for (const t of TURNS) {
  await page.fill('#sim-input', t);
  await page.press('#sim-input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#sim-messages .typing'), null, { timeout: 90000 });
  console.log(`  턴 완료: ${t}`);
}
await page.waitForTimeout(600);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
await browser.close();
console.log(`\n✓ 저장 → ${OUT}`);
