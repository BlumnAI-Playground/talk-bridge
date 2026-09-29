import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * ── 자동응대 규칙 저장소 (05 · Jev 판정형) ──────────────────────────────────
 *
 * 웹 화면에서 편집한 규칙을 JSON 파일 하나(data/bot.json)에 저장한다.
 * 파일이 없으면 데모 규칙(data/demo-bot.json — 톡브릿지 상담센터)을 복사해 시작한다.
 *
 * 04 와 가장 큰 차이: Jev 는 문장을 쓰지 않는다. 그래서 **고객에게 나가는 문장은 전부 여기 있는 글**이고,
 * Jev 는 "어느 글을 보낼지" 만 고른다. 규칙은 곧 Jev 에게 보낼 **선택지(criteria)** 이기도 하다.
 *
 *   settings  봇 켜기/끄기 · 실발신 · 판정 임계값(자동 답변 · 되묻기 · 상담원 요청) · 화남 시 연결 · 맥락 턴 수
 *   persona   봇 이름 · 인사 · 모를 때 · 되묻기 · 다시 묻기 문구
 *   faqs      [{ id, title, enabled, what, examples[], notFor, answer, after }]
 *             what/examples/notFor → Jev 선택지 설명 · answer → 고객에게 그대로 나가는 답
 *   flows     [{ id, name, enabled, what, examples[], notFor, steps[], done, after }]
 *             steps [{ id, ask, judge, options[{ id, label, examples[], say, next }] }]
 *               ask    봇이 묻는 말 (고정 문구)
 *               judge  Jev 에게 주는 판정 지시 (비우면 ask 로 판정)
 *               options 고객 대답을 분류할 선택지 — say 는 고른 뒤 덧붙일 말, next 는 다음 단계 id · "done" · 빈 값(다음 순서)
 *             done   마지막에 보낼 마무리 문구
 *   handoff   상담원 연결 키워드 · 연결 안내 · Jev 오류 시 안내
 *   after     stay(계속 대화) · handoff(상담원 연결 = 봇 정지) · end(상담 종료 + 봇 전환)
 *
 * 운영에서는 이 파일 대신 DB·관리자 권한·변경 이력을 두면 된다(README §8).
 */

export const AFTER = ['stay', 'handoff', 'end'];

/** Jev 선택지 상한(공식 255)에서 내장 선택지(greeting·none)와 여유분을 뺀 값 */
export const MAX_INTENTS = 250;
/** 엔진이 단계 선택지에 자동으로 붙이는 "질문에 대한 대답이 아님" 선택지 id — 사용자 선택지 id 로 쓸 수 없다 */
export const OFF_TOPIC = 'off_topic';
/** 엔진이 의도 선택지에 자동으로 붙이는 내장 선택지 — FAQ·시나리오 id 로 쓸 수 없다 */
const RESERVED_INTENTS = ['greeting', 'thanks', 'none'];

const LIMIT = { short: 80, medium: 400, long: 2000, faqs: 200, flows: 40, steps: 10, options: 30, examples: 8 };

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function slug(v, fallback) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

function uniqueIds(items, prefix, reserved = []) {
  const seen = new Set(reserved);
  return items.map((it, i) => {
    let id = slug(it.id, `${prefix}${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...it, id };
  });
}

const list = (v, max, each) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split('\n'))
  .map((x) => str(x, each)).filter(Boolean))].slice(0, max);

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/**
 * 화면에서 온 규칙을 정규화한다. 모르는 필드는 버리고, 길이를 자르고, id 를 유일하게 만든다.
 * 잘못된 입력에 throw 하기보다 "고쳐서 저장 + 무엇을 고쳤는지" 를 돌려주는 편이 편집 UX 에 맞다.
 */
export function normalize(input) {
  const warnings = [];
  const r = input && typeof input === 'object' ? input : {};
  const s = r.settings || {};

  const settings = {
    enabled: s.enabled !== false,
    live: s.live === true,
    autoThreshold: clamp(s.autoThreshold, 0.3, 1, 0.8),
    confirmThreshold: clamp(s.confirmThreshold, 0, 0.95, 0.5),
    humanThreshold: clamp(s.humanThreshold, 0.5, 1, 0.8),
    angryHandoff: s.angryHandoff !== false,
    historyTurns: Math.round(clamp(s.historyTurns, 0, 12, 4)),
  };
  if (settings.confirmThreshold >= settings.autoThreshold) {
    settings.confirmThreshold = Math.max(0, +(settings.autoThreshold - 0.1).toFixed(2));
    warnings.push(`되묻기 기준은 자동 답변 기준보다 낮아야 해서 ${settings.confirmThreshold} 로 맞췄습니다`);
  }

  const p = r.persona || {};
  const persona = {
    name: str(p.name, LIMIT.short) || '자동응대봇',
    greeting: str(p.greeting, LIMIT.medium) || '안녕하세요! 무엇을 도와드릴까요?',
    thanks: str(p.thanks, LIMIT.medium) || '도움이 되었다니 다행이에요. 더 궁금하신 점 있으면 언제든 말씀해 주세요.',
    fallback: str(p.fallback, LIMIT.medium) || '말씀하신 내용은 제가 정확히 답드리기 어려워요. 상담원 연결을 원하시면 "상담원" 이라고 보내 주세요.',
    clarify: str(p.clarify, LIMIT.medium) || '혹시 "{title}" 문의이실까요? 맞으면 "네" 라고 답해 주세요.',
    reask: str(p.reask, LIMIT.medium) || '{ask}\n(예: {options})',
  };
  if (!persona.clarify.includes('{title}')) warnings.push('되묻기 문구에 {title} 이 없어 고객이 무엇을 확인하는지 모릅니다');

  const card = (x) => ({
    what: str(x?.what, LIMIT.medium),
    examples: list(x?.examples, LIMIT.examples, 120),
    notFor: str(x?.notFor, LIMIT.medium),
  });

  const faqs = uniqueIds(
    (Array.isArray(r.faqs) ? r.faqs : []).slice(0, LIMIT.faqs).map((f) => ({
      id: f?.id || f?.title,
      title: str(f?.title, LIMIT.short) || '이름 없는 FAQ',
      enabled: f?.enabled !== false,
      ...card(f),
      answer: str(f?.answer, LIMIT.long),
      after: AFTER.includes(f?.after) ? f.after : 'stay',
    })),
    'faq', RESERVED_INTENTS,
  );
  // FAQ 와 시나리오는 같은 의도 질문(한 번의 Jev choice)에 선택지로 함께 들어간다 → id 가 겹치면 안 된다
  const faqIds = faqs.map((f) => f.id);

  const flows = uniqueIds(
    (Array.isArray(r.flows) ? r.flows : []).slice(0, LIMIT.flows).map((fl) => {
      const steps = uniqueIds(
        (Array.isArray(fl?.steps) ? fl.steps : []).slice(0, LIMIT.steps).map((st) => ({
          id: st?.id,
          ask: str(st?.ask, LIMIT.medium),
          judge: str(st?.judge, LIMIT.medium),
          options: uniqueIds(
            (Array.isArray(st?.options) ? st.options : []).slice(0, LIMIT.options).map((o) => ({
              id: o?.id || o?.label,
              label: str(o?.label, LIMIT.short),
              examples: list(o?.examples, LIMIT.examples, 80),
              say: str(o?.say, LIMIT.long),
              next: str(o?.next, 40),
            })).filter((o) => o.label),
            'opt', [OFF_TOPIC],
          ),
        })).filter((st) => st.ask),
        'step',
      );
      return {
        id: fl?.id || fl?.name,
        name: str(fl?.name, LIMIT.short) || '이름 없는 시나리오',
        enabled: fl?.enabled !== false,
        ...card(fl),
        steps,
        done: str(fl?.done, LIMIT.long),
        after: AFTER.includes(fl?.after) ? fl.after : 'stay',
      };
    }),
    'flow', [...RESERVED_INTENTS, ...faqIds],
  );

  for (const f of faqs) {
    if (!f.what && !f.examples.length) warnings.push(`FAQ "${f.title}" 에 설명·예시 질문이 없어 Jev 가 고르기 어렵습니다`);
    if (!f.answer) warnings.push(`FAQ "${f.title}" 에 답변이 없습니다 — 골라도 보낼 말이 없어 모를 때 문구로 답합니다`);
  }
  for (const fl of flows) {
    if (!fl.steps.length) warnings.push(`시나리오 "${fl.name}" 에 단계가 없습니다`);
    const stepIds = new Set(fl.steps.map((st) => st.id));
    for (const st of fl.steps) {
      if (st.options.length < 2) warnings.push(`"${fl.name}" 의 "${st.ask.slice(0, 20)}…" 단계에 선택지가 2개 미만입니다`);
      for (const o of st.options) {
        if (o.next && o.next !== 'done' && !stepIds.has(o.next)) {
          warnings.push(`"${fl.name}" 선택지 "${o.label}" 의 다음 단계 "${o.next}" 가 없어 순서대로 진행합니다`);
          o.next = '';
        }
      }
    }
  }
  const intents = faqs.filter((f) => f.enabled).length + flows.filter((f) => f.enabled).length;
  if (intents > MAX_INTENTS) warnings.push(`사용 중인 FAQ+시나리오가 ${intents}개 — Jev 한 질문의 선택지 상한(255)에 가깝습니다. 카테고리로 나누세요`);

  const h = r.handoff || {};
  const handoff = {
    keywords: list(h.keywords, 20, 30),
    message: str(h.message, LIMIT.medium) || '상담원에게 연결해 드릴게요. 잠시만 기다려 주세요.',
    errorMessage: str(h.errorMessage, LIMIT.medium),
  };

  return { rules: { version: 1, settings, persona, faqs, flows, handoff }, warnings };
}

let cache = null;

export function loadRules() {
  if (cache) return cache;
  let source = config.botFile;
  if (!fs.existsSync(config.botFile)) {
    source = config.botDemoFile;
    console.log(`  · 규칙 파일이 없어 데모 규칙으로 시작합니다 → 저장하면 ${path.relative(config.root, config.botFile)} 가 생깁니다`);
  }
  try {
    cache = normalize(JSON.parse(fs.readFileSync(source, 'utf8'))).rules;
  } catch (err) {
    console.warn(`  ! 규칙 파일(${source})을 읽지 못해 빈 규칙으로 시작합니다: ${err.message}`);
    cache = normalize({}).rules;
  }
  return cache;
}

export function saveRules(input) {
  const { rules, warnings } = normalize(input);
  fs.mkdirSync(path.dirname(config.botFile), { recursive: true });
  // 임시 파일에 쓰고 rename — 쓰는 도중 죽어도 규칙 파일이 반쯤 깨지지 않는다.
  const tmp = `${config.botFile}.${process.pid}.writing`;
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, config.botFile);
  cache = rules;
  return { rules, warnings };
}

export function resetToDemo() {
  const demo = JSON.parse(fs.readFileSync(config.botDemoFile, 'utf8'));
  return saveRules(demo);
}
