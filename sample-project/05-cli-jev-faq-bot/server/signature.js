import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * ── 웹훅 서명 검증 ────────────────────────────────────────────────────────
 *
 * 실측으로 확정한 계약(TalkBridge CLI v1.0.0 게이트웨이, 11/11 일치):
 *
 *   서명대상 = "v0:" + X-Bridge-Timestamp + ":" + <원본 raw body 바이트>
 *   서명값   = "v0=" + lowerhex( HMAC_SHA256( whsec 문자열 전체(UTF-8), 서명대상 ) )
 *
 * 핵심: **raw body 를 그대로** 써야 한다.
 * JSON.parse 후 JSON.stringify 로 되돌리면 공백·키 순서가 달라져 서명이 깨진다.
 * (게이트웨이가 보내는 키 순서는 userKey, kind, seq, brand 로 우리 모델 순서와 다르다)
 */
export function verifySignature(headers, rawBody) {
  const sig = headers['x-bridge-signature'];
  const ts = headers['x-bridge-timestamp'];

  if (!sig || !ts) {
    return { ok: false, reason: '서명 헤더 없음' };
  }

  if (config.toleranceSec > 0) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (!Number.isFinite(skew) || skew > config.toleranceSec) {
      return { ok: false, reason: `타임스탬프 편차 ${skew}s > 허용 ${config.toleranceSec}s (리플레이 의심)` };
    }
  }

  const expected =
    'v0=' +
    crypto
      .createHmac('sha256', config.webhookSecret)
      .update('v0:' + ts + ':')
      .update(rawBody)
      .digest('hex');

  // 길이가 다르면 timingSafeEqual 이 throw 하므로 먼저 거른다.
  if (sig.length !== expected.length) {
    return { ok: false, reason: '서명 불일치(길이)' };
  }
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return ok ? { ok: true } : { ok: false, reason: '서명 불일치' };
}
