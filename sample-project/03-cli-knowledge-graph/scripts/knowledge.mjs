#!/usr/bin/env node
/**
 * 상담지식 그래프 헬퍼 — CLI `knowledge` 를 이 샘플의 설정(브랜드·뷰 포트)으로 감싼다.
 *
 *   node scripts/knowledge.mjs status     설치·설정·그래프 통계 (게이트웨이가 떠 있으면 조회 API 경유 — 잠금 없음)
 *   node scripts/knowledge.mjs install    LadybugDB lib 설치 + 온톨로지 활성 + 스키마 생성 (AI 불필요)
 *   node scripts/knowledge.mjs build      과거 상담을 그래프에 적재 — 쓰기이므로 게이트웨이를 잠시 멈춘다
 *   node scripts/knowledge.mjs view       로컬 그래프 웹뷰 — 게이트웨이가 떠 있어도 그래프가 보인다
 *   node scripts/knowledge.mjs view-stop  웹뷰 종료
 *
 * 데모 데이터는 scripts/seed.mjs (npm run demo:seed / demo:unseed).
 * 그래프 DB 는 CLI 가 관리한다 (~/.bridge-agent/knowledge.lbug). 이 샘플의 서버는 읽기만 한다.
 */

import { config } from '../server/config.js';
import { runCli, launcherInfo } from '../server/cli.js';
import { withGatewayStopped } from './write-window.mjs';

const cmd = process.argv[2];

async function run(args, label, timeoutMs = 60000) {
  console.log(`\n$ ${config.cli} ${args.join(' ')}`);
  const r = await runCli(args, { timeoutMs });
  process.stdout.write(r.stdout);
  if (r.stderr.trim()) process.stderr.write(r.stderr);
  if (r.code !== 0) {
    console.error(`\n✗ ${label} 실패 (exit ${r.code})`);
    process.exit(r.code || 1);
  }
  return r;
}

switch (cmd) {
  case 'status':
    await run(['knowledge', 'status'], '상태 조회');
    break;

  case 'install': {
    const L = launcherInfo();
    console.log(`CLI: ${config.cli} (${L.mode}: ${L.target})`);
    await run(['knowledge', 'install'], '온톨로지 설치', 10 * 60 * 1000);
    console.log('\n✓ 설치 완료 — 다음: npm run demo:seed (데모 데이터) 또는 npm run knowledge:build (과거 상담)');
    console.log('  게이트웨이가 이미 떠 있으면 npm run gateway:stop && npm run gateway:start 로 온톨로지 sink 를 활성화하세요');
    break;
  }

  case 'build':
    console.log(`브랜드: ${config.brand}`);
    console.log('과거 상담을 그래프에 적재합니다. AI 가 미설정이면 Entity/MENTIONS 는 생략되고 고객→문의→응답만 적재됩니다.');
    await withGatewayStopped(() => run(['knowledge', 'build', '--brand', config.brand], '그래프 적재', 60 * 60 * 1000));
    console.log('\n✓ 적재 완료 — 화면의 "새로고침" 으로 스냅샷을 갱신하세요');
    break;

  case 'view':
    await run(['knowledge', 'view', '--port', String(config.knowledgeViewPort)], '그래프 뷰 시작');
    console.log(`\n✓ 그래프 뷰 → http://127.0.0.1:${config.knowledgeViewPort}/  (localhost 도 됩니다)`);
    break;

  case 'view-stop':
    await run(['knowledge', 'view', 'stop', '--port', String(config.knowledgeViewPort)], '그래프 뷰 종료');
    break;

  default:
    console.error('사용법: node scripts/knowledge.mjs <status|install|build|view|view-stop>');
    process.exit(1);
}
