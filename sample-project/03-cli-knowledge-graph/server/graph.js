import { config } from './config.js';
import { runJson } from './cli.js';

/**
 * ── 상담지식 그래프 조회 — 미리 만들어진 Cypher 프리셋 + 스냅샷 캐시 ────────────
 *
 * 실측으로 확정한 그래프 스키마 (talkbridge-dev v1.1.0, LadybugDB v0.18.0):
 *
 *   (:Customer {id=userKey, brand, name, phone, memo})
 *       -[:ASKED]-> (:Inquiry {id="<convId>#<turn>", text, ts, loadedAt})
 *       -[:ANSWERED]-> (:Response {id, text, byAgent, ts, loadedAt})
 *   (:Inquiry) -[:MENTIONS {confidence}]-> (:Entity {name, kind})   ← Inquiry 에서만. 원래 LLM 이 채우는 자리(이 샘플은 데모 데이터로 채움)
 *
 * CLI v1.1.0 에서 조회는 단순해졌다:
 *
 *  1) 게이트웨이가 떠 있어도 조회된다 — 게이트웨이가 그래프 DB 를 쥔 채 로컬 조회 API(127.0.0.1:8790)를 열고,
 *     `knowledge search --cypher` 는 그것을 자동 경유한다. 서버가 게이트웨이를 멈췄다 켤 일이 없다.
 *     (v1.0.0 은 잠금 때문에 "조회 창(gateway stop → 조회 → start)" 이 필요했다 — cli-feat/CF-001)
 *  2) `--json` 으로 `{columns, types, rows}` 를 받는다 — 여러 컬럼을 그대로 RETURN 하면 된다.
 *     (v1.0.0 은 첫 컬럼만 찍어 '\t' 로 이어 붙여야 했다 — cli-feat/CF-007)
 *
 * 쓰기는 절대 하지 않는다. `search --cypher` 는 CLI 가 읽기전용(MATCH/RETURN)을 강제하고,
 * `knowledge query` 도 기본 읽기전용이지만(`--write` 명시 필요) 이 서버는 부르지 않는다.
 */

const str = (expr) => `cast(${expr} AS STRING)`;
const opt = (expr) => `coalesce(${expr}, '')`;

/**
 * 프리셋 목록. `params` 가 없는 것은 "새로고침" 한 번에 모두 실행되어 스냅샷에 들어간다.
 * `params` 가 있는 것은 요청 때마다 실행된다.
 */
export const PRESETS = [
  {
    id: 'stats',
    title: '노드 수 (라벨별)',
    description: '그래프에 무엇이 몇 개 있나',
    columns: ['라벨', '노드 수'],
    cypher: `MATCH (n) WITH label(n) AS l, count(*) AS c RETURN l, c ORDER BY l`,
  },
  {
    id: 'edges',
    title: '관계 수 (종류별)',
    description: 'ASKED · ANSWERED · MENTIONS',
    columns: ['관계', '수'],
    cypher: `MATCH ()-[r]->() WITH label(r) AS l, count(*) AS c RETURN l, c ORDER BY l`,
  },
  {
    id: 'customers',
    title: '고객별 문의 수',
    description: 'Customer -[ASKED]-> Inquiry 집계',
    columns: ['고객(userKey)', '이름', '문의 수'],
    cypher: `MATCH (c:Customer) OPTIONAL MATCH (c)-[:ASKED]->(i:Inquiry) WITH c, count(i) AS n RETURN c.id, ${opt('c.name')}, n ORDER BY n DESC`,
  },
  {
    id: 'recent-inquiries',
    title: '최근 문의 20건',
    description: '누가 언제 무엇을 물었나',
    columns: ['고객', '시각(UTC)', '문의'],
    cypher: `MATCH (c:Customer)-[:ASKED]->(i:Inquiry) RETURN c.id, ${str('i.ts')}, i.text ORDER BY i.ts DESC LIMIT 20`,
  },
  {
    id: 'unanswered',
    title: '미응답 문의',
    description: 'ANSWERED 관계가 없는 Inquiry',
    columns: ['고객', '시각(UTC)', '문의'],
    cypher: `MATCH (c:Customer)-[:ASKED]->(i:Inquiry) WHERE NOT EXISTS { MATCH (i)-[:ANSWERED]->(:Response) } RETURN c.id, ${str('i.ts')}, i.text ORDER BY i.ts DESC LIMIT 50`,
  },
  {
    id: 'answered-pairs',
    title: '문의 → 응답 쌍',
    description: '무엇을 물었고 어떻게 답했나 (최근 20)',
    columns: ['고객', '문의', '응답', '상담원 응답'],
    cypher: `MATCH (c:Customer)-[:ASKED]->(i:Inquiry)-[:ANSWERED]->(r:Response) RETURN c.id, i.text, r.text, ${str('r.byAgent')} ORDER BY i.ts DESC LIMIT 20`,
  },
  {
    id: 'entities',
    title: '자주 언급된 단어(엔티티)',
    description: 'MENTIONS → Entity 집계. LLM 엔티티 추출을 켠 회차에서 채워진다',
    columns: ['단어', '종류', '언급 수'],
    cypher: `MATCH ()-[:MENTIONS]->(e:Entity) WITH e, count(*) AS n RETURN e.name, ${opt('e.kind')}, n ORDER BY n DESC LIMIT 30`,
  },
  {
    id: 'customer-timeline',
    title: '고객 타임라인',
    description: '한 고객의 문의와 응답을 시간순으로',
    params: ['userKey'],
    columns: ['시각(UTC)', '문의', '응답', '상담원 응답'],
    cypher: `MATCH (c:Customer {id: '{{userKey}}'})-[:ASKED]->(i:Inquiry) OPTIONAL MATCH (i)-[:ANSWERED]->(r:Response) RETURN ${str('i.ts')}, i.text, ${opt('r.text')}, ${opt(str('r.byAgent'))} ORDER BY i.ts`,
  },
  {
    id: 'inquiry-keyword',
    title: '키워드가 들어간 문의',
    description: 'LLM 없이 본문 부분일치 (CONTAINS)',
    params: ['keyword'],
    columns: ['고객', '시각(UTC)', '문의'],
    cypher: `MATCH (c:Customer)-[:ASKED]->(i:Inquiry) WHERE i.text CONTAINS '{{keyword}}' RETURN c.id, ${str('i.ts')}, i.text ORDER BY i.ts DESC LIMIT 50`,
  },
  {
    id: 'customer-entities',
    title: '고객이 언급한 단어',
    description: '고객의 문의가 MENTIONS 하는 Entity (LLM 회차)',
    params: ['userKey'],
    columns: ['단어', '종류', '언급 수'],
    cypher: `MATCH (c:Customer {id: '{{userKey}}'})-[:ASKED]->(:Inquiry)-[:MENTIONS]->(e:Entity) WITH e, count(*) AS n RETURN e.name, ${opt('e.kind')}, n ORDER BY n DESC LIMIT 30`,
  },
];

/* ── 파라미터 — 문자열 리터럴에 그대로 들어가므로 엄격히 거른다 ───────────── */

const PARAM_RULES = {
  userKey: /^[A-Za-z0-9_:.\-]{1,64}$/,          // 카카오 userKey 형식(영숫자·_·-)
  keyword: /^[^'"\\\n\r]{1,50}$/,                 // 따옴표·역슬래시·개행 금지
};

export function bindParams(preset, params = {}) {
  let cypher = preset.cypher;
  for (const name of preset.params || []) {
    const v = String(params[name] ?? '').trim();
    if (!PARAM_RULES[name].test(v)) throw new Error(`${name} 형식이 올바르지 않습니다`);
    cypher = cypher.split(`{{${name}}}`).join(v);
  }
  return cypher;
}

/** 사용자 Cypher 는 읽기전용만. CLI 도 거부하지만 여기서 먼저 거른다. */
export function assertReadOnly(cypher) {
  const c = String(cypher || '').trim();
  if (!/^MATCH\b/i.test(c)) throw new Error('Cypher 는 MATCH 로 시작해야 합니다');
  if (/\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|COPY|LOAD|INSTALL|CALL|BEGIN|COMMIT)\b/i.test(c)) {
    throw new Error('읽기전용 Cypher 만 허용됩니다 (MATCH … RETURN …)');
  }
  return c;
}

/* ── 실행 ───────────────────────────────────────────────────────────────── */

/**
 * `knowledge search --cypher <c> --json` → { columns, types, rows }
 * 게이트웨이가 떠 있으면 CLI 가 조회 API 를 경유하고, 없으면 DB 파일을 직접 연다 — 호출부는 구분할 필요가 없다.
 * 값은 CLI 가 준 그대로(숫자는 숫자, TIMESTAMP 는 문자열). 화면 표시용으로는 프리셋에서 cast 해 둔다.
 */
export async function runCypher(cypher) {
  const d = await runJson(['knowledge', 'search', '--cypher', cypher], { timeoutMs: config.knowledgeTimeoutMs });
  return {
    columns: Array.isArray(d.columns) ? d.columns : [],
    types: Array.isArray(d.types) ? d.types : [],
    rows: Array.isArray(d.rows) ? d.rows : [],
  };
}

/* ── 스냅샷 — 파라미터 없는 프리셋을 모두 실행해 캐시 ─────────────────────── */

let snapshot = { at: null, ms: 0, results: {}, errors: {} };
let refreshing = null;

export function getSnapshot() {
  return snapshot;
}

/** 동시에 여러 번 눌려도 한 번만 돈다. */
export function refreshSnapshot() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t0 = Date.now();
    const results = {};
    const errors = {};
    for (const p of PRESETS.filter((x) => !x.params)) {
      try {
        results[p.id] = (await runCypher(p.cypher)).rows;
      } catch (err) {
        errors[p.id] = err.message;
      }
    }
    snapshot = { at: new Date().toISOString(), ms: Date.now() - t0, results, errors };
    return snapshot;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** 파라미터 프리셋을 즉시 실행한다. */
export async function runPreset(id, params) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`알 수 없는 프리셋: ${id}`);
  const cypher = bindParams(preset, params);
  const r = await runCypher(cypher);
  return { preset, cypher, columns: preset.columns, rows: r.rows };
}

/** 사용자 Cypher — 컬럼명은 CLI 가 돌려준 것을 그대로 쓴다. */
export async function runCustomCypher(cypher) {
  const c = assertReadOnly(cypher);
  const r = await runCypher(c);
  return { cypher: c, columns: r.columns, types: r.types, rows: r.rows };
}
