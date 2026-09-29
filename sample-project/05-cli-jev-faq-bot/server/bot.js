import { config } from './config.js';
import { cliRoomMessages, cliSend, cliEndWithBot } from './cli.js';
import { systemOne, jevReady, topN } from './jev.js';
import { loadRules, OFF_TOPIC } from './rules.js';
import { broadcast } from './sse.js';

/**
 * ── Jev 자동응대 엔진 ─────────────────────────────────────────────────────
 *
 * Jev 는 답장을 쓰지 않는다. 고른다. 그래서 이 엔진의 한 턴은 이렇게 생겼다:
 *
 *   ① 고객 메시지 + 직전 봇 질문 + 최근 대화  →  Jev 에 **한 번** 묻는다 (질문 여러 개를 병렬로)
 *        intent        choice  FAQ 카드 · 시나리오 · greeting · none 중 무엇인가
 *        step          choice  (시나리오 진행 중) 직전 질문에 대한 대답은 어느 선택지인가 · off_topic
 *        confirm       noul    (되묻기 직후) 고객이 "네, 그거요" 라고 확인했는가
 *        wants_human   noul    사람 상담원을 원하는가
 *        frustration   score   얼마나 불만스러운가 (평온 · 약간 불편 · 매우 화남)
 *   ② 확신도(confidence)로 갈래를 정한다
 *        ≥ 자동 답변 기준   → FAQ 답변 그대로 발신 / 시나리오 시작·진행
 *        ≥ 되묻기 기준      → "혹시 ○○ 문의이실까요?" (다음 턴 confirm 으로 확인)
 *        그 아래 · none     → 모를 때 문구 (지어내지 않는다)
 *   ③ 고객에게 나가는 문장은 **전부 규칙에 사람이 써 둔 글**이다. Jev 응답의 어떤 값도 문장으로 조립하지 않는다.
 *
 * 무한 루프·오발신 가드는 04 와 같다:
 *   - `kind:"message"` (고객 발화)만 트리거한다. `agent` 는 내 발신의 echo — 절대 응답하지 않는다
 *   - 게이트웨이 저널 재생: 부팅 시점 lastSeq 이하 + TB_BOT_MAX_AGE_SEC 보다 오래된 메시지는 무시
 *   - 디바운스 · 방별 직렬화 · 1분 5회 속도 제한 · 사람 개입 시 정지 · dry-run 기본
 */

const AFTER_LABEL = { stay: '계속 대화', handoff: '상담원 연결', end: '상담 종료(봇 전환)' };
const BUILTIN = {
  greeting: '처음 인사·안부만 있고 구체적인 문의 내용이 없음',
  thanks: '감사 표현·마무리 인사 (고마워요, 알겠습니다, 해결됐어요)',
  none: '위 어느 것에도 해당하지 않는 문의 · 잡담 · 알아들을 수 없는 말',
};
const MAX_REASK = 2;

/* ── 상태 ─────────────────────────────────────────────────────────────── */

function blankState() {
  return {
    flowId: '',
    stepId: '',
    collected: {},        // { 단계 id: 고른 선택지 라벨 }
    pendingConfirm: null, // { kind: 'faq'|'flow', id, title } — 되묻기 뒤 다음 턴에 확인
    reasks: 0,
    lastRoute: '',
    completed: false,
    paused: false,
    pausedReason: '',
    sessionId: null,
    turns: 0,
    botReplies: [],       // [{ text, at, sent }] — echo 판별 + dry-run 답장도 맥락에 넣기 위해
    lastError: null,
    updatedAt: null,
  };
}

const rooms = new Map();     // userKey → { state, timer, busy, dirty, replyTimes[] }
const sims = new Map();      // simId → { state, transcript[] }
const bootSeq = new Map();   // userKey → 부팅 시점 lastSeq (저널 재생 가드)
const activity = [];         // 최근 봇 활동 로그 (화면용 링버퍼)

function room(userKey) {
  if (!rooms.has(userKey)) rooms.set(userKey, { state: blankState(), timer: null, busy: false, dirty: false, replyTimes: [] });
  return rooms.get(userKey);
}

function publicState(s) {
  const { botReplies, ...rest } = s;
  return { ...rest, botReplyCount: botReplies.length };
}

function log(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  activity.unshift(e);
  if (activity.length > 200) activity.length = 200;
  broadcast('bot', e);
  if (e.simId) return; // 시뮬레이터 턴은 화면·sim 스크립트가 보여준다
  console.log(`[bot] ${e.type} · ${e.userKey}${e.text ? ` · ${String(e.text).slice(0, 60).replace(/\s+/g, ' ')}` : ''}${e.detail?.reason ? ` (${e.detail.reason})` : ''}`);
}

/* ── Jev 요청 조립 ────────────────────────────────────────────────────── */

/** 카드 → Jev 선택지 설명. 예시·경계가 있으면 객체 형식({what, examples, not_for})으로 헷갈리는 선택지를 가른다 */
function describe(c, fallback) {
  const what = c.what || fallback;
  if (!c.examples?.length && !c.notFor) return what;
  const d = { what };
  if (c.examples?.length) d.examples = c.examples;
  if (c.notFor) d.not_for = c.notFor;
  return d;
}

function optionCriteria(step, offTopic) {
  const crit = {};
  for (const o of step.options) crit[o.id] = o.examples.length ? { what: o.label, examples: o.examples } : o.label;
  crit[OFF_TOPIC] = offTopic;
  return crit;
}

function currentFlow(rules, state) {
  const flow = rules.flows.find((f) => f.enabled && f.id === state.flowId);
  const step = flow?.steps.find((s) => s.id === state.stepId);
  return { flow, step };
}

/**
 * 이번 턴에 Jev 로 보낼 { state, questions } — 라이브·시뮬레이터·평가(eval.mjs)·[Jev 요청 보기] 공통.
 * @param {Array<{role, text}>} transcript  이번 세션 대화 (마지막은 고객 메시지들)
 * @param {string[]} pendingTexts           아직 답하지 않은 고객 메시지들
 */
export function buildRequest(rules, state, transcript, pendingTexts) {
  const { flow, step } = currentFlow(rules, state);
  const before = transcript.slice(0, Math.max(0, transcript.length - pendingTexts.length));
  const lastBot = [...before].reverse().find((m) => m.role === 'assistant')?.text || '';
  const recent = rules.settings.historyTurns
    ? before.slice(-rules.settings.historyTurns * 2).map((m) => `${m.role === 'user' ? '고객' : '봇'}: ${m.text}`)
    : [];

  const jstate = { customer_message: pendingTexts.join('\n') };
  if (lastBot) jstate.bot_last_message = lastBot;
  if (recent.length) jstate.recent_conversation = recent;

  const intentCriteria = {};
  for (const f of rules.faqs) if (f.enabled) intentCriteria[f.id] = describe(f, f.title);
  for (const f of rules.flows) if (f.enabled && f.steps.length) intentCriteria[f.id] = describe(f, f.name);
  Object.assign(intentCriteria, BUILTIN);

  const questions = {
    intent: {
      type: 'choice',
      instructions: '고객의 최근 메시지(customer_message)는 어떤 문의인가? 앞의 대화는 맥락으로만 참고한다.',
      criteria: intentCriteria,
    },
    wants_human: {
      type: 'noul',
      instructions: '고객이 자동응대봇이 아닌 사람 상담원과 직접 이야기하길 원한다',
    },
    frustration: {
      type: 'score',
      instructions: '고객의 최근 메시지는 얼마나 불만스러운가?',
      criteria: ['평온함', '약간 불편함', '매우 화남'],
    },
  };

  if (step) {
    questions.step = {
      type: 'choice',
      instructions: `봇이 "${step.ask}" 라고 물었다. ${step.judge || '고객의 대답(customer_message)은 어느 선택지에 해당하는가?'}`,
      criteria: optionCriteria(step, '봇 질문에 대한 대답이 아님 — 다른 주제의 질문·요청·잡담'),
    };
  }

  // Speculative fan-out — 다른 시나리오의 첫 단계를 미리 묻는다.
  // "연동하려는데 도메인이 없어요" 처럼 첫 메시지에 첫 질문의 답이 이미 있으면, 시나리오에 들어가며 그 단계를 건너뛴다.
  // 질문이 늘어도 Jev 는 병렬로 평가하므로 지연은 거의 같다 (실측: 질문 3개 → 7개, 250ms 안팎 그대로).
  for (const f of rules.flows) {
    if (!f.enabled || !f.steps.length || f.id === flow?.id) continue;
    const first = f.steps[0];
    questions[`pre:${f.id}`] = {
      type: 'choice',
      instructions: `고객 메시지에 "${first.ask}" 에 대한 답이 이미 들어 있다면 어느 선택지인가? ${first.judge || ''} 답이 들어 있지 않으면 ${OFF_TOPIC}.`.replace(/\s+/g, ' '),
      criteria: optionCriteria(first, '이 질문에 대한 답이 메시지에 없음'),
    };
  }

  if (state.pendingConfirm) {
    questions.confirm = {
      type: 'noul',
      instructions: `봇이 "${state.pendingConfirm.title}" 문의가 맞는지 물었고, 고객이 그렇다고 확인했다`,
    };
  }

  return { state: jstate, questions, context: { flow, step } };
}

/* ── 판정 → 답장 (결정적 · Jev 응답은 고르는 데만 쓴다) ─────────────── */

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

function decide(rules, state, A) {
  const S = rules.settings;
  const P = rules.persona;
  const { flow, step } = currentFlow(rules, state);
  const intent = A.intent || { choice: 'none', confidence: 0, probabilities: {} };
  const findTarget = (id) => {
    const faq = rules.faqs.find((f) => f.enabled && f.id === id);
    if (faq) return { kind: 'faq', id, title: faq.title, faq };
    const fl = rules.flows.find((f) => f.enabled && f.steps.length && f.id === id);
    if (fl) return { kind: 'flow', id, title: fl.name, flow: fl };
    return null;
  };

  const handoff = (reply, route, reason) => {
    state.paused = true;
    state.pausedReason = reason;
    return { action: 'handoff', reply, route, reason };
  };

  const afterAction = (after, reply, route, reason, name) => {
    if (after === 'handoff') return handoff(reply, route, `"${name}" 답변 후 상담원 연결`);
    if (after === 'end') return { action: 'end', reply, route, reason };
    return { action: 'reply', reply, route, reason };
  };

  const enterFaq = (t, route, reason) => {
    state.flowId = '';
    state.stepId = '';
    state.reasks = 0;
    if (!t.faq.answer) return { action: 'reply', reply: P.fallback, route: 'fallback', reason: `FAQ "${t.title}" 에 답변이 비어 있음` };
    return afterAction(t.faq.after, t.faq.answer, route, reason, t.title);
  };

  /** 단계의 선택지가 정해졌을 때 — 받은 정보 기록 → 다음 단계 질문 또는 마무리 */
  const applyOption = (fl, st, opt, conf, route, prefixReason = '') => {
    state.collected[st.id] = opt.label;
    state.reasks = 0;
    const idx = fl.steps.indexOf(st);
    const next = opt.next === 'done' ? null
      : opt.next ? fl.steps.find((s) => s.id === opt.next)
      : fl.steps[idx + 1];
    const reason = `${prefixReason}${st.id} = "${opt.label}" (${pct(conf)})`;
    if (next) {
      state.flowId = fl.id;
      state.stepId = next.id;
      return { action: 'reply', reply: [opt.say, next.ask].filter(Boolean).join('\n\n'), route, reason };
    }
    state.completed = true;
    state.flowId = '';
    state.stepId = '';
    const reply = [opt.say, fl.done].filter(Boolean).join('\n\n') || P.fallback;
    return afterAction(fl.after, reply, 'flow-done', `${reason} → "${fl.name}" 완료`, fl.name);
  };

  const enterFlow = (t, route, reason) => {
    state.flowId = t.id;
    state.stepId = t.flow.steps[0].id;
    state.completed = false;
    state.reasks = 0;
    // 첫 메시지에 첫 질문의 답이 이미 있으면(speculative fan-out 결과) 그 단계를 건너뛴다 — 추측이므로 자동 답변 기준으로 엄격하게
    const pre = A[`pre:${t.id}`];
    const first = t.flow.steps[0];
    const opt = pre && pre.choice !== OFF_TOPIC && pre.confidence >= S.autoThreshold ? first.options.find((o) => o.id === pre.choice) : null;
    if (opt) return applyOption(t.flow, first, opt, pre.confidence, `${route}+prefill`, `${reason} · 첫 메시지에 답 있음: `);
    return { action: 'reply', reply: first.ask, route, reason };
  };

  const enter = (t, route, reason) => (t.kind === 'faq' ? enterFaq(t, route, reason) : enterFlow(t, route, reason));

  // 1) 사람을 원함 · 매우 화남 → 상담원 (Jev 로 판정 · 키워드는 takeTurn 에서 먼저 걸렀다)
  const human = A.wants_human?.noul ?? 0;
  if (human >= S.humanThreshold) return handoff(rules.handoff.message, 'human', `상담원 요청 ${pct(human)}`);
  const frus = A.frustration;
  if (S.angryHandoff && frus && frus.score >= 1.5) return handoff(rules.handoff.message, 'angry', `불만도 ${frus.score.toFixed(2)}/2 — 매우 화남`);

  // 2) 되묻기에 대한 확인
  if (state.pendingConfirm) {
    const pc = state.pendingConfirm;
    state.pendingConfirm = null;
    const yes = A.confirm?.noul ?? 0;
    const t = findTarget(pc.id);
    if (t && yes >= 0.7) return enter(t, 'confirmed', `"${pc.title}" 확인 ${pct(yes)}`);
    // 아니라고 했거나 애매하면 이번 메시지를 새 문의로 판정한다 (예: "아뇨, 연동이요")
  }

  // 3) 시나리오 진행 중 — 직전 질문에 대한 대답인가?
  if (flow && step) {
    const sa = A.step;
    const opt = sa && sa.choice !== OFF_TOPIC && sa.confidence >= S.confirmThreshold
      ? step.options.find((o) => o.id === sa.choice) : null;

    if (opt) return applyOption(flow, step, opt, sa.confidence, 'step');

    // 대답이 아니면 — 다른 문의로 넘어갔는지 본다 (자동 답변 기준 이상일 때만)
    const t = intent.confidence >= S.autoThreshold ? findTarget(intent.choice) : null;
    if (t && t.id !== flow.id) {
      if (t.kind === 'faq') {
        // 곁가지 질문 — FAQ 로 답하고 시나리오 질문으로 돌아온다
        if (t.faq.after !== 'stay' || !t.faq.answer) return enterFaq(t, 'faq', `진행 중 다른 문의 "${t.title}" (${pct(intent.confidence)})`);
        return { action: 'reply', reply: `${t.faq.answer}\n\n${step.ask}`, route: 'side-faq', reason: `곁가지 FAQ "${t.title}" (${pct(intent.confidence)}) 후 "${flow.name}" 으로 복귀` };
      }
      return enterFlow(t, 'switch', `"${flow.name}" → "${t.title}" 전환 (${pct(intent.confidence)})`);
    }

    state.reasks += 1;
    if (state.reasks > MAX_REASK) {
      return handoff(rules.handoff.message, 'reask-limit', `"${step.ask.slice(0, 20)}…" 에 ${MAX_REASK}번 다시 물어도 대답을 분류하지 못함`);
    }
    const reply = P.reask.replace('{ask}', step.ask).replace('{options}', step.options.map((o) => o.label).join(' / '));
    return { action: 'reply', reply, route: 'reask', reason: sa ? `대답 판정 ${sa.choice} (${pct(sa.confidence)}) — 다시 묻기 ${state.reasks}/${MAX_REASK}` : '대답 판정 없음' };
  }

  // 4) 새 문의
  if (intent.choice === 'greeting' && intent.confidence >= S.confirmThreshold) {
    return { action: 'reply', reply: P.greeting, route: 'greeting', reason: `인사 (${pct(intent.confidence)})` };
  }
  if (intent.choice === 'thanks' && intent.confidence >= S.confirmThreshold) {
    return { action: 'reply', reply: P.thanks, route: 'thanks', reason: `감사·마무리 (${pct(intent.confidence)})` };
  }
  const t = intent.choice === 'none' ? null : findTarget(intent.choice);
  if (!t || intent.confidence < S.confirmThreshold) {
    return { action: 'reply', reply: P.fallback, route: 'fallback', reason: t ? `"${t.title}" 확신도 ${pct(intent.confidence)} < 되묻기 기준 ${pct(S.confirmThreshold)}` : `해당 없음 (${pct(intent.confidence)})` };
  }
  if (intent.confidence < S.autoThreshold) {
    state.pendingConfirm = { kind: t.kind, id: t.id, title: t.title };
    return { action: 'reply', reply: P.clarify.replace('{title}', t.title), route: 'clarify', reason: `"${t.title}" 확신도 ${pct(intent.confidence)} — 되묻기` };
  }
  return enter(t, t.kind === 'faq' ? 'faq' : 'flow-start', `"${t.title}" ${pct(intent.confidence)}`);
}

/* ── 한 턴 (라이브·시뮬레이터 공통) ───────────────────────────────────── */

function summarize(A) {
  const pick = (a) => (a ? { choice: a.choice, confidence: a.confidence, top: topN(a.probabilities, 3) } : null);
  return {
    intent: pick(A.intent),
    step: pick(A.step),
    confirm: A.confirm?.noul ?? null,
    human: A.wants_human?.noul ?? null,
    frustration: A.frustration ? { score: A.frustration.score, confidence: A.frustration.confidence } : null,
    prefill: Object.fromEntries(Object.entries(A)
      .filter(([k, a]) => k.startsWith('pre:') && a.choice !== OFF_TOPIC)
      .map(([k, a]) => [k.slice(4), { choice: a.choice, confidence: a.confidence }])),
  };
}

/**
 * @returns {Promise<{ action: 'reply'|'handoff'|'end', reply: string, detail: object }>}
 */
async function takeTurn({ transcript, pendingTexts, state }) {
  const rules = loadRules();

  // 1) 상담원 연결 키워드 — Jev 도 부르지 않고 결정적으로 처리한다 (비용 0).
  const hay = pendingTexts.join('\n');
  const hit = rules.handoff.keywords.find((k) => hay.includes(k));
  if (hit) {
    state.paused = true;
    state.pausedReason = `상담원 연결 키워드 "${hit}"`;
    state.turns += 1;
    return { action: 'handoff', reply: rules.handoff.message, detail: { route: 'keyword', reason: state.pausedReason } };
  }

  // 2) Jev 한 번 — 질문 여러 개를 병렬로
  const req = buildRequest(rules, state, transcript, pendingTexts);
  const r = await systemOne({ state: req.state, questions: req.questions });

  // 3) 판정 → 규칙의 글 중 하나
  const d = decide(rules, state, r.answers);
  state.turns += 1;
  state.lastRoute = d.route;

  const { flow, step } = currentFlow(rules, state);
  const detail = {
    route: d.route,
    reason: d.reason,
    flow: flow ? `${flow.name} ${flow.steps.indexOf(step) + 1}/${flow.steps.length}` : null,
    flowId: state.flowId, stepId: state.stepId, completed: state.completed,
    collected: state.collected,
    pendingConfirm: state.pendingConfirm,
    jev: {
      model: r.model, ms: r.ms, attempts: r.attempts, requestId: r.requestId,
      tokens: { input: r.usage.input_tokens, output: r.usage.output_tokens },
      questions: Object.keys(req.questions),
      ...summarize(r.answers),
    },
  };
  return { action: d.action, reply: d.reply, detail };
}

/* ── 라이브: 웹훅에서 호출 ─────────────────────────────────────────────── */

/** 부팅 백필 때 방별 lastSeq 를 기억한다 — 이 seq 이하는 저널 재생이므로 답하지 않는다. */
export function rememberBootSeq(roomList) {
  for (const r of roomList) bootSeq.set(r.userKey, Number(r.lastSeq) || 0);
}

/** webhook.js — 고객 메시지(kind:"message")를 보강한 직후 */
export function onCustomerMessage(userKey, msg) {
  const rules = loadRules();
  if (!rules.settings.enabled) return;

  if (msg.seq != null && msg.seq <= (bootSeq.get(userKey) ?? -1)) return; // 부팅 전 메시지 (저널 재생)
  const ageSec = msg.at ? (Date.now() - Date.parse(msg.at)) / 1000 : 0;
  if (ageSec > config.replyMaxAgeSec) {
    log({ type: 'skip', userKey, text: msg.text, detail: { reason: `${Math.round(ageSec)}초 전 메시지 — 저널 재생으로 보고 응답 안 함 (TB_BOT_MAX_AGE_SEC=${config.replyMaxAgeSec})` } });
    return;
  }

  const R = room(userKey);
  if (R.state.paused) {
    log({ type: 'skip', userKey, text: msg.text, detail: { reason: `봇 일시정지 중 — ${R.state.pausedReason}` } });
    return;
  }
  clearTimeout(R.timer);
  R.timer = setTimeout(() => runLiveTurn(userKey), config.debounceMs);
}

/** webhook.js — seq 있는 `agent` echo. 봇이 보낸 게 아니면 사람이 개입한 것 */
export function onAgentEcho(userKey, msg) {
  const R = rooms.get(userKey);
  if (!R || R.state.paused || !msg.text) return;
  const ageSec = msg.at ? (Date.now() - Date.parse(msg.at)) / 1000 : 0;
  if (ageSec > config.replyMaxAgeSec) return;
  const mine = R.state.botReplies.some((b) => b.text.trim() === msg.text.trim());
  if (!mine) pause(userKey, '상담원이 직접 답장함 — 사람이 이어받음');
}

/** webhook.js — reference(새 상담) · ended · expired → 세션 경계. 진행 상태와 일시정지를 초기화 */
export function onSessionBoundary(userKey, kind) {
  const R = rooms.get(userKey);
  if (!R) return;
  clearTimeout(R.timer);
  R.state = blankState();
  log({ type: 'reset', userKey, detail: { reason: kind === 'reference' ? '새 상담 연결' : kind === 'expired' ? '세션 만료' : '상담 종료' } });
}

/**
 * 실제 상담방의 이번 세션 대화 (04 와 같다).
 * @returns {{ transcript: Array<{role, text, at}>, pending: string[] }}  pending = 마지막 봇/상담원 발화 뒤의 고객 메시지
 */
export async function transcriptFor(userKey, state, limit) {
  const all = await cliRoomMessages(userKey, limit + 10); // seq 오름차순
  if (!all.length) return { transcript: [], pending: [] };

  // 같은 상담 세션만 — agent(발신) 항목에는 sessionId 가 없어(v1.1.0 실측) seq 범위로 자른다
  const sessionId = [...all].reverse().find((m) => m.kind === 'message' && m.sessionId)?.sessionId ?? null;
  const lastEnd = [...all].reverse().find((m) => m.kind === 'ended' || m.kind === 'expired')?.seq ?? -Infinity;
  const firstOfSession = sessionId ? Math.min(...all.filter((m) => m.sessionId === sessionId).map((m) => m.seq)) : -Infinity;
  const fromSeq = Math.max(lastEnd + 1, firstOfSession);

  if (state.sessionId && sessionId && state.sessionId !== sessionId) {
    Object.assign(state, { ...blankState(), sessionId });
  }
  state.sessionId = sessionId;

  const items = all
    .filter((m) => (m.kind === 'message' || m.kind === 'agent') && m.seq >= fromSeq)
    .map((m) => ({ role: m.kind === 'agent' ? 'assistant' : 'user', text: m.text, at: m.at }));

  // 저널에 아직 안 잡힌 봇 답장(발신 직후·dry-run)을 시각 순으로 끼워 넣는다 — Jev 가 "직전 봇 질문" 을 알아야 한다
  const firstAt = items[0]?.at || '';
  for (const b of state.botReplies) {
    if (b.at < firstAt) continue;
    if (!items.some((m) => m.role === 'assistant' && m.text.trim() === b.text.trim())) {
      items.push({ role: 'assistant', text: b.text, at: b.at, shadow: !b.sent });
    }
  }
  items.sort((a, b) => (a.at || '').localeCompare(b.at || ''));

  let i = items.length;
  while (i > 0 && items[i - 1].role === 'user') i--;
  return { transcript: items, pending: items.slice(i).map((m) => m.text) };
}

async function runLiveTurn(userKey) {
  const R = room(userKey);
  if (R.busy) { R.dirty = true; return; }
  R.busy = true;
  const rules = loadRules();
  const S = R.state;

  try {
    if (!rules.settings.enabled || S.paused) return;
    if (!jevReady()) throw new Error(config.jev.keyError);

    const { transcript, pending } = await transcriptFor(userKey, S, 30);
    if (!pending.length) return; // 이미 답한 상태

    // 속도 제한 — 이상 루프·스팸 방어
    R.replyTimes = R.replyTimes.filter((t) => Date.now() - t < 60000);
    if (R.replyTimes.length >= 5) {
      pause(userKey, '1분에 5회 이상 응답 — 속도 제한으로 정지');
      return;
    }

    const turn = await takeTurn({ transcript, pendingTexts: pending, state: S });
    const sent = await deliver(userKey, turn.reply, rules.settings.live);
    R.replyTimes.push(Date.now());
    S.botReplies.push({ text: turn.reply, at: new Date().toISOString(), sent: sent.ok && rules.settings.live });
    if (S.botReplies.length > 30) S.botReplies.shift();
    S.lastError = sent.ok ? null : sent.raw;
    S.updatedAt = new Date().toISOString();

    log({
      type: turn.action, userKey, text: turn.reply,
      detail: { ...turn.detail, live: rules.settings.live, sent: sent.ok, sendResult: sent.raw, customer: pending },
    });

    if (turn.action === 'end' && rules.settings.live && sent.ok) {
      const e = await cliEndWithBot(userKey);
      log({ type: e.ok ? 'ended' : 'error', userKey, detail: { reason: e.ok ? '완료 → end-with-bot' : `end-with-bot 실패: ${e.raw}` } });
    }
  } catch (err) {
    S.lastError = err.message;
    log({ type: 'error', userKey, detail: { reason: err.message } });
    // 고객을 기다리게 두지 않는다 — 오류 안내 문구가 있으면 보내고 사람에게 넘긴다.
    if (rules.handoff.errorMessage && !S.paused) {
      const sent = await deliver(userKey, rules.handoff.errorMessage, rules.settings.live);
      S.botReplies.push({ text: rules.handoff.errorMessage, at: new Date().toISOString(), sent: sent.ok && rules.settings.live });
      pause(userKey, `Jev 오류로 상담원 연결 — ${err.message}`);
    }
  } finally {
    R.busy = false;
    broadcast('bot-state', { userKey, state: publicState(S) });
    if (R.dirty) {
      R.dirty = false;
      clearTimeout(R.timer);
      R.timer = setTimeout(() => runLiveTurn(userKey), 300);
    }
  }
}

/** 실발신(live) 이면 CLI send, 아니면 dry-run — 판정만 하고 화면·로그에만 남긴다(과금 없음). */
async function deliver(userKey, text, live) {
  if (!text) return { ok: false, raw: '빈 답장' };
  if (!live) return { ok: true, raw: 'dry-run (실발신 꺼짐)' };
  return cliSend(userKey, text);
}

export function pause(userKey, reason) {
  const R = room(userKey);
  clearTimeout(R.timer);
  R.state.paused = true;
  R.state.pausedReason = reason;
  log({ type: 'pause', userKey, detail: { reason } });
  broadcast('bot-state', { userKey, state: publicState(R.state) });
}

export function resume(userKey) {
  const R = room(userKey);
  R.state.paused = false;
  R.state.pausedReason = '';
  R.state.reasks = 0;
  R.replyTimes = [];
  log({ type: 'resume', userKey, detail: { reason: '운영자가 봇 재개' } });
  broadcast('bot-state', { userKey, state: publicState(R.state) });
}

export function roomStates() {
  return Object.fromEntries([...rooms].map(([k, R]) => [k, publicState(R.state)]));
}

export function recentActivity(limit = 100) {
  return activity.slice(0, limit);
}

/* ── 시뮬레이터: 카카오 발신 없이 같은 엔진을 돌린다 ─────────────────────── */

function simPending(sim) {
  let i = sim.transcript.length;
  while (i > 0 && sim.transcript[i - 1].role === 'user') i--;
  return sim.transcript.slice(i).map((m) => m.text);
}

export async function simulate(simId, text) {
  if (!sims.has(simId)) sims.set(simId, { state: blankState(), transcript: [] });
  const sim = sims.get(simId);
  const S = sim.state;
  sim.transcript.push({ role: 'user', text, at: new Date().toISOString() });

  if (S.paused) {
    return { skipped: true, reason: `봇 일시정지 — ${S.pausedReason} (초기화하면 다시 시작)`, state: publicState(S) };
  }
  if (!jevReady()) throw new Error(config.jev.keyError);

  const turn = await takeTurn({ transcript: sim.transcript, pendingTexts: simPending(sim), state: S });
  sim.transcript.push({ role: 'assistant', text: turn.reply, at: new Date().toISOString() });
  log({ type: turn.action, simId, text: turn.reply, detail: { ...turn.detail, simulator: true, customer: [text] } });
  return { action: turn.action, reply: turn.reply, detail: turn.detail, state: publicState(S) };
}

export function resetSim(simId) {
  sims.delete(simId);
}

/** [Jev 요청 보기] — 다음 고객 메시지를 이 문장으로 가정하고 실제로 보낼 요청 본문 */
export function previewRequest(simId, sampleText = '(고객 메시지)') {
  const sim = sims.get(simId);
  const state = sim?.state || blankState();
  const transcript = [...(sim?.transcript || []), { role: 'user', text: sampleText }];
  const { state: jstate, questions } = buildRequest(loadRules(), state, transcript, [sampleText]);
  return { state: jstate, model: config.jev.model, questions };
}

export { AFTER_LABEL, blankState };
