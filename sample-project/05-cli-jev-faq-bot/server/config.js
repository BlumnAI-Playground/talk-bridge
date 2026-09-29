import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * .env 를 아주 얕게 읽는다(의존성 0 원칙).
 * KEY=VALUE 한 줄씩. 따옴표는 벗기고, #으로 시작하는 줄은 주석.
 */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadDotEnv();

/**
 * 시뮬레이터·평가(`npm run sim` · `npm run eval`)는 카카오에 붙지 않으므로 TB_BRAND·TB_WEBHOOK_SECRET 없이도 돌게 한다.
 * 서버(`npm start`)는 JEV_OFFLINE_OK 를 켜지 않으므로 필수값이 없으면 바로 멈춘다.
 */
function required(name) {
  const v = process.env[name];
  if (!v) {
    if (process.env.JEV_OFFLINE_OK === '1') return '';
    console.error(`[config] 필수 환경변수 ${name} 가 없습니다. .env.example 을 복사해 .env 를 만드세요.`);
    process.exit(1);
  }
  return v;
}

/**
 * ── 05: Jev(TypeSafe) 키 찾기 ─────────────────────────────────────────────
 *
 * 키는 코드·.env.example·저장소에 절대 넣지 않는다. 찾는 순서:
 *   1) TYPESAFE_API_KEY 환경변수 (공식 SDK 와 같은 이름 · 운영·CI 권장)
 *   2) JEV_KEY_FILE 로 지정한 JSON 파일
 *   3) <샘플>/.secret/jev.json
 *   4) <저장소 루트>/.secret/jev.json  (이 저장소를 통째로 받은 경우의 편의 경로)
 *
 * JSON 형식은 `.secret/jev.json.tmp` 템플릿과 같다 — { "api_key": "…" }.
 * `.secret/*.json` 은 .gitignore 로 커밋이 막혀 있고, 키 없는 `*.tmp` 만 커밋된다.
 */
function findJevKey() {
  if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY, source: 'env TYPESAFE_API_KEY' };

  const candidates = [
    process.env.JEV_KEY_FILE,
    path.join(ROOT, '.secret', 'jev.json'),
    path.join(ROOT, '..', '..', '.secret', 'jev.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    const abs = path.resolve(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    try {
      const text = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
      const key = JSON.parse(text).api_key;
      if (key && !/^your /i.test(key)) return { key, source: path.relative(ROOT, abs) || abs };
      return { key: null, source: abs, error: `${abs} 의 api_key 가 비어 있거나 템플릿 값입니다` };
    } catch (err) {
      return { key: null, source: abs, error: `${abs} 를 읽지 못했습니다: ${err.message}` };
    }
  }
  return { key: null, source: null, error: 'Jev 키가 없습니다 — .secret/jev.json.tmp 를 복사해 .secret/jev.json 을 만들거나 TYPESAFE_API_KEY 를 지정하세요' };
}

const jevKey = findJevKey();

/** 키를 로그·화면에 보여줄 때는 앞 7자·뒤 4자만 */
export function maskKey(key) {
  if (!key) return null;
  return key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '***';
}

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),

  /** 상담 대상 브랜드(채널) 키 — `talkbridge-dev whoami` 의 브랜드 값 */
  brand: required('TB_BRAND'),

  /** 실행할 CLI 이름. dev: talkbridge-dev / prod: talkbridge */
  cli: process.env.TB_CLI || 'talkbridge-dev',

  /**
   * 게이트웨이 Webhook sink 의 HMAC 서명 시크릿.
   * `talkbridge-dev setup --webhook-secret <이 값>` 과 반드시 동일해야 한다.
   */
  webhookSecret: required('TB_WEBHOOK_SECRET'),

  // 01=8787 · 02=8788 · 03=8789 · (8790·8791 은 CLI 지식 조회 API·웹뷰) · 04=8792 → 05=8793
  port: Number(process.env.PORT || 8793),
  host: process.env.HOST || '127.0.0.1',

  /** 서명 타임스탬프 허용 오차(초). 리플레이 방어. 0 이면 검사 안 함 */
  toleranceSec: Number(process.env.TB_SIGNATURE_TOLERANCE_SEC || 300),

  /** 상담방 하나당 메모리에 유지할 최대 메시지 수 */
  maxMessagesPerRoom: Number(process.env.TB_MAX_MESSAGES || 200),

  /* ── 05: Jev (TypeSafe System One) ──────────────────────────────────── */
  jev: {
    apiKey: jevKey.key,
    keySource: jevKey.source,
    keyError: jevKey.error || null,
    baseUrl: (process.env.JEV_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    model: process.env.JEV_MODEL || 'jev-latest',
    /** 공식 SDK 기본값과 같게 — 10초 · 재시도 2회 · 500ms→5s 백오프 */
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 10000),
    maxRetries: Number(process.env.JEV_MAX_RETRIES ?? 2),
  },

  /** 웹에서 편집하는 규칙 파일 (없으면 data/demo-bot.json 을 복사해 만든다 · 커밋 제외) */
  botFile: path.resolve(ROOT, process.env.TB_BOT_FILE || 'data/bot.json'),
  botDemoFile: path.join(ROOT, 'data', 'demo-bot.json'),

  /**
   * 이 초보다 오래된 고객 메시지에는 자동응답하지 않는다.
   * 게이트웨이 첫 기동·재기동은 저널을 재생하므로, 이 가드가 없으면 과거 문의 전체에 답장이 나간다.
   */
  replyMaxAgeSec: Number(process.env.TB_BOT_MAX_AGE_SEC || 180),

  /** 고객이 끊어서 여러 줄을 보낼 때 모아서 한 번에 답하려고 기다리는 시간(ms) — Jev 가 빨라 04 보다 짧게 */
  debounceMs: Number(process.env.TB_BOT_DEBOUNCE_MS || 1500),
};

export const webhookPath = '/webhook';
