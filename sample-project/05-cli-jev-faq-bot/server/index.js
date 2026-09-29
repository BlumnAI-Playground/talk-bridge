import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, webhookPath, maskKey } from './config.js';
import { handleWebhook } from './webhook.js';
import * as store from './store.js';
import { addClient, broadcast, clientCount } from './sse.js';
import { cliWhoami, cliRooms, cliRoomMessages, cliSend, launcherInfo } from './cli.js';
import { jevReady } from './jev.js';
import { loadRules, saveRules, resetToDemo } from './rules.js';
import * as bot from './bot.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  return JSON.parse((await readBody(req)).toString('utf8') || '{}');
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(config.publicDir, rel);

  // 디렉터리 탈출 방지
  if (!file.startsWith(config.publicDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

/** 화면에 보여줄 AI 상태 — 키는 마스킹만 */
function aiStatus() {
  return {
    ready: jevReady(),
    keySource: config.jev.keySource,
    keyMasked: maskKey(config.jev.apiKey),
    keyError: config.jev.keyError,
    baseUrl: config.jev.baseUrl,
    model: config.jev.model,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* ── 게이트웨이 수신 ─────────────────────────────────────────────── */
    if (req.method === 'POST' && p === webhookPath) {
      // 서명은 raw 바이트 기준이므로 절대 파싱해서 넘기지 않는다.
      const raw = await readBody(req);
      return handleWebhook(req, res, raw);
    }

    /* ── 브라우저 실시간 채널 ────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/events') {
      return addClient(res);
    }

    /* ── 상태 ────────────────────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/me') {
      const me = await cliWhoami().catch((err) => ({ error: err.message }));
      return json(res, 200, { ok: true, me, brand: config.brand, cli: config.cli, launcher: launcherInfo(), ai: aiStatus() });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      return json(res, 200, { ok: true, stats: { ...store.stats(), sseClients: clientCount() } });
    }

    /* ── 05: 자동응대 규칙 ───────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/bot/rules') {
      return json(res, 200, { ok: true, rules: loadRules(), ai: aiStatus() });
    }

    if (req.method === 'PUT' && p === '/api/bot/rules') {
      const { rules, warnings } = saveRules(await readJson(req));
      broadcast('rules', { savedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, rules, warnings, ai: aiStatus() });
    }

    if (req.method === 'POST' && p === '/api/bot/rules/reset') {
      const { rules, warnings } = resetToDemo();
      broadcast('rules', { savedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, rules, warnings, ai: aiStatus() });
    }

    /* ── 05: 시뮬레이터 (카카오 발신 없음 · Jev 만 호출) ────────────── */
    if (req.method === 'POST' && p === '/api/sim/message') {
      const { simId, text } = await readJson(req);
      if (!simId || !String(text || '').trim()) return json(res, 400, { ok: false, error: 'simId 와 text 가 필요합니다' });
      try {
        return json(res, 200, { ok: true, ...(await bot.simulate(String(simId), String(text).trim())) });
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && p === '/api/sim/reset') {
      const { simId } = await readJson(req);
      bot.resetSim(String(simId || ''));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/sim/request') {
      const request = bot.previewRequest(url.searchParams.get('simId') || '', url.searchParams.get('text') || undefined);
      return json(res, 200, { ok: true, request });
    }

    /* ── 05: 실시간 모니터 (실제 상담방 · CLI 경유) ────────────────────── */
    if (req.method === 'GET' && p === '/api/rooms') {
      const fresh = await cliRooms(Number(url.searchParams.get('max') || 50));
      store.hydrateRooms(fresh);
      return json(res, 200, { ok: true, rooms: store.listRooms(), bot: bot.roomStates() });
    }

    const mMsgs = /^\/api\/rooms\/([^/]+)\/messages$/.exec(p);
    if (req.method === 'GET' && mMsgs) {
      const userKey = decodeURIComponent(mMsgs[1]);
      const msgs = await cliRoomMessages(userKey, Number(url.searchParams.get('max') || 50));
      store.hydrateMessages(userKey, msgs);
      store.clearUnread(userKey);
      return json(res, 200, { ok: true, userKey, messages: store.getMessages(userKey), bot: bot.roomStates()[userKey] || null });
    }

    if (req.method === 'GET' && p === '/api/bot/activity') {
      return json(res, 200, { ok: true, activity: bot.recentActivity(), rooms: bot.roomStates() });
    }

    const mBot = /^\/api\/bot\/rooms\/([^/]+)\/(pause|resume)$/.exec(p);
    if (req.method === 'POST' && mBot) {
      const userKey = decodeURIComponent(mBot[1]);
      if (mBot[2] === 'pause') bot.pause(userKey, '운영자가 봇 정지');
      else bot.resume(userKey);
      return json(res, 200, { ok: true, state: bot.roomStates()[userKey] });
    }

    /* ── 상담원 직접 발신 (사람이 이어받을 때) ─────────────────────────── */
    if (req.method === 'POST' && p === '/api/send') {
      const { userKey, text } = await readJson(req);
      if (!userKey || !text) return json(res, 400, { ok: false, error: 'userKey 와 text 가 필요합니다' });

      // 사람이 답하면 그 방의 봇은 먼저 멈춘다 — echo 판별보다 확실하다.
      bot.pause(userKey, '상담원이 화면에서 직접 답장');
      const r = await cliSend(userKey, text);
      if (!r.ok) return json(res, 502, { ok: false, error: r.raw || '발신 실패' });

      store.upsertMessage(userKey, {
        seq: null, kind: 'agent', text, at: new Date().toISOString(),
        direction: 'out', pending: true,
      });
      broadcast('sent', { userKey, text, raw: r.raw });
      return json(res, 200, { ok: true, raw: r.raw });
    }

    /* ── 정적 파일 ───────────────────────────────────────────────────── */
    if (req.method === 'GET') return serveStatic(res, p);

    return json(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[http]', req.method, p, '→', err.message);
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(config.port, config.host, async () => {
  const L = launcherInfo();
  const rules = loadRules();
  const ai = aiStatus();
  console.log('');
  console.log('  TalkBridge CLI × Gateway — Jev 자동응대봇 샘플');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`  규칙 편집  http://${config.host}:${config.port}/`);
  console.log(`  수신 웹훅  http://${config.host}:${config.port}${webhookPath}`);
  console.log(`  브랜드     ${config.brand}`);
  console.log(`  CLI        ${config.cli}  (${L.mode}: ${L.target})`);
  console.log(`  Jev        ${ai.model} · 키 ${ai.ready ? `${ai.keyMasked} (${ai.keySource})` : '없음'}`);
  console.log(`  봇         ${rules.settings.enabled ? '켜짐' : '꺼짐'} · ${rules.settings.live ? '실발신' : 'dry-run (발신 안 함)'} · FAQ ${rules.faqs.filter((f) => f.enabled).length}개 · 시나리오 ${rules.flows.filter((f) => f.enabled).length}개 · 자동 답변 ≥ ${rules.settings.autoThreshold}`);
  console.log('');
  if (!ai.ready) console.warn(`  ! ${ai.keyError}\n`);

  // 부팅 백필 — 방별 lastSeq 를 봇에 알려 저널 재생분에 답하지 않게 한다.
  try {
    const me = await cliWhoami();
    console.log(`  ✓ CLI 인증 확인 — ${me.name} / ${me.scope} / 브랜드 ${me.brands.join(', ')}`);
    if (!me.brands.includes(config.brand)) {
      console.warn(`  ! 경고: TB_BRAND(${config.brand}) 가 키의 허용 브랜드에 없습니다`);
    }
    const rooms = await cliRooms(50);
    store.hydrateRooms(rooms);
    bot.rememberBootSeq(rooms);
    console.log(`  ✓ 기존 상담방 ${rooms.length}개 백필 — 이 시점 이전 메시지에는 자동응답하지 않습니다`);
  } catch (err) {
    console.warn(`  ! CLI 확인 실패: ${err.message}`);
    console.warn('    npm run doctor 로 진단하세요.');
  }
  console.log('');
});
