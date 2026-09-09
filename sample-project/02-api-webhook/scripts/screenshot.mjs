#!/usr/bin/env node
/**
 * 소개용 스크린샷 생성 — docs/screenshot.png
 *
 *   node scripts/screenshot.mjs [출력경로]
 *
 * 샘플 자체는 의존성이 0개입니다. 이 스크립트만 Playwright 를 씁니다(선택).
 *   npm i -g @playwright/cli   또는   npx playwright install chromium
 *
 * Playwright 가 기대하는 브라우저 빌드와 설치된 빌드가 어긋나
 * "Executable doesn't exist" 가 나면 실행파일을 직접 지정하세요:
 *   TB_CHROMIUM=".../ms-playwright/chromium-<빌드>/chrome-win64/chrome.exe" npm run screenshot
 *
 * 서버(`npm start`)가 떠 있어야 합니다.
 * 실행 중 서명된 이벤트를 스스로 주입해 "실시간 수신" 장면까지 담습니다.
 * 실제 발신은 하지 않습니다(입력창에 초안만 채웁니다).
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../server/config.js';
import { rooms as apiRooms, roomMessages } from '../server/api.js';

const BASE = `http://${config.host}:${config.port}`;
const OUT = process.argv[2] || path.join(config.root, 'docs', 'screenshot.png');

/* ── Playwright 로드 (전역 설치본도 찾아본다) ────────────────────────── */
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
      if (fs.existsSync(entry)) {
        return (await import('file:///' + entry.replace(/\\/g, '/'))).chromium;
      }
    }
  } catch { /* 무시 */ }

  console.error('Playwright 를 찾지 못했습니다. 설치 후 다시 실행하세요:');
  console.error('  npm i -g @playwright/cli && npx playwright install chromium');
  process.exit(1);
}

/** 호스티드 게이트웨이가 보내는 것과 동일한 형태의 서명된 이벤트를 주입한다. */
async function inject(userKey, kind, seq) {
  const body = JSON.stringify({ userKey, kind, seq, brand: config.brand });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', config.webhookSecret)
    .update('v0:' + ts + ':').update(Buffer.from(body, 'utf8')).digest('hex');

  const r = await fetch(BASE + '/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-bridge-signature': sig,
      'x-bridge-timestamp': ts,
      'x-bridge-event': kind,
      'x-bridge-delivery-id': crypto.randomUUID(),
    },
    body,
  });
  console.log(`  주입 ${kind} #${seq} → ${r.status}`);
}

/* ── 실행 ────────────────────────────────────────────────────────────── */

const res = await fetch(BASE + '/api/stats').catch(() => null);
if (!res?.ok) {
  console.error(`서버가 응답하지 않습니다 (${BASE}). 먼저 npm start 로 띄우세요.`);
  process.exit(1);
}

// 진행중인 방과 최근 이벤트를 REST 에서 그대로 읽어 온다(하드코딩 금지).
const rooms = await apiRooms(20);
const live = rooms.find((r) => !r.ended) || rooms[0];
if (!live) {
  console.error('상담방이 없습니다. 고객 문의가 하나라도 있어야 화면을 찍을 수 있습니다.');
  process.exit(1);
}
const recent = (await roomMessages(live.userKey, 20)).slice(-3);

const chromium = await loadChromium();
const browser = await chromium.launch(
  process.env.TB_CHROMIUM ? { executablePath: process.env.TB_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1400, height: 760 }, deviceScaleFactor: 2 });

// SSE 가 계속 열려 있어 networkidle 은 오지 않는다.
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.room', { timeout: 15000 });

for (const el of await page.$$('.room')) {
  if ((await el.innerText()).includes(live.userKey)) { await el.click(); break; }
}
await page.waitForSelector('.msg', { timeout: 15000 });
await page.waitForTimeout(1200);

// 최근 이벤트를 실제 kind 그대로 재생 → 이벤트 로그가 살아 있는 장면이 된다.
for (const m of recent) {
  await inject(live.userKey, m.kind, m.seq);
  await page.waitForTimeout(2500);
}

await page.fill('#input', '가격은 Pro 100 기준 월 15,000원(VAT 별도)이며 상담 100건이 포함됩니다.');
await page.waitForTimeout(500);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
await browser.close();

console.log(`\n✓ 저장 → ${OUT}`);
console.log('  주의: 재실행 시 같은 seq 는 멱등 처리되어 이벤트 로그가 비어 보입니다.');
console.log('        로그까지 채우려면 서버를 재기동한 뒤 실행하세요.');
