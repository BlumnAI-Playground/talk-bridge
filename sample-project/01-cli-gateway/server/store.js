import { config } from './config.js';

/**
 * ── 인메모리 상담 저장소 ──────────────────────────────────────────────────
 *
 * 샘플이므로 프로세스 메모리에만 둔다. 실제 구축에서는 이 자리에
 * DB(멱등 테이블 + 메시지 테이블)를 넣으면 된다.
 *
 * 멱등(idempotency)은 두 층으로 잡는다 — 문서 권고 그대로:
 *   1순위: X-Bridge-Delivery-Id  (재시도 중복 제거. 같은 전달의 재시도는 동일 ID)
 *   2순위: (brand, seq)          (논리 이벤트 유일성)
 * 저널이 리셋되면 seq 가 재사용될 수 있어 장기 저장은 Delivery-Id 가 안전하다.
 */

const rooms = new Map();        // userKey -> room
const seenDeliveries = new Set();
const seenSeq = new Set();      // `${brand}:${seq}`
const DELIVERY_CAP = 5000;

export function isDuplicateDelivery(deliveryId) {
  if (!deliveryId) return false;
  if (seenDeliveries.has(deliveryId)) return true;
  seenDeliveries.add(deliveryId);
  // 무한 증식 방지 — 샘플 수준의 아주 단순한 트리밍
  if (seenDeliveries.size > DELIVERY_CAP) {
    const it = seenDeliveries.values();
    for (let i = 0; i < DELIVERY_CAP / 2; i++) seenDeliveries.delete(it.next().value);
  }
  return false;
}

export function isDuplicateSeq(brand, seq) {
  if (seq == null) return false;
  const key = `${brand}:${seq}`;
  if (seenSeq.has(key)) return true;
  seenSeq.add(key);
  return false;
}

function blankRoom(userKey) {
  return {
    userKey,
    status: '진행중',
    ended: false,
    lastSeq: 0,
    lastAt: null,
    lastText: '',
    unread: 0,
    messages: [],
  };
}

export function getRoom(userKey) {
  if (!rooms.has(userKey)) rooms.set(userKey, blankRoom(userKey));
  return rooms.get(userKey);
}

export function listRooms() {
  return [...rooms.values()]
    .map(({ messages, ...r }) => ({ ...r, count: messages.length }))
    .sort((a, b) => (b.lastSeq || 0) - (a.lastSeq || 0));
}

export function getMessages(userKey) {
  return getRoom(userKey).messages;
}

/**
 * 메시지 하나를 방에 넣는다. seq 가 같은 메시지는 덮어쓴다(본문 보강 재적용 대비).
 * 웹훅은 순서를 보장하지 않으므로 항상 seq 로 재정렬한다.
 */
export function upsertMessage(userKey, msg) {
  const room = getRoom(userKey);
  const idx = msg.seq != null ? room.messages.findIndex((m) => m.seq === msg.seq) : -1;

  if (idx >= 0) room.messages[idx] = { ...room.messages[idx], ...msg };
  else room.messages.push(msg);

  // seq 가 확정된 agent echo 가 오면, 같은 본문의 낙관적(pending) 말풍선은 역할을 다했다.
  if (msg.seq != null && msg.kind === 'agent') {
    room.messages = room.messages.filter((m) => !(m.pending && m.seq == null && m.text === msg.text));
  }

  room.messages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (room.messages.length > config.maxMessagesPerRoom) {
    room.messages.splice(0, room.messages.length - config.maxMessagesPerRoom);
  }

  if (msg.seq != null && msg.seq >= room.lastSeq) {
    room.lastSeq = msg.seq;
    room.lastAt = msg.at || room.lastAt;
    if (msg.text) room.lastText = msg.text;
  }
  return room;
}

export function markRoomStatus(userKey, status) {
  const room = getRoom(userKey);
  room.status = status;
  room.ended = status !== '진행중';
  return room;
}

export function bumpUnread(userKey) {
  getRoom(userKey).unread += 1;
}

export function clearUnread(userKey) {
  getRoom(userKey).unread = 0;
}

/** CLI 로 읽어온 방/메시지를 저장소에 흡수한다(부팅 시 백필). */
export function hydrateRooms(cliRooms) {
  for (const r of cliRooms) {
    const room = getRoom(r.userKey);
    room.status = r.status;
    room.ended = r.ended;
    room.lastSeq = Math.max(room.lastSeq, r.lastSeq || 0);
    room.lastAt = r.lastAt || room.lastAt;
    room.lastText = r.lastText || room.lastText;
  }
}

export function hydrateMessages(userKey, msgs) {
  for (const m of msgs) upsertMessage(userKey, m);
}

export function stats() {
  return {
    rooms: rooms.size,
    messages: [...rooms.values()].reduce((n, r) => n + r.messages.length, 0),
    deliveries: seenDeliveries.size,
  };
}
