import { verifySignature } from './signature.js';
import { roomMessages } from './api.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { broadcast } from './sse.js';

/**
 * ── 수신 웹훅 핸들러 ──────────────────────────────────────────────────────
 *
 * 01 샘플의 webhook.js 와 같은 뼈대다. 다른 점:
 *   - 본문 조회: 01 CLI `rooms --user` (cli.js)  →  02 REST rooms/{userKey}/messages (api.js)
 *   - 신호 처리(연결 테스트 test:true · 접수 phase:"accepted" · 발신 취소 kind:"deleted")는 01 과 같다
 * 서명 스킴·페이로드·처리 순서는 CLI 게이트웨이와 호스티드 게이트웨이가 같다.
 *
 * 게이트웨이가 보내는 것은 "본문 없는 신호"다. 실측 페이로드:
 *
 *   POST /webhook
 *   x-bridge-signature:   v0=<hex>
 *   x-bridge-event:       message
 *   x-bridge-timestamp:   1788856230
 *   x-bridge-delivery-id: d38f7b06-...
 *   content-type:         application/json; charset=utf-8
 *
 *   {"userKey":"Vjpe_s_fc16k","kind":"message","seq":1,"brand":"crm-b3e696"}
 *
 * 텍스트가 없으므로 kind 가 message/agent 면 REST 로 본문을 2차 조회해 보강한다.
 *
 * 처리 순서가 중요하다:
 *   서명검증 → (실패 401) → **즉시 200** → 그 다음에 비동기 후처리
 * 게이트웨이 타임아웃을 피하려면 REST 조회를 200 응답 뒤로 미뤄야 한다.
 * 호스티드 게이트웨이는 4xx 도 재시도하고(1s→5s→30s→2m→10m, 5회) 전달 원장을 영속한다.
 */

const KIND_LABEL = {
  message: '고객 메시지',
  agent: '상담원 발신(echo)',
  reference: '새 상담 연결',
  expired: '세션 만료',
  ended: '상담 종료',
  deleted: '발신 취소(삭제)',
};

export async function handleWebhook(req, res, rawBody) {
  // 1) 서명 검증 — 실패는 401. 게이트웨이가 재시도해도 계속 401 이 나는 게 정상이다.
  const v = verifySignature(req.headers, rawBody);
  if (!v.ok) {
    console.warn(`[webhook] 서명 거부: ${v.reason}`);
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad signature');
    return;
  }

  // 2) 정상 수신은 무조건 2xx. (4xx 도 재시도 대상이므로 처리했으면 반드시 200)
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('ok');

  // 3) 후처리는 응답 뒤에서 비동기로
  const deliveryId = req.headers['x-bridge-delivery-id'];
  setImmediate(() => {
    process$(rawBody, deliveryId).catch((err) => {
      console.error('[webhook] 후처리 실패:', err.message);
    });
  });
}

async function process$(rawBody, deliveryId) {
  let evt;
  try {
    evt = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn('[webhook] JSON 파싱 실패 — 무시');
    return;
  }

  const { brand, userKey, kind, seq } = evt;

  // 센터 「연결 테스트」 신호 — 가상 고객(tb-test-…)이라 본문 조회·답장이 안 되고 seq 가 항상 0 이다.
  // 멱등 집합에 (brand, 0) 을 넣기 전에 분기한다. 서명 검증·200 응답까지 통과한 것이 확인 대상이다.
  if (evt.test === true) {
    console.log(`[webhook] 연결 테스트 신호 수신 · ${userKey} — 서명 통과`);
    broadcast('test', { brand, userKey, kind });
    return;
  }

  // 4) 멱등 — Delivery-Id 우선, 그다음 (brand, seq)
  if (store.isDuplicateDelivery(deliveryId)) {
    console.log(`[webhook] 중복 전달 스킵 delivery=${deliveryId}`);
    return;
  }
  if (store.isDuplicateSeq(brand, seq)) {
    console.log(`[webhook] 중복 seq 스킵 ${brand}#${seq}`);
    return;
  }

  console.log(`[webhook] ${KIND_LABEL[kind] || kind} · ${userKey} ${seq != null ? `#${seq}` : `(${evt.phase || 'seq 없음'})`}${evt.serial ? ` · ${evt.serial}` : ''}`);

  // 5) kind 분기
  switch (kind) {
    case 'reference':
      store.markRoomStatus(userKey, '진행중');
      store.upsertMessage(userKey, {
        seq, kind, text: '— 새 상담이 연결되었습니다 —',
        at: new Date().toISOString(), direction: 'system',
      });
      break;

    case 'expired':
    case 'ended':
      store.markRoomStatus(userKey, '종료');
      store.upsertMessage(userKey, {
        seq, kind,
        text: kind === 'expired' ? '— 세션이 만료되었습니다 —' : '— 상담이 종료되었습니다 —',
        at: new Date().toISOString(), direction: 'system',
      });
      break;

    case 'deleted': {
      // 발신 취소(삭제) — serial 이 지운 말풍선이다. 묶음 이미지를 모두 지우면 장 수만큼 온다.
      // 이 샘플에서 지웠든 다른 상담 도구에서 지웠든 같은 신호로 화면을 맞춘다.
      for (const m of store.getMessages(userKey)) {
        if (!evt.serial || m.direction !== 'out') continue;
        if (Array.isArray(m.serials) && m.serials.length > 1) {
          // 묶음 발신 — 모든 장이 지워졌을 때만 삭제 표시(REST 조회의 deleted 와 같은 규칙)
          if (!m.serials.includes(evt.serial)) continue;
          m.deletedSerials = [...new Set([...(m.deletedSerials || []), evt.serial])];
          if (m.deletedSerials.length >= m.serials.length) m.deleted = true;
        } else if (m.serial === evt.serial) {
          m.deleted = true;
        }
      }
      store.upsertMessage(userKey, {
        seq, kind, serial: evt.serial ?? null, text: '— 보낸 메시지를 삭제했습니다 —',
        at: new Date().toISOString(), direction: 'system',
      });
      break;
    }

    case 'message':
    case 'agent': {
      // 호스티드 게이트웨이는 발신 1건에 agent 를 두 번 보낸다:
      //   ① 접수 신호 phase:"accepted" · serial (seq 없음)   ② 약 1초 뒤 seq · serial 있는 저널 항목
      // ①은 저장하면 말풍선이 중복되므로 "발신 접수" 신호로만 쓰고 넘긴다.
      // 구분은 phase 로 한다(매뉴얼 권고). seq 부재는 phase 가 없던 옛 코어 대비 보조 조건.
      if (kind === 'agent' && (evt.phase === 'accepted' || seq == null)) {
        broadcast('ack', { brand, userKey, serial: evt.serial ?? null });
        return;
      }
      // 본문이 payload 에 없으므로 REST 로 최근 메시지를 끌어와 seq 로 맞춘다.
      //
      // kind:"agent" 는 우리가 보낸 발신의 echo 다.
      //  - 자동응답 로직이 있다면 여기서 반드시 걸러야 무한 루프가 안 난다.
      //  - 이 샘플은 사람이 직접 답장하는 상담 화면이라, echo 는 "발신 완료" 표시로 쓴다.
      const enriched = await enrich(userKey, seq, kind);
      // 첨부 발신(여러 말풍선)의 저널 항목에는 serials 에 전체 목록이 온다 — 묶음 삭제 대조용
      if (kind === 'agent') {
        if (evt.serial && !enriched.serial) enriched.serial = evt.serial;
        if (Array.isArray(evt.serials) && evt.serials.length) enriched.serials = evt.serials;
      }
      // echo 에 serial 이 없으면(코어에 따라) 이 서버가 기억해 둔 발신 serial 을 붙인다
      store.upsertMessage(userKey, outbox.claim(userKey, enriched));
      if (kind === 'message') {
        store.markRoomStatus(userKey, '진행중');
        store.bumpUnread(userKey);
      }
      break;
    }

    default:
      console.log(`[webhook] 알 수 없는 kind=${kind} — 저장만 하고 통과`);
      store.upsertMessage(userKey, {
        seq, kind, text: `(알 수 없는 이벤트: ${kind})`,
        at: new Date().toISOString(), direction: 'system',
      });
  }

  // 6) 상담 화면으로 푸시
  broadcast('inbound', {
    brand, userKey, kind, seq,
    room: summarize(userKey),
    messages: store.getMessages(userKey),
  });
}

/** REST 로 본문을 조회해 해당 seq 의 메시지를 찾는다. */
async function enrich(userKey, seq, kind) {
  const base = {
    seq, kind,
    at: new Date().toISOString(),
    direction: kind === 'agent' ? 'out' : 'in',
    text: '',
  };
  try {
    const msgs = await roomMessages(userKey, 20);
    const hit = msgs.find((m) => m.seq === seq);
    if (hit) return { ...base, ...hit, direction: base.direction };

    // seq 가 아직 조회에 안 잡히는 경우(영속 지연) — 같은 kind 의 최신 것으로 근사
    const near = [...msgs].reverse().find((m) => m.kind === kind);
    if (near) {
      const approx = { ...base, text: near.text, at: near.at || base.at };
      if (near.attachments) approx.attachments = near.attachments;
      return approx;
    }

    return { ...base, text: '(본문 조회 실패 — 잠시 후 새로고침)' };
  } catch (err) {
    console.warn(`[webhook] 본문 조회 실패 ${userKey}#${seq}: ${err.message}`);
    return { ...base, text: '(본문 조회 실패)' };
  }
}

function summarize(userKey) {
  const { messages, ...room } = store.getRoom(userKey);
  return { ...room, count: messages.length };
}
