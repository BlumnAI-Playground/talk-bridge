import { config } from './config.js';

/**
 * ── Jev 호출 (TypeSafe System One API · 의존성 0 — Node 18 내장 fetch) ─────────
 *
 *   POST {JEV_BASE_URL}/v1/systemone
 *   { state, model: "jev-latest", questions: { key: { type, instructions, criteria } } }
 *
 * Jev 는 **문장을 만들지 않는다.** 미리 정한 선택지 중 하나를 고르고 확률과 확신도(confidence)를 준다.
 *   choice  선택지(최대 255) 중 하나   → { choice, probabilities, confidence }
 *   noul    참일 확률 0~1              → { noul }            ← confidence 없음
 *   score   순서 있는 2~10 단계 점수   → { score, probabilities, confidence, legend }
 *
 * 한 요청에 질문을 여러 개 넣으면 **병렬로** 평가된다 — 봇은 매 턴 한 번만 부른다(speculative fan-out).
 *
 * 공식 SDK(@typesafe-ai/sdk)는 Node 20+ 이고 이 샘플은 의존성 0 · Node 18+ 이라 쓰지 않는다.
 * 재시도 정책은 SDK 기본값을 따른다: 429·529·5xx·네트워크 오류만 지수 백오프(500ms→5s, jitter 25%, Retry-After 존중).
 * 401(키)·422(요청 형식)는 재시도해도 같으므로 바로 실패한다.
 *
 * 실측(2026-09-29, 한국어): 질문 1~4개 · 입력 300~700 토큰 · 왕복 170~350ms · 응답 model "jev-1.13.0".
 */

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function jevReady() {
  return Boolean(config.jev.apiKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt, retryAfter) {
  if (retryAfter != null && Number.isFinite(retryAfter)) return Math.min(60000, retryAfter * 1000);
  const base = Math.min(5000, 500 * 2 ** attempt);
  return Math.round(base * (1 + (Math.random() * 2 - 1) * 0.25));
}

/**
 * @param {object} p
 * @param {string|object|Array} p.state    판정 대상 (구조화 권장)
 * @param {Record<string, object>} p.questions
 * @returns {Promise<{ answers: object, usage: object, model: string, ms: number, requestId: string|null, attempts: number }>}
 */
export async function systemOne({ state, questions }) {
  if (!config.jev.apiKey) throw new Error(config.jev.keyError || 'Jev 키가 없습니다');

  const body = JSON.stringify({ state, model: config.jev.model, questions });
  const t0 = Date.now();
  let lastErr;

  for (let attempt = 0; attempt <= config.jev.maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.jev.timeoutMs);
    let res;
    try {
      res = await fetch(`${config.jev.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.jev.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      lastErr = new Error(err.name === 'AbortError'
        ? `Jev 응답 ${config.jev.timeoutMs}ms 타임아웃 (JEV_TIMEOUT_MS)`
        : `Jev 연결 실패: ${err.message}`);
      if (attempt < config.jev.maxRetries) { await sleep(backoff(attempt)); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }

    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        answers: json.answers || {},
        usage: json.usage || {},
        model: json.model || config.jev.model,
        ms: Date.now() - t0,
        requestId: res.headers.get('x-typesafe-request-id'),
        attempts: attempt + 1,
      };
    }

    // 원인 + 다음 행동. 키는 절대 메시지에 싣지 않는다.
    const detail = json?.error?.message || json?.detail?.[0]?.msg || json?.message || '';
    const hint = res.status === 401 ? ' — 키가 틀렸거나 폐기됨 (.secret/jev.json)'
      : res.status === 422 ? ' — 요청 형식 오류 (선택지 수·질문 형식 확인)'
      : res.status === 429 ? ' — 속도 한도 초과'
      : res.status === 529 ? ' — Jev 과부하'
      : '';
    lastErr = new Error(`Jev ${res.status}${detail ? `: ${detail}` : ''}${hint}`);
    if (!RETRYABLE.has(res.status) || attempt >= config.jev.maxRetries) throw lastErr;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(backoff(attempt, Number.isFinite(ra) && ra > 0 ? ra : null));
  }
  throw lastErr;
}

/** 확률 분포에서 상위 n 개 [{ id, p }] */
export function topN(probabilities, n = 3) {
  return Object.entries(probabilities || {})
    .map(([id, p]) => ({ id, p: Number(p) || 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, n);
}
