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
 *   발신(BrandWrite) POST /api/agent/send · send/rich · send/attachments · delete
 *                         · end · end-with-bot · block · unblock
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
  // FormData(multipart) 는 fetch 가 boundary 를 붙여 content-type 을 직접 만든다 — 손대지 않는다.
  const multipart = body instanceof FormData;
  if (body && !multipart) headers['content-type'] = 'application/json; charset=utf-8';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
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

/**
 * 발신용 — throw 하지 않고 { ok, code, raw } 를 돌려준다(01 의 cliSend 와 같은 계약).
 * 발신 응답의 serial(bw-…)도 함께 올린다 — 발신 취소와 agent echo 대조의 키다.
 */
async function write(path, body, opts) {
  try {
    const r = await call('POST', path, { body, ...opts });
    return {
      ok: r.ok, code: r.code, status: r.status,
      serial: r.body?.serial ?? null, body: r.body,
      raw: r.ok ? r.raw : describe(r),
    };
  } catch (err) {
    return { ok: false, code: 'NETWORK', status: -1, serial: null, body: null, raw: err.message };
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
    NO_FILE: '첨부 파일 없음 — files 파트 확인',
    NOT_FOUND: '본문으로 최근 발신을 찾지 못함 — serial 로 지정',
    NOT_DELETABLE: '개인정보 동의·카카오톡 인증 말풍선은 지울 수 없음',
    EXPIRED: '발송 후 24시간이 지나 지울 수 없음',
    '-502': '이미 종료된 상담 — 고객이 다시 메시지를 보내야 발신 가능',
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

/* ── 고객 첨부 파싱 ───────────────────────────────────────────────────────
 * 고객이 카카오톡으로 사진·동영상·음성·파일을 보내면 별도 필드가 아니라
 * 본문 text 에 한 줄씩 "[종류] 카카오CDN URL( 문구)" 로 담겨 온다(공개 매뉴얼 · 수신 내용 조회).
 *
 *   [photo] https://talk.kakaocdn.net/…/i_6f66….jpeg
 *   [photo] https://talk.kakaocdn.net/…/i_cdfc….jpeg 영수증이요
 *
 * - 묶음사진은 메시지 1건에 여러 줄 → 첫 줄만 읽으면 둘째 장부터 빠진다
 * - 호스트가 talk.kakaocdn.net 인 https URL 만 첨부로 인정한다.
 *   고객이 직접 입력한 링크까지 <img> 로 띄우거나 서버가 내려받으면 추적·SSRF 통로가 된다
 * - CDN URL 은 영구 주소가 아니다(열흘 뒤 열리지 않음 실측). 기록이 필요하면 수신 직후 사본을 보관한다
 */
const ATTACHMENT_LINE = /^\[(photo|video|audio|file)\] (\S+)(?: (.*))?$/;
const KAKAO_CDN_HOST = 'talk.kakaocdn.net';

export function parseAttachments(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = ATTACHMENT_LINE.exec(line.trim());
    if (!m) continue;
    let url;
    try { url = new URL(m[2]); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== KAKAO_CDN_HOST) continue;
    out.push({ type: m[1], url: url.href, comment: m[3] ?? '' });
  }
  return out;
}

const SYSTEM_TEXT = {
  reference: '— 새 상담이 연결되었습니다 —',
  expired: '— 세션이 만료되었습니다 —',
  ended: '— 상담이 종료되었습니다 —',
  deleted: '— 보낸 메시지를 삭제했습니다 —',
};

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
  const direction = m.kind === 'agent' ? 'out' : m.kind === 'message' ? 'in' : 'system';
  const text = m.text || (direction === 'system' ? SYSTEM_TEXT[m.kind] ?? '' : '');
  const msg = {
    seq: Number(m.seq),
    kind: m.kind,
    text,
    at: msToIso(m.timestampUnixMs) ?? m.at ?? null,
    direction,
    sessionId: m.sessionId ?? null,
  };
  // 아래 필드는 있을 때만 붙인다 — 01 의 CLI 모델(userKey/kind/seq/text/at/direction)의 상위집합
  if (m.serial) msg.serial = m.serial;          // 발신(agent)·삭제(deleted) 항목에만
  if (m.deleted) msg.deleted = true;            // 삭제된 발신에만
  const attachments = direction === 'system' ? [] : parseAttachments(text);
  if (attachments.length) msg.attachments = attachments;
  return msg;
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

/**
 * POST /api/agent/send/attachments (multipart) — 이미지·파일을 고객에게 바로 보낸다.
 * 서버가 카카오에 업로드한 뒤 말풍선으로 조립한다(이미지=리치 IMAGE, 파일=플레인 FILE).
 * upload/image 로 URL 만 받아 send/rich 로 조립하던 2단계를 한 번에 대신한다.
 *
 *   files: [{ name, type, data: Buffer }]   text: 첫 말풍선에 실을 캡션(선택)
 *   → { ok, results: [{ kind: 'image'|'file'|'text', ok, code, serial, message? }] }
 *
 * 말풍선마다 serial 이 따로 나온다. 한 장이라도 나가면 최상위 ok:true —
 * 실패한 항목만 results[].ok:false 로 오므로 그 장만 다시 보내면 된다.
 */
export async function sendAttachments(userKey, files, text) {
  const form = new FormData();
  form.append('brandKey', config.brand);
  form.append('userKey', userKey);
  if (text) form.append('text', text);
  for (const f of files) {
    form.append('files', new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
  }
  // 업로드는 텍스트 발신보다 오래 걸린다 — 타임아웃을 넉넉히
  const r = await write('api/agent/send/attachments', form, { timeoutMs: config.apiTimeoutMs * 4 });
  return { ...r, results: Array.isArray(r.body?.results) ? r.body.results : [] };
}

/**
 * POST /api/agent/delete — 발송 후 24시간 안의 말풍선 1개를 지운다(발신 취소).
 * serial 이 정확하다(권장). serial 을 놓쳤을 때만 text(정확히 일치)로 최근 발신을 찾는다.
 * 고객 방에는 「메시지가 삭제되었습니다」가 남고, 상담 건수는 돌아오지 않는다.
 */
export function deleteMessage(userKey, { serial, text, withinSeconds } = {}) {
  const body = { brandKey: config.brand, userKey };
  if (serial) body.serial = serial;
  else if (text) {
    body.text = text;
    if (withinSeconds) body.withinSeconds = Number(withinSeconds);
  }
  return write('api/agent/delete', body);
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
