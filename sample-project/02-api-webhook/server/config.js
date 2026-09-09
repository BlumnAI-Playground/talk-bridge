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

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] 필수 환경변수 ${name} 가 없습니다. .env.example 을 복사해 .env 를 만드세요.`);
    process.exit(1);
  }
  return v;
}

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),

  /** 상담 대상 브랜드(채널) 키 — 모든 REST 호출의 brandKey */
  brand: required('TB_BRAND'),

  /**
   * REST 베이스. 실환경 https://api.talkbridge.io
   * 개발환경을 제공받았다면 TB_API_BASE 로 바꾼다.
   */
  apiBase: (process.env.TB_API_BASE || 'https://api.talkbridge.io').replace(/\/+$/, ''),

  /** Agent API 키 (blumnb-). Authorization: Bearer 로 보낸다 */
  apiKey: required('TB_API_KEY'),

  /**
   * 호스티드 게이트웨이 웹훅 서명 시크릿 (whsec_).
   * 센터 "상담 받을 곳 연결 → Webhook" 의 값과 반드시 동일해야 한다.
   */
  webhookSecret: required('TB_WEBHOOK_SECRET'),

  /** 센터에 등록한 내 수신 URL — 표시·진단용 (서버 동작에는 영향 없음) */
  publicUrl: process.env.TB_PUBLIC_URL || '',

  port: Number(process.env.PORT || 8788),
  host: process.env.HOST || '127.0.0.1',

  /** 서명 타임스탬프 허용 오차(초). 리플레이 방어. 0 이면 검사 안 함 */
  toleranceSec: Number(process.env.TB_SIGNATURE_TOLERANCE_SEC || 300),

  /** 상담방 하나당 메모리에 유지할 최대 메시지 수 */
  maxMessagesPerRoom: Number(process.env.TB_MAX_MESSAGES || 200),

  /** REST 호출 타임아웃(ms) */
  apiTimeoutMs: Number(process.env.TB_API_TIMEOUT_MS || 15000),
};

export const webhookPath = '/webhook';
