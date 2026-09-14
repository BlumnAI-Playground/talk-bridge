/**
 * ── 브라우저 푸시(SSE) ────────────────────────────────────────────────────
 * 게이트웨이 → 우리 서버 로 들어온 이벤트를 상담 화면에 즉시 밀어 넣는다.
 * 프론트가 바닐라 JS 이므로 EventSource 한 줄이면 붙는다(폴링 불필요).
 */

const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 끊긴 연결은 close 에서 정리된다 */
    }
  }, 25000);

  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
