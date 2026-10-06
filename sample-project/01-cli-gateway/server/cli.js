import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * ── TalkBridge CLI 래퍼 ────────────────────────────────────────────────────
 *
 * 이 샘플의 모든 발신·조회는 REST 를 직접 때리지 않고 **CLI 를 호출**한다.
 * (파트너가 CLI 로 구축할 때의 실제 모습을 그대로 보여주는 것이 목적)
 *
 * Windows 주의:
 *   `talkbridge-dev` 는 npm 이 만든 .cmd 셈(shim)이다. Node 18.20+ / 20.12+ 는
 *   보안 패치(CVE-2024-27980)로 shell:false 상태에서 .cmd 실행을 막는다.
 *   shell:true 로 우회하면 이번엔 상담 메시지에 들어 있는 " & % ^ 같은 문자가
 *   cmd 파서에 먹혀 인젝션·깨짐이 발생한다.
 *
 *   그래서 셈을 타지 않고 **런처 JS 를 node 로 직접 실행**한다.
 *   인자는 배열로 그대로 전달되므로 어떤 문자가 와도 안전하다.
 */

const ANSI = /\[[0-9;]*m/g;

let cachedLauncher; // { mode: 'node'|'shell', target: string }

function npmGlobalRoot() {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * CLI 실행 방법을 한 번만 결정해 캐시한다.
 *  1) TB_CLI_BIN 이 있으면 그것을 쓴다(.js 면 node 로, 아니면 직접 실행)
 *  2) npm 전역 루트에서 @blumn-*\/talkbridge-cli\/bin\/<cli>.js 런처를 찾는다
 *  3) 그래도 없으면 PATH + shell 폴백(최후의 수단)
 */
function resolveLauncher() {
  if (cachedLauncher) return cachedLauncher;

  const override = process.env.TB_CLI_BIN;
  if (override && fs.existsSync(override)) {
    cachedLauncher = override.endsWith('.js')
      ? { mode: 'node', target: override }
      : { mode: 'exec', target: override };
    return cachedLauncher;
  }

  const root = npmGlobalRoot();
  if (root) {
    // dev 채널은 @blumn-dev, 운영 채널은 @blumn-ai 스코프를 쓴다.
    for (const scope of ['@blumn-dev', '@blumn-ai']) {
      const js = path.join(root, scope, 'talkbridge-cli', 'bin', `${config.cli}.js`);
      if (fs.existsSync(js)) {
        cachedLauncher = { mode: 'node', target: js };
        return cachedLauncher;
      }
    }
  }

  cachedLauncher = { mode: 'shell', target: config.cli };
  return cachedLauncher;
}

export function launcherInfo() {
  return resolveLauncher();
}

/**
 * CLI 를 실행하고 { code, stdout, stderr } 를 돌려준다.
 * 실패해도 throw 하지 않는다 — 호출부가 code 로 분기하도록.
 */
export function runCli(args, { timeoutMs = 20000 } = {}) {
  const launcher = resolveLauncher();

  let cmd;
  let argv;
  let useShell = false;

  if (launcher.mode === 'node') {
    cmd = process.execPath; // 현재 node 실행파일
    argv = [launcher.target, ...args];
  } else if (launcher.mode === 'exec') {
    cmd = launcher.target;
    argv = args;
  } else {
    // 폴백 경로. 인자에 특수문자가 있으면 위험하므로 경고를 남긴다.
    cmd = launcher.target;
    argv = args;
    useShell = true;
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      shell: useShell,
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ code: -1, stdout, stderr: `${stderr}\n[cli] ${timeoutMs}ms 타임아웃`, timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n[cli] 실행 실패: ${err.message}` });
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 0,
        stdout: stdout.replace(ANSI, ''),
        stderr: stderr.replace(ANSI, ''),
      });
    });
  });
}

/* ── 출력 파서 ─────────────────────────────────────────────────────────────
 *
 * v1.1.0+ 는 아래 "--json 출력" 절이 먼저 처리하고, 이 텍스트 파서는 --json 이 없는 v1.0.0 폴백이다.
 * 텍스트는 v1.0.0(운영 채널) 과 v1.1.0(연도 포함) 양쪽 형식을 받는다. 단 긴 본문이 "…" 로 잘리므로
 * 고객 첨부 URL 은 텍스트 경로에서 온전히 읽히지 않는다. CLI 가 표기를 바꾸면 여기만 고치면 된다.
 */

/** 텍스트 타임스탬프 — v1.1.0+ 는 "2026-09-08 10:28", v1.0.0 은 연도 없는 "09-08 10:28" */
const TS = '(?:\\d{4}-)?\\d{2}-\\d{2} \\d{2}:\\d{2}';

/** "2026-09-08 10:28" 또는 "09-08 10:28" 을 ISO 로 올린다(연도가 없으면 현재 연도 가정). */
function toIso(stamp) {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(stamp || '');
  if (!m) return null;
  const now = new Date();
  const [, y, mo, d, h, mi] = m;
  const year = y ? Number(y) : now.getFullYear();
  const dt = new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi));
  // 연도가 없을 때만: 미래로 6시간 이상 튀면 작년 데이터로 본다(연말 경계 보정).
  if (!y && dt.getTime() - now.getTime() > 6 * 3600 * 1000) dt.setFullYear(year - 1);
  return dt.toISOString();
}

/**
 * `rooms --brand <키>` 출력 파싱
 *   · Vjpe_s_fc16k     [진행중]   4건  최신#11  2026-09-08 10:28  "[첨부]"   (v1.0.0 은 09-08 10:28)
 */
export function parseRooms(stdout) {
  const re = new RegExp('^\\s*·\\s+(\\S+)\\s+\\[([^\\]]+)\\]\\s+(\\d+)건\\s+최신#(\\d+)\\s+(' + TS + ')\\s+"([\\s\\S]*)"\\s*$');
  const rooms = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    rooms.push({
      userKey: m[1],
      status: m[2],            // 진행중 | 종료
      ended: m[2] !== '진행중',
      count: Number(m[3]),
      lastSeq: Number(m[4]),
      lastAtRaw: m[5],
      lastAt: toIso(m[5]),
      lastText: m[6],
    });
  }
  return rooms;
}

/**
 * `rooms --brand <키> --user <userKey>` 출력 파싱
 *   #10   [message] 2026-09-08 10:23  톡브릿지 가격이 어떻게되나요?   (v1.0.0 은 09-08 10:23)
 */
export function parseMessages(stdout) {
  const re = new RegExp('^\\s*#(\\d+)\\s+\\[([^\\]]+)\\]\\s+(' + TS + ')\\s+([\\s\\S]*?)\\s*$');
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    messages.push({
      seq: Number(m[1]),
      kind: m[2],              // message | agent | reference | expired | ended
      atRaw: m[3],
      at: toIso(m[3]),
      text: m[4],
      direction: m[2] === 'agent' ? 'out' : 'in',
    });
  }
  // CLI 는 최신순으로 준다 → 화면은 오래된 순이 자연스러우므로 뒤집는다.
  return messages.sort((a, b) => a.seq - b.seq);
}

/**
 * `whoami` 출력 파싱
 *   이름   : CLI login 2026-09-08
 *   권한   : BrandWrite
 *   엔드포인트: https://...
 *   브랜드 (1):
 *     - crm-b3e696
 */
export function parseWhoami(stdout) {
  const pick = (label) => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'm').exec(stdout);
    return m ? m[1].trim() : null;
  };
  const brands = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*-\s+(\S+)\s*$/.exec(line);
    if (m) brands.push(m[1]);
  }
  return {
    name: pick('이름'),
    scope: pick('권한'),
    endpoint: pick('엔드포인트'),
    brands,
  };
}

/**
 * `history --brand <키>` 출력 파싱 — convId 를 얻을 수 있는 유일한 경로.
 *   · Vjpe_s_fc16k     [진행중] 메시지   2건  2026-09-08 10:28  "[첨부]"
 *     convId=ad05d3f3799045318cc482c4345d6f06
 */
export function parseHistory(stdout) {
  const lines = stdout.split(/\r?\n/);
  const head = new RegExp('^\\s*·\\s+(\\S+)\\s+\\[([^\\]]+)\\]\\s+(\\S+)\\s+(\\d+)건\\s+(' + TS + ')\\s+"([\\s\\S]*)"\\s*$');
  const conv = /^\s*convId=([0-9a-fA-F]+)\s*$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const entry = {
      userKey: m[1],
      status: m[2],
      lastKind: m[3],
      count: Number(m[4]),
      lastAtRaw: m[5],
      lastAt: toIso(m[5]),
      lastText: m[6],
      convId: null,
    };
    const c = conv.exec(lines[i + 1] || '');
    if (c) entry.convId = c[1];
    out.push(entry);
  }
  return out;
}

/* ── --json 출력 (CLI v1.1.0+) ─────────────────────────────────────────────
 *
 * 텍스트 출력은 긴 본문을 "…" 로 자른다 — 고객 사진 URL(서명 쿼리 포함)이 잘려 첨부를 읽을 수 없다.
 * 그래서 조회·발신은 전역 `--json`(필드명 = REST)을 먼저 쓰고, JSON 이 아니면(v1.0.0) 텍스트 파서로 내려간다.
 * 반환 모델은 텍스트 파서와 같다(userKey/kind/seq/text/at/direction) — 02 api.js 와도 같다.
 */

/** `--json` 을 붙여 실행하고 JSON 을 돌려준다. JSON 이 아니면 json:null (텍스트 폴백용 r 은 그대로). */
async function runJson(args, opts) {
  const r = await runCli([...args, '--json'], opts);
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* v1.0.0 — --json 미지원 */ }
  return { ...r, json };
}

/** JSON 오류 봉투 { ok:false, error } 또는 비정상 종료를 사람이 읽을 문장으로 */
function cliError(r, label) {
  return (r.json && r.json.ok === false && (r.json.error || r.json.message)) || r.stderr || r.stdout || `${label} 실패`;
}

/* 고객 첨부 — 본문에 한 줄씩 "[photo|video|audio|file] 카카오CDN URL( 문구)" (02 api.js 와 같은 규칙)
 * 호스트가 talk.kakaocdn.net 인 https 만 첨부로 인정한다 — 고객이 입력한 링크·SSRF 방지.
 * CDN URL 은 서명 쿼리(credential·expires)가 붙은 임시 주소다. 보관이 필요하면 수신 직후 사본을 저장한다. */
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

/** REST 형 메시지(JSON) → 화면 모델. 텍스트 파서 결과에도 첨부·방향 규칙을 똑같이 입힌다. */
function normalizeMessage(m) {
  const direction = m.kind === 'agent' ? 'out' : m.kind === 'message' ? 'in' : 'system';
  const text = direction === 'system' ? SYSTEM_TEXT[m.kind] ?? m.text ?? '' : m.text ?? '';
  const msg = {
    seq: Number(m.seq),
    kind: m.kind,
    text,
    at: m.timestampUnixMs ? new Date(Number(m.timestampUnixMs)).toISOString() : m.at ?? null,
    direction,
  };
  if (m.atRaw) msg.atRaw = m.atRaw;
  if (m.sessionId !== undefined) msg.sessionId = m.sessionId;
  if (m.serial) msg.serial = m.serial;     // 발신(agent)·삭제(deleted) 항목 — 코어가 주는 경우에만
  if (m.deleted) msg.deleted = true;
  const attachments = direction === 'system' ? [] : parseAttachments(text);
  if (attachments.length) msg.attachments = attachments;
  return msg;
}

function normalizeRoom(r) {
  const ended = Boolean(r.ended);
  return {
    userKey: r.userKey,
    status: ended ? '종료' : '진행중',
    ended,
    count: Number(r.count ?? 0),
    lastSeq: Number(r.lastSeq ?? 0),
    lastAt: r.lastTimestampUnixMs ? new Date(Number(r.lastTimestampUnixMs)).toISOString() : null,
    lastText: r.lastText ?? '',
  };
}

/** 발신 결과의 serial — JSON 이면 필드, 텍스트면 "bw-…" 패턴 */
function serialOf(r) {
  if (r.json) return r.json.serial ?? r.json.results?.find?.((x) => x.serial)?.serial ?? null;
  return /\bbw-[\w-]+/.exec(r.stdout + r.stderr)?.[0] ?? null;
}

/** 발신 계열 공통 반환 — { ok, raw, code, serial, body } (02 api.js write() 와 같은 모양) */
function sendResult(r) {
  const ok = r.json ? r.code === 0 && r.json.ok !== false : r.code === 0;
  const raw = r.json && !ok ? cliError(r, '발신') : (r.stdout + r.stderr).trim();
  return { ok, raw, code: r.json?.code ?? r.code, serial: serialOf(r), body: r.json };
}

/* ── 고수준 명령 ───────────────────────────────────────────────────────── */

export async function cliWhoami() {
  const r = await runJson(['whoami']);
  if (r.json && r.json.ok !== false) {
    // v1.3+ 는 brands 가 채널 키 목록이고 channels[] 에 상세(type·name·brandKey)가 있다
    const { name = null, scope = null, endpoint = null, brands = [] } = r.json;
    return { name, scope, endpoint, brands };
  }
  if (r.code !== 0) throw new Error(cliError(r, 'whoami'));
  return parseWhoami(r.stdout);
}

export async function cliRooms(max = 50) {
  const r = await runJson(['rooms', '--brand', config.brand, '--max', String(max)]);
  if (Array.isArray(r.json)) return r.json.map(normalizeRoom);
  if (Array.isArray(r.json?.rooms)) return r.json.rooms.map(normalizeRoom);
  if (r.code !== 0 || r.json) throw new Error(cliError(r, 'rooms'));
  return parseRooms(r.stdout);
}

export async function cliRoomMessages(userKey, max = 50) {
  const r = await runJson(['rooms', '--brand', config.brand, '--user', userKey, '--max', String(max)]);
  const list = Array.isArray(r.json) ? r.json : r.json?.messages;
  if (Array.isArray(list)) return list.map(normalizeMessage).sort((a, b) => a.seq - b.seq);
  if (r.code !== 0 || r.json) throw new Error(cliError(r, 'rooms --user'));
  return parseMessages(r.stdout).map(normalizeMessage);
}

export async function cliHistory() {
  const r = await runCli(['history', '--brand', config.brand]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'history 실패');
  return parseHistory(r.stdout);
}

/** 텍스트 발신. serial(발신번호)은 발신 취소와 agent echo 대조의 키다. */
export async function cliSend(userKey, text) {
  return sendResult(await runJson(['send', '--brand', config.brand, '--to', userKey, '--text', text]));
}

/**
 * 첨부 발신 — CLI 가 업로드·말풍선 조립까지 대신 한다(upload 는 rich 조립용이라 별개).
 * `--file` 을 여러 번 주면 한 번에 보내고, 말풍선마다 serial 이 results[] 로 온다.
 * 한 장이라도 나가면 ok — 실패한 항목만 results[].ok:false 로 온다.
 */
export async function cliSendFiles(userKey, filePaths, text) {
  const args = ['send', '--brand', config.brand, '--to', userKey];
  for (const f of filePaths) args.push('--file', f);
  if (text) args.push('--text', text);
  const r = await runJson(args, { timeoutMs: 60000 + 20000 * filePaths.length });
  const res = sendResult(r);
  return { ...res, results: Array.isArray(r.json?.results) ? r.json.results : [] };
}

/** 상담 종료 + 봇 전환. CLI 에는 순수 end 가 없고 end-with-bot 만 있다. */
export async function cliEndWithBot(userKey, event) {
  const args = ['end-with-bot', '--brand', config.brand, '--to', userKey];
  if (event) args.push('--event', event);
  return sendResult(await runJson(args));
}

export async function cliBlock(userKey, unblock = false) {
  return sendResult(await runJson([unblock ? 'unblock' : 'block', '--brand', config.brand, '--to', userKey]));
}

/**
 * 발신 취소(발송 후 24시간 내, 말풍선 1개 단위). serial 이 정확하고, 모르면 본문으로 역추적한다.
 * 고객 방에는 「메시지가 삭제되었습니다」가 남고 상담 건수는 돌아오지 않는다.
 */
export async function cliDelete(userKey, { serial, text, withinSeconds, withinSec }) {
  const args = ['delete', '--brand', config.brand, '--to', userKey];
  const within = withinSeconds ?? withinSec;
  if (serial) args.push('--serial', String(serial));
  else if (text) {
    args.push('--text', text);
    if (within) args.push('--within', String(within));
  } else {
    return { ok: false, raw: 'serial 또는 text 중 하나가 필요합니다', code: -1, serial: null };
  }
  return sendResult(await runJson(args));
}
