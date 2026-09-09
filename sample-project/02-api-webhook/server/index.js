import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, webhookPath } from './config.js';
import { handleWebhook } from './webhook.js';
import * as store from './store.js';
import { addClient, broadcast, clientCount } from './sse.js';
import * as api from './api.js';

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* ── 호스티드 게이트웨이 수신 ────────────────────────────────────── */
    if (req.method === 'POST' && p === webhookPath) {
      // 서명은 raw 바이트 기준이므로 절대 파싱해서 넘기지 않는다.
      const raw = await readBody(req);
      if (process.env.TB_DEBUG_WEBHOOK) {
        // 게이트웨이가 실제로 무엇을 보내는지 볼 때만 켠다. 서명값은 앞 12자만 남긴다.
        const h = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-bridge-') || k === 'content-type' || k === 'user-agent'));
        if (h['x-bridge-signature']) h['x-bridge-signature'] = h['x-bridge-signature'].slice(0, 12) + '…';
        console.log('[webhook:debug]', JSON.stringify(h), raw.toString('utf8'));
      }
      return handleWebhook(req, res, raw);
    }

    /* ── 브라우저 실시간 채널 ────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/events') {
      return addClient(res);
    }

    /* ── 조회 API (REST 경유) ────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/me') {
      const me = await api.me();
      return json(res, 200, {
        ok: true, me, brand: config.brand, apiBase: config.apiBase, publicUrl: config.publicUrl,
      });
    }

    if (req.method === 'GET' && p === '/api/rooms') {
      // REST 를 진실의 원천으로 두고, 메모리 저장소에 흡수시킨다.
      const fresh = await api.rooms(Number(url.searchParams.get('max') || 50));
      store.hydrateRooms(fresh);
      return json(res, 200, { ok: true, rooms: store.listRooms() });
    }

    const mMsgs = /^\/api\/rooms\/([^/]+)\/messages$/.exec(p);
    if (req.method === 'GET' && mMsgs) {
      const userKey = decodeURIComponent(mMsgs[1]);
      const msgs = await api.roomMessages(userKey, Number(url.searchParams.get('max') || 50));
      store.hydrateMessages(userKey, msgs);
      store.clearUnread(userKey);
      return json(res, 200, { ok: true, userKey, messages: store.getMessages(userKey) });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      return json(res, 200, { ok: true, stats: { ...store.stats(), sseClients: clientCount() } });
    }

    /* ── 발신 API (REST 경유 · 과금) ─────────────────────────────────── */
    if (req.method === 'POST' && p === '/api/send') {
      const { userKey, text } = await readJson(req);
      if (!userKey || !text) return json(res, 400, { ok: false, error: 'userKey 와 text 가 필요합니다' });

      const r = await api.send(userKey, text);
      if (!r.ok) return json(res, 502, { ok: false, error: r.raw || '발신 실패', code: r.code });

      // 낙관적 반영. 확정 표시는 잠시 뒤 도착하는 kind:"agent" echo 가 대신한다.
      store.upsertMessage(userKey, {
        seq: null, kind: 'agent', text, at: new Date().toISOString(),
        direction: 'out', pending: true,
      });
      broadcast('sent', { userKey, text, raw: r.raw });
      return json(res, 200, { ok: true, raw: r.raw });
    }

    if (req.method === 'POST' && p === '/api/end') {
      // mode:"plain" 이면 순수 end(인사말 선택), 기본은 end-with-bot
      const { userKey, event, mode, greeting } = await readJson(req);
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = mode === 'plain' ? await api.end(userKey, greeting) : await api.endWithBot(userKey, event);
      if (r.ok) store.markRoomStatus(userKey, '종료');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw, code: r.code });
    }

    if (req.method === 'POST' && (p === '/api/block' || p === '/api/unblock')) {
      const { userKey } = await readJson(req);
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await api.block(userKey, p === '/api/unblock');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw, code: r.code });
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
  console.log('');
  console.log('  TalkBridge REST API × 호스티드 웹훅 채팅상담 샘플');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`  상담 화면  http://${config.host}:${config.port}/`);
  console.log(`  수신 웹훅  http://${config.host}:${config.port}${webhookPath}`);
  console.log(`  공개 URL   ${config.publicUrl || '(TB_PUBLIC_URL 미설정 — 센터에 등록한 주소를 적어 두면 doctor 가 검사합니다)'}`);
  console.log(`  브랜드     ${config.brand}`);
  console.log(`  REST       ${config.apiBase}`);
  console.log('');

  // 부팅 백필 — 웹훅이 아직 안 들어와도 화면에 기존 상담이 보이게 한다.
  try {
    const me = await api.me();
    console.log(`  ✓ API 인증 확인 — ${me.name} / ${me.scope} / 브랜드 ${me.brands.join(', ')}`);
    if (!me.brands.includes(config.brand)) {
      console.warn(`  ! 경고: TB_BRAND(${config.brand}) 가 키의 허용 브랜드에 없습니다`);
    }
    const rooms = await api.rooms(50);
    store.hydrateRooms(rooms);
    console.log(`  ✓ 기존 상담방 ${rooms.length}개 백필 완료`);
  } catch (err) {
    console.warn(`  ! API 확인 실패: ${err.message}`);
    console.warn('    npm run doctor 로 진단하세요.');
  }
  console.log('');
});
