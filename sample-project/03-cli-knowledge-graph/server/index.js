import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, webhookPath } from './config.js';
import { handleWebhook } from './webhook.js';
import * as store from './store.js';
import { addClient, broadcast, clientCount } from './sse.js';
import {
  cliWhoami, cliRooms, cliRoomMessages, cliHistory,
  cliSend, cliEndWithBot, cliBlock, cliDelete, launcherInfo,
  cliKnowledgeStatus,
} from './cli.js';
import { PRESETS, getSnapshot, refreshSnapshot, runPreset, runCustomCypher } from './graph.js';

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

    /* ── 조회 API (CLI 경유) ─────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/api/me') {
      const me = await cliWhoami();
      return json(res, 200, { ok: true, me, brand: config.brand, cli: config.cli, launcher: launcherInfo() });
    }

    if (req.method === 'GET' && p === '/api/rooms') {
      // CLI 를 진실의 원천으로 두고, 메모리 저장소에 흡수시킨다.
      const fresh = await cliRooms(Number(url.searchParams.get('max') || 50));
      store.hydrateRooms(fresh);
      return json(res, 200, { ok: true, rooms: store.listRooms() });
    }

    const mMsgs = /^\/api\/rooms\/([^/]+)\/messages$/.exec(p);
    if (req.method === 'GET' && mMsgs) {
      const userKey = decodeURIComponent(mMsgs[1]);
      const msgs = await cliRoomMessages(userKey, Number(url.searchParams.get('max') || 50));
      store.hydrateMessages(userKey, msgs);
      store.clearUnread(userKey);
      return json(res, 200, { ok: true, userKey, messages: store.getMessages(userKey) });
    }

    if (req.method === 'GET' && p === '/api/history') {
      return json(res, 200, { ok: true, history: await cliHistory() });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      return json(res, 200, { ok: true, stats: { ...store.stats(), sseClients: clientCount() } });
    }

    /* ── 03 추가: 상담지식 그래프 — 프리셋 Cypher + 스냅샷 캐시 (server/graph.js) ── */
    if (req.method === 'GET' && p === '/api/graph/status') {
      // knowledge status --json — 게이트웨이가 떠 있으면 통계는 조회 API 경유(via: "gateway").
      return json(res, 200, { ok: true, status: await cliKnowledgeStatus() });
    }

    if (req.method === 'GET' && p === '/api/graph/presets') {
      return json(res, 200, { ok: true, presets: PRESETS });
    }

    if (req.method === 'GET' && p === '/api/graph/snapshot') {
      // ?refresh=1 이면 파라미터 없는 프리셋을 전부 다시 실행한다 (게이트웨이는 건드리지 않는다).
      const snap = url.searchParams.get('refresh') ? await refreshSnapshot() : getSnapshot();
      return json(res, 200, { ok: true, snapshot: snap });
    }

    const mPreset = /^\/api\/graph\/preset\/([a-z0-9-]+)$/.exec(p);
    if (req.method === 'GET' && mPreset) {
      const params = Object.fromEntries(url.searchParams.entries());
      try {
        const r = await runPreset(mPreset[1], params);
        return json(res, 200, { ok: true, id: r.preset.id, columns: r.columns, cypher: r.cypher, rows: r.rows });
      } catch (err) {
        return json(res, /형식|알 수 없는/.test(err.message) ? 400 : 502, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && p === '/api/graph/cypher') {
      const { cypher } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      try {
        const r = await runCustomCypher(cypher);
        return json(res, 200, { ok: true, cypher: r.cypher, columns: r.columns, types: r.types, rows: r.rows });
      } catch (err) {
        return json(res, /읽기전용|MATCH 로 시작/.test(err.message) ? 400 : 502, { ok: false, error: err.message });
      }
    }

    /* ── 발신 API (CLI 경유) ─────────────────────────────────────────── */
    if (req.method === 'POST' && p === '/api/send') {
      const { userKey, text } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!userKey || !text) return json(res, 400, { ok: false, error: 'userKey 와 text 가 필요합니다' });

      const r = await cliSend(userKey, text);
      if (!r.ok) return json(res, 502, { ok: false, error: r.raw || '발신 실패' });

      // 낙관적 반영. 확정 표시는 잠시 뒤 도착하는 kind:"agent" echo 가 대신한다.
      store.upsertMessage(userKey, {
        seq: null, kind: 'agent', text, at: new Date().toISOString(),
        direction: 'out', pending: true,
      });
      broadcast('sent', { userKey, text, raw: r.raw });
      return json(res, 200, { ok: true, raw: r.raw });
    }

    if (req.method === 'POST' && p === '/api/end') {
      const { userKey, event } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await cliEndWithBot(userKey, event);
      if (r.ok) store.markRoomStatus(userKey, '종료');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw });
    }

    if (req.method === 'POST' && (p === '/api/block' || p === '/api/unblock')) {
      const { userKey } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await cliBlock(userKey, p === '/api/unblock');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw });
    }

    if (req.method === 'POST' && p === '/api/delete') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await cliDelete(body.userKey, body);
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw });
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
  console.log('');
  console.log('  TalkBridge CLI × Gateway 채팅상담 + 상담지식 그래프 샘플');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`  상담 화면  http://${config.host}:${config.port}/`);
  console.log(`  수신 웹훅  http://${config.host}:${config.port}${webhookPath}`);
  console.log(`  브랜드     ${config.brand}`);
  console.log(`  CLI        ${config.cli}  (${L.mode}: ${L.target})`);
  console.log('');

  // 부팅 백필 — 게이트웨이가 아직 안 떠 있어도 화면에 기존 상담이 보이게 한다.
  try {
    const me = await cliWhoami();
    console.log(`  ✓ CLI 인증 확인 — ${me.name} / ${me.scope} / 브랜드 ${me.brands.join(', ')}`);
    if (!me.brands.includes(config.brand)) {
      console.warn(`  ! 경고: TB_BRAND(${config.brand}) 가 키의 허용 브랜드에 없습니다`);
    }
    const rooms = await cliRooms(50);
    store.hydrateRooms(rooms);
    console.log(`  ✓ 기존 상담방 ${rooms.length}개 백필 완료`);

    // 03: 그래프 상태를 부팅 때 한 번 보여주고, 준비되어 있으면 첫 스냅샷을 찍는다.
    // 미설치여도 상담 화면은 그대로 쓸 수 있다.
    const kg = await cliKnowledgeStatus();
    if (kg.active && kg.libInstalled) {
      console.log(`  ✓ 상담지식 그래프 활성 — 첫 스냅샷 조회 중${kg.via === 'gateway' ? ' (게이트웨이 조회 API 경유)' : ''}…`);
      const snap = await refreshSnapshot();
      const stats = (snap.results.stats || []).map((r) => r.join(' ')).join(', ');
      console.log(`  ✓ 스냅샷 ${snap.ms}ms — ${stats || '(비어 있음)'}${Object.keys(snap.errors).length ? ` · 오류 ${Object.keys(snap.errors).length}` : ''}`);
    } else {
      console.warn(`  ! 상담지식 그래프 미준비 — ${kg.ok ? `활성:${kg.active} / lib:${kg.lib ?? '없음'}` : kg.error}`);
      console.warn('    README §2 순서: npm run knowledge:install → npm run demo:seed (AI 설정 불필요)');
    }
  } catch (err) {
    console.warn(`  ! CLI 확인 실패: ${err.message}`);
    console.warn('    npm run doctor 로 진단하세요.');
  }
  console.log('');
});
