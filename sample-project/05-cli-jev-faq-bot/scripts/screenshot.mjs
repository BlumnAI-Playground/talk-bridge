#!/usr/bin/env node
/**
 * 소개용 스크린샷 생성 — docs/*.png
 *
 *   node scripts/screenshot.mjs [출력 디렉터리]
 *
 *   screenshot.png            시나리오 편집(선택지형 단계) + 시뮬레이터 대화 + Jev 판정 패널
 *   screenshot-faq.png        FAQ 카드 편집 + 곁가지 질문 판정
 *   screenshot-settings.png   판정 기준(확신도 구간)
 *
 * 샘플 자체는 의존성이 0개입니다. 이 스크립트만 Playwright 를 씁니다(선택).
 *   npm i -g @playwright/cli   또는   npx playwright install chromium
 * 브라우저 빌드가 어긋나면: TB_CHROMIUM=".../chrome.exe" npm run screenshot
 *
 * 서버(`npm start`)가 떠 있어야 합니다. 시뮬레이터로 대화를 돌립니다 — Jev 만 호출하고 카카오 발신은 하지 않습니다.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

process.env.JEV_OFFLINE_OK = '1';
const { config } = await import('../server/config.js');

const BASE = `http://${config.host}:${config.port}`;
const OUT = process.argv[2] || path.join(config.root, 'docs');

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
fs.mkdirSync(OUT, { recursive: true });

async function say(t) {
  await page.fill('#sim-input', t);
  await page.press('#sim-input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#sim-messages .typing'), null, { timeout: 60000 });
  console.log(`  턴 완료: ${t}`);
}
async function shot(name) {
  await page.waitForTimeout(400);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`✓ ${file}`);
}

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); // SSE 때문에 networkidle 은 오지 않는다
await page.waitForSelector('#nav-flows li[data-sel]', { timeout: 15000 });

// 1) 시나리오 + 대화
await page.click('#nav-flows li[data-sel="flow:0"]');
await say('안녕하세요');
await say('요금이 궁금해요');
await say('근데 환불은 어떻게 해요?');
await say('한달 250명정도?');
await shot('screenshot.png');

// 2) FAQ 편집 + 첫 메시지에 답이 있는 시나리오 (speculative fan-out)
await page.click('#btn-sim-reset');
await page.click('#nav-faqs li[data-sel="faq:3"]');
await say('연동하려는데 저희는 도메인이 없어요');
await say('웹훅이 계속 401이 떠요 ㅠ');
await shot('screenshot-faq.png');

// 3) 판정 기준
await page.click('#btn-sim-reset');
await page.click('#nav-basic li[data-sel="settings"]');
await say('디스코드 있나요?');
await shot('screenshot-settings.png');

await browser.close();
