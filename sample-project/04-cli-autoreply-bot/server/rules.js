import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { REASONING_EFFORTS } from './openai.js';

/**
 * ── 자동응대 규칙 저장소 ──────────────────────────────────────────────────
 *
 * 웹 화면에서 편집한 규칙을 JSON 파일 하나(data/bot.json)에 저장한다.
 * 파일이 없으면 데모 규칙(data/demo-bot.json — 톡브릿지 파트너 문의 3종)을 복사해 시작한다.
 *
 * 규칙 모델 (간단 시나리오):
 *
 *   settings   봇 켜기/끄기 · 실발신 여부 · 모델 · 추론 강도 · 답변 길이 · 맥락 길이
 *   persona    봇 이름 · 말투 · 기본 지침
 *   knowledge  공통 대응 지식 [{ id, title, content }]  ← 모든 답변의 근거
 *   scenarios  [{ id, name, enabled, when, keywords[], steps[{ id, instruction, collect }], knowledge, onComplete }]
 *              when       어떤 문의일 때 이 시나리오인가 (모델이 의도 판별에 쓴다)
 *              keywords   빠른 후보 힌트 (포함되면 모델에게 "후보" 로 알려준다 — 확정은 모델이 맥락으로)
 *              steps      순서대로 진행하는 플로우. collect 는 이 단계에서 받아낼 정보 이름(선택)
 *              onComplete 마지막 단계 후: stay(계속 대화) · handoff(상담원 연결) · end(상담 종료+봇 전환)
 *   handoff    상담원 연결 키워드 · 연결 안내 문구 · AI 오류 시 안내 문구
 *
 * 운영에서는 이 파일 대신 DB·관리자 권한·변경 이력을 두면 된다(README §7).
 */

export const ON_COMPLETE = ['stay', 'handoff', 'end'];

const LIMIT = { short: 80, medium: 400, long: 4000, list: 30, keywords: 20 };

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function slug(v, fallback) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

function uniqueIds(items, prefix) {
  const seen = new Set();
  return items.map((it, i) => {
    let id = slug(it.id, `${prefix}${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...it, id };
  });
}

/**
 * 화면에서 온 규칙을 정규화한다. 모르는 필드는 버리고, 길이를 자르고, id 를 유일하게 만든다.
 * 잘못된 입력에 throw 하기보다 "고쳐서 저장 + 무엇을 고쳤는지" 를 돌려주는 편이 편집 UX 에 맞다.
 */
export function normalize(input) {
  const warnings = [];
  const r = input && typeof input === 'object' ? input : {};
  const s = r.settings || {};

  const effort = s.reasoningEffort == null ? '' : String(s.reasoningEffort);
  if (effort && !REASONING_EFFORTS.includes(effort)) warnings.push(`추론 강도 "${effort}" 는 지원 값이 아니라 기본값으로 둡니다`);

  const settings = {
    enabled: s.enabled !== false,
    live: s.live === true,
    model: str(s.model, LIMIT.short),
    reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : '',
    maxReplyChars: Math.min(1000, Math.max(80, Number(s.maxReplyChars) || 400)),
    historyLimit: Math.min(60, Math.max(4, Number(s.historyLimit) || 30)),
  };

  const p = r.persona || {};
  const persona = {
    name: str(p.name, LIMIT.short) || '자동응대봇',
    tone: str(p.tone, LIMIT.medium),
    instructions: str(p.instructions, LIMIT.long),
  };

  const knowledge = uniqueIds(
    (Array.isArray(r.knowledge) ? r.knowledge : []).slice(0, LIMIT.list)
      .map((k) => ({ id: k?.id, title: str(k?.title, LIMIT.short), content: str(k?.content, LIMIT.long) }))
      .filter((k) => k.title || k.content),
    'k',
  );

  const scenarios = uniqueIds(
    (Array.isArray(r.scenarios) ? r.scenarios : []).slice(0, LIMIT.list).map((sc) => ({
      id: sc?.id || sc?.name,
      name: str(sc?.name, LIMIT.short) || '이름 없는 시나리오',
      enabled: sc?.enabled !== false,
      when: str(sc?.when, LIMIT.medium),
      keywords: [...new Set((Array.isArray(sc?.keywords) ? sc.keywords : String(sc?.keywords ?? '').split(','))
        .map((k) => str(k, 30)).filter(Boolean))].slice(0, LIMIT.keywords),
      steps: uniqueIds(
        (Array.isArray(sc?.steps) ? sc.steps : []).slice(0, 12)
          .map((st) => ({ id: st?.id, instruction: str(st?.instruction, LIMIT.medium), collect: str(st?.collect, 40) }))
          .filter((st) => st.instruction),
        'step',
      ),
      knowledge: str(sc?.knowledge, LIMIT.long),
      onComplete: ON_COMPLETE.includes(sc?.onComplete) ? sc.onComplete : 'stay',
    })),
    'scenario',
  );
  for (const sc of scenarios) {
    if (!sc.when && !sc.keywords.length) warnings.push(`"${sc.name}" 에 "언제" 설명과 키워드가 모두 없어 선택되기 어렵습니다`);
    if (!sc.steps.length) warnings.push(`"${sc.name}" 에 플로우 단계가 없습니다 — 지식으로만 답합니다`);
  }

  const h = r.handoff || {};
  const handoff = {
    keywords: [...new Set((Array.isArray(h.keywords) ? h.keywords : String(h.keywords ?? '').split(','))
      .map((k) => str(k, 30)).filter(Boolean))].slice(0, LIMIT.keywords),
    message: str(h.message, LIMIT.medium) || '상담원에게 연결해 드릴게요. 잠시만 기다려 주세요.',
    errorMessage: str(h.errorMessage, LIMIT.medium),
  };

  return { rules: { version: 1, settings, persona, knowledge, scenarios, handoff }, warnings };
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

/** 실제로 쓰일 모델·추론 강도 (규칙 설정 → .env 기본값) */
export function effectiveModel(rules = loadRules()) {
  return {
    model: rules.settings.model || config.openai.model,
    effort: rules.settings.reasoningEffort || config.openai.reasoningEffort,
  };
}
