/**
 * 쓰기 창 — 그래프에 **쓰는** 스크립트(seed·build)만 쓴다.
 *
 * CLI v1.1.0 에서 조회(status/search/view)는 게이트웨이가 떠 있어도 조회 API 를 자동 경유한다.
 * 하지만 쓰기(`knowledge build`, `knowledge query --write`)는 DB 를 직접 열어야 하므로
 * 게이트웨이가 쥐고 있으면 CLI 가 거부한다:
 *   "게이트웨이(pid N)가 그래프 DB 를 사용 중입니다 — … 쓰기는 'talkbridge gateway stop' 후 다시 실행하세요."
 *
 * 그래서 쓰기 동안만 게이트웨이를 멈췄다가 다시 켠다. 멈춘 동안의 이벤트는
 * ~/.bridge-agent/stream-offsets.json 기준으로 재기동 시 재생되어 유실되지 않는다(실측).
 * 서버(server/)는 이 파일을 쓰지 않는다 — 서버는 읽기만 하고, 읽기는 창이 필요 없다.
 */

import { runCli, cliGatewayStatus } from '../server/cli.js';

async function running() {
  try {
    return !!(await cliGatewayStatus()).running;
  } catch {
    return false;
  }
}

/** fn 을 "게이트웨이가 멈춘 상태" 에서 실행한다. 원래 꺼져 있었으면 건드리지 않는다. */
export async function withGatewayStopped(fn) {
  const wasRunning = await running();
  if (wasRunning) {
    console.log('게이트웨이를 잠시 멈춥니다 (쓰기 동안만)…');
    await runCli(['gateway', 'stop']);
    for (let i = 0; i < 10 && (await running()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    if (wasRunning) {
      const r = await runCli(['gateway', 'start']);
      if (r.code !== 0) console.error('[write-window] 게이트웨이 재기동 실패:', (r.stderr || r.stdout).trim(), '→ npm run gateway:start');
      else console.log('게이트웨이 재기동 완료.');
    }
  }
}
