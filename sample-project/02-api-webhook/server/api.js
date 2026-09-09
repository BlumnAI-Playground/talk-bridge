import { config } from './config.js';

/**
 * ── TalkBridge REST 클라이언트 ────────────────────────────────────────────
 *
 * 01 샘플이 CLI 를 spawn 해 텍스트를 파싱하던 자리를, 여기서는 REST 직접 호출로 바꾼다.
 * 파싱이 사라지고 응답이 JSON 이라 코드가 절반으로 준다.
 *
 * 공통 규약 (공개 매뉴얼 §4·§8):
 *   Authorization: Bearer blumnb-...        키는 특정 brandKey 에 묶여 있다
 *   응답 봉투     { ok, code, message, ... } ok=false 면 code 에 에러 코드
 *   조회(BrandRead)  GET  /api/agent/me · rooms · rooms/{userKey}/messages
 *   발신(BrandWrite) POST /api/agent/send · send/rich · end · end-with-bot · block · unblock
 *
 * 반환 형태는 01 샘플의 CLI 래퍼와 **동일하게 맞췄다** — store.js·webhook.js·프론트가
 * 어느 샘플에서든 같은 모델(userKey/kind/seq/text/at/direction)을 보게 하기 위해서다.
 */

export class ApiError extends Error {
  constructor(status, code, message, raw) {
    super(message || `HTTP ${status}${code ? ` (${code})` : ''}`);
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

/** 저수준 호출. 네트워크·파싱 실패는 throw, HTTP 오류는 ok=false 로 돌려준다. */
export async function call(method, path, { query, body, timeoutMs = config.apiTimeoutMs } = {}) {
  const url = new URL(path, config.apiBase + '/');
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  }
  const headers = { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json; charset=utf-8';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* JSON 이 아니면 raw 만 */ }

  return {
    status: res.status,
    ok: res.ok && json?.ok !== false,
    code: json?.code ?? null,
    message: json?.message ?? null,
    body: json,
    raw,
  };
}

/** 조회용 — 실패는 throw. 호출부가 try/catch 로 다룬다. */
async function read(path, query) {
  const r = await call('GET', path, { query });
  if (!r.ok) throw new ApiError(r.status, r.code, r.message || describe(r), r.raw);
  return r.body;
}

/** 발신용 — throw 하지 않고 { ok, code, raw } 를 돌려준다(01 의 cliSend 와 같은 계약). */
async function write(path, body) {
  try {
    const r = await call('POST', path, { body });
    return { ok: r.ok, code: r.code, status: r.status, raw: r.ok ? r.raw : describe(r) };
  } catch (err) {
    return { ok: false, code: 'NETWORK', status: -1, raw: err.message };
  }
}

/** 사람이 읽을 오류 문장. 인증계 오류는 재시도해도 소용없다는 힌트를 붙인다. */
function describe(r) {
  const hint = {
    401: '토큰 없음/무효 — TB_API_KEY 확인',
    FORBIDDEN: '권한 부족 — 발신은 BrandWrite 스코프 필요',
    NO_BRAND_SCOPE: '이 키는 TB_BRAND 브랜드에 인가되지 않음',
    NO_BRAND: '존재하지 않는 브랜드',
    EMPTY: '필수 필드 누락',
    NO_PERSISTENCE: '수신 영속 비활성 — 잠시 후 재시도',
  }[r.code] || (r.status === 401 ? '토큰 없음/무효 — TB_API_KEY 확인' : '');
  const base = r.message || r.raw?.slice(0, 200) || '';
  return `HTTP ${r.status}${r.code ? ` ${r.code}` : ''}${base ? ` — ${base}` : ''}${hint ? ` (${hint})` : ''}`;
}

/* ── 응답 정규화 ──────────────────────────────────────────────────────────
 * 봉투 안 어디에 배열이 있든(최상위 키 / data.키 / data 배열) 같은 모델로 올린다.
 */

function pick(body, key) {
  if (Array.isArray(body?.[key])) return body[key];
  if (Array.isArray(body?.data?.[key])) return body.data[key];
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

const msToIso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

function normalizeRoom(r) {
  const ended = Boolean(r.ended);
  return {
    userKey: r.userKey,
    status: ended ? '종료' : '진행중',
    ended,
    count: Number(r.count ?? 0),
    lastSeq: Number(r.lastSeq ?? 0),
    lastKind: r.lastKind ?? null,
    lastAt: msToIso(r.lastTimestampUnixMs) ?? r.lastAt ?? null,
    lastText: r.lastText ?? '',
  };
}

function normalizeMessage(m) {
  return {
    seq: Number(m.seq),
    kind: m.kind,
    text: m.text ?? '',
    at: msToIso(m.timestampUnixMs) ?? m.at ?? null,
    direction: m.kind === 'agent' ? 'out' : 'in',
    sessionId: m.sessionId ?? null,
  };
}

/* ── 조회 (BrandRead) ────────────────────────────────────────────────── */

/** GET /api/agent/me → { name, scope, brands, endpoint } */
export async function me() {
  const b = await read('api/agent/me');
  const d = b.data && !b.name ? b.data : b;
  return { name: d.name ?? null, scope: d.scope ?? null, brands: d.brands ?? [], endpoint: config.apiBase };
}

/** GET /api/agent/rooms?brand=&max= → 01 의 parseRooms 와 같은 모델 */
export async function rooms(max = 50) {
  const b = await read('api/agent/rooms', { brand: config.brand, max });
  return pick(b, 'rooms').map(normalizeRoom).sort((a, c) => c.lastSeq - a.lastSeq);
}

/** GET /api/agent/rooms/{userKey}/messages?brand=&max= → seq 오름차순 */
export async function roomMessages(userKey, max = 50) {
  const b = await read(`api/agent/rooms/${encodeURIComponent(userKey)}/messages`, { brand: config.brand, max });
  return pick(b, 'messages').map(normalizeMessage).sort((a, c) => a.seq - c.seq);
}

/* ── 발신 (BrandWrite · 과금) ─────────────────────────────────────────── */

/** POST /api/agent/send — 텍스트. 활성 세션에만 성공한다. */
export function send(userKey, text) {
  return write('api/agent/send', { brandKey: config.brand, userKey, text });
}

/** POST /api/agent/send/rich — 카카오 리치 JSON 은 문자열로 직렬화해 보낸다. */
export function sendRich(userKey, rich) {
  return write('api/agent/send/rich', {
    brandKey: config.brand, userKey, rich: typeof rich === 'string' ? rich : JSON.stringify(rich),
  });
}

/** POST /api/agent/end-with-bot — 종료 + 봇 시나리오 전환 */
export function endWithBot(userKey, botEvent) {
  const body = { brandKey: config.brand, userKey };
  if (botEvent) body.botEvent = botEvent;
  return write('api/agent/end-with-bot', body);
}

/** POST /api/agent/end — 순수 종료(인사말 선택). CLI 에는 없고 REST 에만 있다. */
export function end(userKey, greeting) {
  const body = { brandKey: config.brand, userKey };
  if (greeting) body.greeting = greeting;
  return write('api/agent/end', body);
}

export function block(userKey, unblock = false) {
  return write(unblock ? 'api/agent/unblock' : 'api/agent/block', { brandKey: config.brand, userKey });
}
