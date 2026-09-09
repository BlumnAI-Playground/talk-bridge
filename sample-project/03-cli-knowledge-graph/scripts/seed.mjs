#!/usr/bin/env node
/**
 * 데모 데이터셋 적재/제거 — data/demo-dataset.json 을 CLI 의 상담지식 그래프에 넣는다.
 *
 *   node scripts/seed.mjs seed      적재 (재실행해도 중복되지 않음 — MERGE)
 *   node scripts/seed.mjs unseed    'demo' 로 시작하는 노드와, 남는 참조가 없는 데모 엔티티 제거
 *   node scripts/seed.mjs count     라벨별 노드 수
 *
 * 시나리오: 톡브릿지 상담센터에 파트너 개발자들이 CLI·API 연동을 문의하는 상황.
 * 실데이터와 섞여도 id 가 'demo' 로 시작해 구분되고, unseed 로 통째로 제거된다.
 *
 * ⚠️ 이 스크립트만 `knowledge query --write` 를 쓴다(CLI v1.1.0: `--write` 없이는 쓰기가 거부된다).
 *    서버·화면은 읽기전용 `knowledge search --cypher` 만 쓴다.
 *    쓰기는 게이트웨이가 DB 를 쥔 동안 거부되므로 쓰기 창(write-window.mjs) 안에서 실행한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { runCli, runJson } from '../server/cli.js';
import { withGatewayStopped } from './write-window.mjs';

const cmd = process.argv[2];
const file = path.join(config.root, 'data', 'demo-dataset.json');
const ds = JSON.parse(fs.readFileSync(file, 'utf8'));

/** Cypher 문자열 리터럴 — 작은따옴표·역슬래시·개행을 이스케이프 */
const lit = (s) => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;

/**
 * 한 호출에 ';' 로 여러 문장을 보낸다. 대화 하나가 한 호출.
 * v1.1.0 은 문장별로 `#n ok` / `#n FAILED: …` 를 찍고, 실패가 있으면 종료 코드 ≠ 0 (기본 --stop-on-error).
 */
async function exec(statements, label) {
  const r = await runCli(['knowledge', 'query', '--write', statements.join(';\n')], { timeoutMs: 120000 });
  const out = (r.stdout + r.stderr).trim();
  if (r.code !== 0 || /FAILED|오류|exception/i.test(out)) {
    throw new Error(`${label}: ${out.slice(0, 600)}`);
  }
  return out;
}

function customerStatements() {
  return ds.customers.map((c) =>
    `MERGE (c:Customer {id: ${lit(c.id)}}) ON CREATE SET c.brand = ${lit(ds.brand)}, c.name = ${lit(c.name)}, c.phone = '', c.memo = ${lit(c.memo)}`);
}

function entityStatements() {
  return ds.entities.map((e) =>
    `MERGE (e:Entity {name: ${lit(e.name)}}) ON CREATE SET e.kind = ${lit(e.kind)}`);
}

function conversationStatements(conv) {
  const st = [];
  let lastInquiry = null;
  conv.turns.forEach((t, i) => {
    const id = `${conv.id}#${i + 1}`;
    if (t.type === 'inquiry') {
      st.push(`MATCH (c:Customer {id: ${lit(conv.customer)}}) MERGE (i:Inquiry {id: ${lit(id)}}) ON CREATE SET i.text = ${lit(t.text)}, i.ts = timestamp(${lit(t.ts)}) MERGE (c)-[:ASKED]->(i)`);
      lastInquiry = id;
    } else {
      if (!lastInquiry) throw new Error(`${conv.id}: 응답 앞에 문의가 없습니다`);
      st.push(`MATCH (i:Inquiry {id: ${lit(lastInquiry)}}) MERGE (r:Response {id: ${lit(id)}}) ON CREATE SET r.text = ${lit(t.text)}, r.byAgent = ${t.byAgent !== false}, r.ts = timestamp(${lit(t.ts)}) MERGE (i)-[:ANSWERED]->(r)`);
    }
    // 스키마상 MENTIONS 는 Inquiry → Entity 만 허용된다(실측: Response 에서 걸면 Binder exception).
    // 응답의 mentions 는 그 응답이 답한 문의에 붙인다 — "이 문의 건에서 오간 단어" 로 해석.
    const owner = t.type === 'inquiry' ? id : lastInquiry;
    for (const [name, confidence] of t.mentions || []) {
      st.push(`MATCH (n:Inquiry {id: ${lit(owner)}}), (e:Entity {name: ${lit(name)}}) MERGE (n)-[m:MENTIONS]->(e) ON CREATE SET m.confidence = ${Number(confidence)}`);
    }
  });
  return st;
}

/** 데이터셋에서 기대되는 수 — 적재 후 실제와 대조한다(회귀 방지) */
function expected() {
  let inquiries = 0, responses = 0;
  const mentionPairs = new Set();
  for (const c of ds.conversations) {
    let last = null;
    c.turns.forEach((t, i) => {
      const id = `${c.id}#${i + 1}`;
      if (t.type === 'inquiry') { inquiries++; last = id; } else responses++;
      for (const [name] of t.mentions || []) mentionPairs.add(`${t.type === 'inquiry' ? id : last}|${name}`);
    });
  }
  return { customers: ds.customers.length, inquiries, responses, mentions: mentionPairs.size };
}

/** 읽기는 게이트웨이가 떠 있어도 된다 — 조회 API 자동 경유 */
async function one(cypher) {
  const d = await runJson(['knowledge', 'search', '--cypher', cypher]);
  return Number(d.rows?.[0]?.[0] ?? 0);
}

async function actual() {
  return {
    customers: await one("MATCH (c:Customer) WHERE c.id STARTS WITH 'demo' RETURN count(c)"),
    inquiries: await one("MATCH (i:Inquiry) WHERE i.id STARTS WITH 'demo' RETURN count(i)"),
    responses: await one("MATCH (r:Response) WHERE r.id STARTS WITH 'demo' RETURN count(r)"),
    mentions: await one("MATCH (i:Inquiry)-[m:MENTIONS]->() WHERE i.id STARTS WITH 'demo' RETURN count(m)"),
  };
}

async function count() {
  const d = await runJson(['knowledge', 'search', '--cypher', 'MATCH (n) WITH label(n) AS l, count(*) AS c RETURN l, c ORDER BY l']);
  return (d.rows || []).map((r) => `${r[0]}\t${r[1]}`).join('\n');
}

async function verify() {
  const exp = expected();
  const act = await actual();
  let bad = false;
  for (const k of Object.keys(exp)) {
    const okk = exp[k] === act[k];
    bad ||= !okk;
    console.log(`  ${okk ? '✓' : '✗'} demo ${k}: 기대 ${exp[k]} / 실제 ${act[k]}`);
  }
  return !bad;
}

switch (cmd) {
  case 'seed': {
    console.log(`데모 데이터셋: 고객 ${ds.customers.length} · 엔티티 ${ds.entities.length} · 대화 ${ds.conversations.length} · 턴 ${ds.conversations.reduce((n, c) => n + c.turns.length, 0)}`);
    await withGatewayStopped(async () => {
      await exec(customerStatements(), '고객');
      await exec(entityStatements(), '엔티티');
      for (const conv of ds.conversations) {
        await exec(conversationStatements(conv), conv.id);
        process.stdout.write('.');
      }
      console.log('');
    });
    console.log((await count()).split('\n').map((l) => '  ' + l).join('\n'));
    if (!(await verify())) {
      console.error('\n✗ 기대 수와 실제 수가 다릅니다. 스키마가 바뀌었을 수 있습니다 — 위 CLI 출력의 "#n FAILED" 문장을 확인하세요.');
      process.exitCode = 1;
    }
    console.log('\n✓ 적재 완료 — npm start 후 그래프 패널에서 새로고침, 또는 실행 중이면 화면의 새로고침');
    break;
  }

  case 'unseed': {
    const names = ds.entities.map((e) => lit(e.name)).join(', ');
    await withGatewayStopped(async () => {
      await exec([
        "MATCH (r:Response) WHERE r.id STARTS WITH 'demo' DETACH DELETE r",
        "MATCH (i:Inquiry) WHERE i.id STARTS WITH 'demo' DETACH DELETE i",
        "MATCH (c:Customer) WHERE c.id STARTS WITH 'demo' DETACH DELETE c",
        `MATCH (e:Entity) WHERE e.name IN [${names}] AND NOT EXISTS { MATCH ()-[:MENTIONS]->(e) } DELETE e`,
      ], '제거');
    });
    console.log((await count()).split('\n').map((l) => '  ' + l).join('\n'));
    console.log('\n✓ 데모 데이터 제거 완료');
    break;
  }

  case 'count':
    console.log(await count());
    break;

  default:
    console.error('사용법: node scripts/seed.mjs <seed|unseed|count>');
    process.exit(1);
}
