import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * ── TalkBridge CLI 래퍼 (03 · CLI v1.1.0+) ─────────────────────────────────
 *
 * 이 샘플의 모든 발신·조회는 REST 를 직접 때리지 않고 **CLI 를 호출**한다.
 * (파트너가 CLI 로 구축할 때의 실제 모습을 그대로 보여주는 것이 목적)
 *
 * 01 과 다른 점: 조회는 전부 전역 `--json` 플래그로 받는다 (CLI v1.1.0+).
 *   - 필드명이 REST 와 같다 (`userKey`, `lastSeq`, `timestampUnixMs`, `kind`, `text` …)
 *   - 텍스트 파서가 없다 → CLI 표기가 바뀌어도 깨지지 않는다
 *   - 오류는 `{"ok":false,"error":"…"}` 한 줄로 온다
 *
 * Windows 주의:
 *   `talkbridge-dev` 는 npm 이 만든 .cmd 셈(shim)이다. Node 18.20+ / 20.12+ 는
 *   보안 패치(CVE-2024-27980)로 shell:false 상태에서 .cmd 실행을 막는다.
 *   shell:true 로 우회하면 이번엔 상담 메시지에 들어 있는 " & % ^ 같은 문자가
 *   cmd 파서에 먹혀 인젝션·깨짐이 발생한다.
 *
 *   그래서 셈을 타지 않고 **런처 JS 를 node 로 직접 실행**한다.
 *   인자는 배열로 그대로 전달되므로 어떤 문자가 와도 안전하다.
 *   (`talkbridge-dev env --json` 의 `launcherPath` 가 같은 경로를 알려준다)
 */

const ANSI = /\x1b\[[0-9;]*m/g;

/** 이 샘플이 요구하는 최소 CLI 버전 — `--json`, 게이트웨이 조회 API, `query --write` */
export const MIN_CLI_VERSION = '1.1.0';

let cachedLauncher; // { mode: 'node'|'exec'|'shell', target: string }

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
        // 런처(node)만 죽이면 그 자식인 CLI 바이너리가 살아남을 수 있다 — Windows 는 프로세스 트리를 통째로 끊는다.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill();
        }
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

/**
 * `--json` 으로 실행하고 파싱한 값을 돌려준다. 실패하면 throw.
 *  - CLI 는 결과를 stdout 에 한 줄 JSON 으로, 진단 메시지는 stderr 로 낸다
 *  - 오류는 `{"ok":false,"error":"…"}` (종료 코드 ≠ 0)
 *  - v1.0.0 처럼 `--json` 을 모르는 CLI 는 텍스트를 내므로 파싱이 실패한다 → 버전 안내
 */
export async function runJson(args, opts) {
  const r = await runCli([...args, '--json'], opts);
  const text = r.stdout.trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const msg = (r.stderr || r.stdout).trim();
    throw new Error(msg
      ? `${args[0]} 실패: ${msg.split(/\r?\n/)[0]}`
      : `${args[0]} 응답이 JSON 이 아닙니다 — CLI ${MIN_CLI_VERSION}+ 가 필요합니다 (npm run doctor)`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
    throw new Error(data.error || `${args[0]} 실패`);
  }
  return data;
}

/* ── 버전 ─────────────────────────────────────────────────────────────── */

/** `--version` → "1.1.0" (텍스트 "talkbridge v1.1.0" 에서 뽑는다) */
export async function cliVersion() {
  const r = await runCli(['--version']);
  const m = /v?(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
  return m ? m[1] : null;
}

export function versionAtLeast(v, min = MIN_CLI_VERSION) {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/* ── 조회 (--json) ─────────────────────────────────────────────────────── */

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

/** `whoami --json` → { name, scope, endpoint, brands } (REST `/api/agent/me` 와 같은 모델) */
export async function cliWhoami() {
  const d = await runJson(['whoami']);
  return { name: d.name ?? null, scope: d.scope ?? null, endpoint: d.endpoint ?? null, brands: d.brands ?? [] };
}

/**
 * `rooms --brand <키> --json` → 화면 모델
 *   CLI: { userKey, lastSeq, lastText, lastKind, lastTimestampUnixMs, count, ended }
 */
export async function cliRooms(max = 50) {
  const list = await runJson(['rooms', '--brand', config.brand, '--max', String(max)]);
  return (Array.isArray(list) ? list : []).map((r) => ({
    userKey: r.userKey,
    status: r.ended ? '종료' : '진행중',
    ended: !!r.ended,
    count: Number(r.count ?? 0),
    lastSeq: r.lastSeq ?? null,
    lastKind: r.lastKind ?? null,
    lastAt: iso(r.lastTimestampUnixMs),
    lastText: r.lastText ?? '',
  }));
}

/**
 * `rooms --brand <키> --user <userKey> --json` → seq 오름차순 메시지
 *   CLI: { seq, userKey, sessionId, kind, text, timestampUnixMs }  (최신순으로 온다)
 */
export async function cliRoomMessages(userKey, max = 50) {
  const list = await runJson(['rooms', '--brand', config.brand, '--user', userKey, '--max', String(max)]);
  return (Array.isArray(list) ? list : [])
    .map((m) => ({
      seq: m.seq,
      kind: m.kind,                       // message | agent | reference | expired | ended
      at: iso(m.timestampUnixMs),
      text: m.text ?? '',
      sessionId: m.sessionId ?? null,
      direction: m.kind === 'agent' ? 'out' : 'in',
    }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * `history --brand <키> --json` → convId 를 얻는 경로 (REST 에는 아직 없다 — cli-feat/CF-009)
 *   CLI: [{ brand, conversations: [{ convId, userKey, seq, sessionId, ended, count, last, lastActivityUnixMs }] }]
 */
export async function cliHistory() {
  const d = await runJson(['history', '--brand', config.brand]);
  const out = [];
  for (const b of Array.isArray(d) ? d : [d]) {
    for (const c of b?.conversations || []) {
      out.push({
        userKey: c.userKey,
        status: c.ended ? '종료' : '진행중',
        ended: !!c.ended,
        count: Number(c.count ?? 0),
        lastAt: iso(c.lastActivityUnixMs),
        lastText: c.last ?? '',
        convId: c.convId ?? null,
        sessionId: c.sessionId ?? null,
      });
    }
  }
  return out;
}

/** `gateway status --json` → { running, pid, log, knowledgeApi } */
export async function cliGatewayStatus() {
  return runJson(['gateway', 'status']);
}

/* ── 발신·제어 (텍스트 그대로 — 결과 원문을 화면에 보여준다) ──────────────── */

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

/* ── 03: 상담지식 온톨로지 상태 ───────────────────────────────────────────
 *
 * `knowledge status --json` (v1.1.0):
 *   { enabled, lib, dbPath, queryPort,
 *     ai: { configured, entityExtraction, naturalLanguageSearch },
 *     graph: { via: "gateway"|"file", error, nodes, edges, holderPid } }
 *
 * 게이트웨이가 떠 있으면 조회는 게이트웨이 조회 API(127.0.0.1:8790)를 자동 경유한다 — 잠금 충돌이 없다.
 * Cypher 조회는 server/graph.js. 그래프 DB 는 CLI·게이트웨이가 소유하고, 이 샘플의 서버는 읽기만 한다.
 */
export async function cliKnowledgeStatus() {
  try {
    const d = await runJson(['knowledge', 'status']);
    const g = d.graph || {};
    return {
      ok: true,
      active: !!d.enabled,
      lib: d.lib ?? null,
      libInstalled: !!d.lib,
      dbPath: d.dbPath ?? null,
      queryPort: d.queryPort ?? null,
      ai: d.ai || { configured: false, entityExtraction: false, naturalLanguageSearch: false },
      nodes: g.nodes ?? null,
      edges: g.edges ?? null,
      via: g.via ?? null,
      holderPid: g.holderPid ?? null,
      error: g.error ?? null,
      raw: d,
    };
  } catch (err) {
    return { ok: false, error: err.message, active: false, libInstalled: false, nodes: null, edges: null };
  }
}
