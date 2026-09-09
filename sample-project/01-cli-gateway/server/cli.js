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
 * 이 샘플은 사람이 읽는 텍스트 출력을 파싱한다 — v1.0.0(운영 채널) 과 v1.1.0(연도 포함) 양쪽 형식을 받는다.
 * v1.1.0+ 에는 전역 `--json` 이 있어 파서가 필요 없다(03 샘플이 그렇게 한다). 01 은 v1.0.0 호환을 위해 텍스트를 유지한다.
 * CLI 가 표기를 바꾸면 여기만 고치면 된다.
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

/* ── 고수준 명령 ───────────────────────────────────────────────────────── */

export async function cliWhoami() {
  const r = await runCli(['whoami']);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'whoami 실패');
  return parseWhoami(r.stdout);
}

export async function cliRooms(max = 50) {
  const r = await runCli(['rooms', '--brand', config.brand, '--max', String(max)]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'rooms 실패');
  return parseRooms(r.stdout);
}

export async function cliRoomMessages(userKey, max = 50) {
  const r = await runCli(['rooms', '--brand', config.brand, '--user', userKey, '--max', String(max)]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'rooms --user 실패');
  return parseMessages(r.stdout);
}

export async function cliHistory() {
  const r = await runCli(['history', '--brand', config.brand]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'history 실패');
  return parseHistory(r.stdout);
}

/** 텍스트 발신. 성공하면 CLI 원문을 함께 돌려준다(발신번호 확인용). */
export async function cliSend(userKey, text) {
  const r = await runCli(['send', '--brand', config.brand, '--to', userKey, '--text', text]);
  return { ok: r.code === 0, raw: (r.stdout + r.stderr).trim(), code: r.code };
}

/** 첨부 발신 — CLI 가 업로드까지 대신 해준다(upload 는 rich 조립용이라 별개). */
export async function cliSendFile(userKey, filePath, text) {
  const args = ['send', '--brand', config.brand, '--to', userKey, '--file', filePath];
  if (text) args.push('--text', text);
  const r = await runCli(args, { timeoutMs: 60000 });
  return { ok: r.code === 0, raw: (r.stdout + r.stderr).trim(), code: r.code };
}

/** 상담 종료 + 봇 전환. CLI 에는 순수 end 가 없고 end-with-bot 만 있다. */
export async function cliEndWithBot(userKey, event) {
  const args = ['end-with-bot', '--brand', config.brand, '--to', userKey];
  if (event) args.push('--event', event);
  const r = await runCli(args);
  return { ok: r.code === 0, raw: (r.stdout + r.stderr).trim(), code: r.code };
}

export async function cliBlock(userKey, unblock = false) {
  const r = await runCli([unblock ? 'unblock' : 'block', '--brand', config.brand, '--to', userKey]);
  return { ok: r.code === 0, raw: (r.stdout + r.stderr).trim(), code: r.code };
}

/** 발신 취소(24시간 내). serial 을 모르면 본문으로 역추적한다. */
export async function cliDelete(userKey, { serial, text, withinSec }) {
  const args = ['delete', '--brand', config.brand, '--to', userKey];
  if (serial) args.push('--serial', String(serial));
  else if (text) {
    args.push('--text', text);
    if (withinSec) args.push('--within', String(withinSec));
  } else {
    return { ok: false, raw: 'serial 또는 text 중 하나가 필요합니다', code: -1 };
  }
  const r = await runCli(args);
  return { ok: r.code === 0, raw: (r.stdout + r.stderr).trim(), code: r.code };
}
