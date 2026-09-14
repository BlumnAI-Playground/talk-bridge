import { config } from './config.js';

/**
 * ── OpenAI 호출 (Responses API · 의존성 0 — Node 18 내장 fetch) ─────────────
 *
 * 추론 모델(gpt-5.x)은 Chat Completions 보다 Responses API 가 권장 경로다.
 *   POST {OPENAI_BASE_URL}/responses
 *   { model, reasoning: { effort }, instructions, input: [...대화], text: { format: json_schema } }
 *
 * - 응답은 **JSON 스키마(strict)** 로 강제한다 → 봇 엔진이 reply·시나리오·단계를 안전하게 읽는다
 * - `store: false` — 상담 내용을 OpenAI 쪽 대화 저장소에 남기지 않는다. 맥락은 매 턴 CLI 이력으로 다시 보낸다
 * - 추론 모델은 temperature 를 받지 않으므로 보내지 않는다
 *
 * 실측(2026-09-14): gpt-5.6-terra · effort=medium · 짧은 JSON 응답 ≈ 3초.
 */

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

export function openaiReady() {
  return Boolean(config.openai.apiKey);
}

/**
 * @param {object} p
 * @param {string} p.instructions   시스템 지침
 * @param {Array<{role:'user'|'assistant', content:string}>} p.input  대화
 * @param {object} p.schema         JSON 스키마 (strict)
 * @param {string} [p.model]
 * @param {string} [p.effort]       none|minimal|low|medium|high — 빈 값이면 모델 기본
 * @returns {Promise<{ data: object, usage: object, ms: number, model: string }>}
 */
export async function respondJson({ instructions, input, schema, schemaName = 'bot_turn', model, effort }) {
  if (!config.openai.apiKey) throw new Error(config.openai.keyError || 'OpenAI 키가 없습니다');

  const body = {
    model: model || config.openai.model,
    instructions,
    input,
    store: false,
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
  };
  const eff = effort ?? config.openai.reasoningEffort;
  if (eff) body.reasoning = { effort: eff };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.openai.timeoutMs);
  let res;
  try {
    res = await fetch(`${config.openai.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.openai.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? `OpenAI 응답 ${config.openai.timeoutMs}ms 타임아웃 (OPENAI_TIMEOUT_MS)`
      : `OpenAI 연결 실패: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 원인 + 다음 행동. 키는 절대 메시지에 싣지 않는다.
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' — 키가 틀렸거나 폐기됨 (.secret/openai.json)'
      : res.status === 404 ? ` — 모델 "${body.model}" 을 이 키로 쓸 수 없음 ([설정] 에서 모델 변경)`
      : res.status === 429 ? ' — 사용량/속도 한도 초과'
      : res.status === 400 && /reasoning/i.test(msg) ? ' — 이 모델은 추론 강도 옵션을 받지 않음 ([설정] 에서 비우기)'
      : '';
    throw new Error(`OpenAI ${res.status}: ${msg}${hint}`);
  }

  // output[] 에는 reasoning 항목이 섞일 수 있다 — message 의 output_text 만 모은다.
  const text = (json.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
  const refusal = (json.output || []).flatMap((o) => o.content || []).find((c) => c.type === 'refusal');
  if (!text && refusal) throw new Error(`모델이 응답을 거절했습니다: ${refusal.refusal}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`모델 응답이 JSON 이 아닙니다 (status=${json.status}${json.incomplete_details ? `, ${JSON.stringify(json.incomplete_details)}` : ''})`);
  }
  return { data, usage: json.usage || {}, ms: Date.now() - t0, model: json.model || body.model };
}
