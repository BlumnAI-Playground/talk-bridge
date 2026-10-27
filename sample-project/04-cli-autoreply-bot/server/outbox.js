/**
 * ── 발신 장부 (serial 기억) ───────────────────────────────────────────────
 *
 * 발신 취소(delete)에는 serial 이 필요하다. 발신 응답에는 serial 이 오지만,
 * 나중에 조회한 저널 항목(agent)이나 agent echo 에는 serial 이 빠져 올 수 있다
 * (2026-10-06 개발 코어 실측 — 매뉴얼은 붙여 준다고 하지만 아직 없음).
 *
 * 그래서 이 서버가 보낸 발신을 잠시 기억했다가, serial 없는 agent 항목이 들어오면
 * 본문으로 짝을 찾아 serial 을 붙인다. 짝을 한 번 맺으면 seq 로 고정되어 재조회에도 같다.
 *
 *   텍스트 발신 → 저널 본문 = 보낸 text
 *   첨부 발신   → 저널 본문 = 캡션(text), 캡션이 없으면 "[첨부]" — 묶음이어도 저널 항목은 1건
 *
 * 샘플이라 메모리에만 둔다. 운영에서는 메시지 테이블의 serial 컬럼이 이 역할을 한다.
 */

const KEEP_MS = 24 * 60 * 60 * 1000; // 발신 취소 가능 시간만큼만 기억
const pending = new Map(); // userKey -> [{ texts, serial, serials, at, seq }]
const bySeq = new Map();   // `${userKey}#${seq}` -> { serial, serials }

/** 발신 성공 직후 기록한다. serials 는 첨부 발신의 말풍선별 serial 목록. */
export function record(userKey, { texts, serials }) {
  const list = (serials || []).filter(Boolean);
  if (!list.length) return;
  const now = Date.now();
  const q = (pending.get(userKey) || []).filter((e) => now - e.at < KEEP_MS);
  q.push({ texts: texts.filter((t) => t != null), serial: list[0], serials: list, at: now, seq: null });
  pending.set(userKey, q);
}

/** serial 없는 agent 항목에 serial 을 붙여 돌려준다. 짝이 없으면 그대로. */
export function claim(userKey, msg) {
  if (!msg || msg.kind !== 'agent' || msg.seq == null || Number.isNaN(msg.seq)) return msg;
  const key = `${userKey}#${msg.seq}`;
  let hit = bySeq.get(key);
  if (!hit && !msg.serial) {
    const e = (pending.get(userKey) || []).find((x) => x.seq == null && x.texts.includes(msg.text));
    if (e) {
      e.seq = msg.seq;
      hit = { serial: e.serial, serials: e.serials };
      bySeq.set(key, hit);
    }
  }
  if (!hit) return msg;
  const out = { ...msg };
  if (!out.serial) out.serial = hit.serial;
  if (hit.serials.length > 1 && !out.serials) out.serials = hit.serials;
  return out;
}
