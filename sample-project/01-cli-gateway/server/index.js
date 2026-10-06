import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config, webhookPath } from './config.js';
import { handleWebhook } from './webhook.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { addClient, broadcast, clientCount } from './sse.js';
import {
  cliWhoami, cliRooms, cliRoomMessages, cliHistory,
  cliSend, cliSendFiles, cliEndWithBot, cliBlock, cliDelete, launcherInfo,
} from './cli.js';

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

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        // 소켓을 끊지 않고 나머지는 버리며 읽는다 — 그래야 브라우저가 413 안내를 받는다
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`본문이 너무 큽니다 (상한 ${(limit / 1024 / 1024).toFixed(1)}MB)`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
}

/**
 * 브라우저가 보낸 첨부 [{ name, type, dataBase64 }] 를 임시 폴더에 파일로 쓴다.
 * CLI `send --file` 은 경로를 받으므로, 요청마다 전용 임시 폴더를 만들고 발신 뒤 지운다.
 * 파일명은 원래 이름을 살린다 — 고객에게 보이는 파일 말풍선 이름이 되기 때문이다(경로 문자는 치환).
 */
function writeTempFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-send-'));
  const paths = [];
  (Array.isArray(files) ? files : []).forEach((f, i) => {
    if (!f || typeof f.dataBase64 !== 'string') return;
    const data = Buffer.from(f.dataBase64, 'base64');
    if (!data.length) return;
    const safe = String(f.name || `file-${i}`).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || `file-${i}`;
    const sub = fs.mkdtempSync(path.join(dir, `${i}-`)); // 같은 이름 파일이 겹쳐도 덮어쓰지 않게
    const p = path.join(sub, safe);
    fs.writeFileSync(p, data);
    paths.push(p);
  });
  return { dir, paths, bytes: paths.reduce((n, p) => n + fs.statSync(p).size, 0) };
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
      store.hydrateMessages(userKey, msgs.map((m) => outbox.claim(userKey, m)));
      store.clearUnread(userKey);
      return json(res, 200, { ok: true, userKey, messages: store.getMessages(userKey) });
    }

    if (req.method === 'GET' && p === '/api/history') {
      return json(res, 200, { ok: true, history: await cliHistory() });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      return json(res, 200, { ok: true, stats: { ...store.stats(), sseClients: clientCount() } });
    }

    /* ── 발신 API (CLI 경유) ─────────────────────────────────────────── */
    if (req.method === 'POST' && p === '/api/send') {
      const { userKey, text } = await readJson(req);
      if (!userKey || !text) return json(res, 400, { ok: false, error: 'userKey 와 text 가 필요합니다' });

      const r = await cliSend(userKey, text);
      if (!r.ok) return json(res, 502, { ok: false, error: r.raw || '발신 실패', code: r.code });

      // 낙관적 반영. 확정 표시는 잠시 뒤 도착하는 kind:"agent" echo 가 대신한다.
      // serial 은 발신 취소(delete)의 키다 — 운영에서는 메시지 테이블에 함께 저장한다.
      store.upsertMessage(userKey, {
        seq: null, kind: 'agent', text, at: new Date().toISOString(),
        direction: 'out', pending: true, serial: r.serial,
      });
      outbox.record(userKey, { texts: [text], serials: [r.serial] });
      broadcast('sent', { userKey, text, serial: r.serial, raw: r.raw });
      return json(res, 200, { ok: true, serial: r.serial, raw: r.raw });
    }

    if (req.method === 'POST' && p === '/api/send/attachments') {
      const body = await readJson(req, config.maxUploadBytes * 1.4 + 64 * 1024); // base64 는 1.33배
      if (!body.userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });

      const tmp = writeTempFiles(body.files);
      try {
        if (!tmp.paths.length) return json(res, 400, { ok: false, error: 'files 가 필요합니다' });
        if (tmp.bytes > config.maxUploadBytes) {
          return json(res, 413, { ok: false, error: `첨부 합계가 TB_MAX_UPLOAD_MB(${config.maxUploadBytes / 1024 / 1024}MB) 를 넘습니다` });
        }
        const r = await cliSendFiles(body.userKey, tmp.paths, body.text);
        if (!r.ok) {
          // 한 장도 못 나감. 항목별 이유가 있으면 붙여 준다.
          const why = r.results.map((x) => x.message).filter(Boolean).join(' / ');
          return json(res, 502, { ok: false, error: why || r.raw || '첨부 발신 실패', code: r.code, results: r.results });
        }
        // 첨부는 낙관적 말풍선을 그리지 않는다 — 화면 반영은 kind:"agent" echo(저널 항목)가 한다.
        // 저널 본문은 캡션, 캡션이 없으면 "[첨부]" — 묶음이어도 1건. 말풍선별 serial 을 함께 기억한다
        outbox.record(body.userKey, { texts: [body.text || '[첨부]'], serials: r.results.filter((x) => x.ok).map((x) => x.serial) });
        broadcast('sent', { userKey: body.userKey, results: r.results });
        return json(res, 200, { ok: true, results: r.results, raw: r.raw });
      } finally {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
      }
    }

    if (req.method === 'POST' && p === '/api/end') {
      const { userKey, event } = await readJson(req);
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await cliEndWithBot(userKey, event);
      if (r.ok) store.markRoomStatus(userKey, '종료');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw });
    }

    if (req.method === 'POST' && (p === '/api/block' || p === '/api/unblock')) {
      const { userKey } = await readJson(req);
      if (!userKey) return json(res, 400, { ok: false, error: 'userKey 가 필요합니다' });
      const r = await cliBlock(userKey, p === '/api/unblock');
      return json(res, r.ok ? 200 : 502, { ok: r.ok, raw: r.raw });
    }

    if (req.method === 'POST' && p === '/api/delete') {
      const { userKey, serial, text, withinSeconds } = await readJson(req);
      if (!userKey || (!serial && !text)) {
        return json(res, 400, { ok: false, error: 'userKey 와 serial(또는 text) 이 필요합니다' });
      }
      const r = await cliDelete(userKey, { serial, text, withinSeconds });
      // 화면 표시는 곧 도착하는 kind:"deleted" 웹훅이 맞춘다(다른 상담 도구에서 지운 것도 같은 경로).
      return json(res, r.ok ? 200 : 502, { ok: r.ok, serial: r.serial, raw: r.raw, code: r.code, error: r.ok ? undefined : r.raw });
    }

    /* ── 정적 파일 ───────────────────────────────────────────────────── */
    if (req.method === 'GET') return serveStatic(res, p);

    return json(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error('[http]', req.method, p, '→', err.message);
    return json(res, err.status || 500, { ok: false, error: err.message });
  }
});

server.listen(config.port, config.host, async () => {
  const L = launcherInfo();
  console.log('');
  console.log('  TalkBridge CLI × Gateway 채팅상담 샘플');
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
  } catch (err) {
    console.warn(`  ! CLI 확인 실패: ${err.message}`);
    console.warn('    npm run doctor 로 진단하세요.');
  }
  console.log('');
});
