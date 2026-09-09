#!/usr/bin/env node
/**
 * 게이트웨이 헬퍼 — sink 구성과 데몬 수명주기를 한 곳에서 다룬다.
 *
 *   node scripts/gateway.mjs setup    webhook sink 를 이 샘플 서버로 향하게 구성
 *   node scripts/gateway.mjs start    데몬 기동
 *   node scripts/gateway.mjs status   생존 확인
 *   node scripts/gateway.mjs stop     종료
 *
 * setup 은 `talkbridge-dev setup --webhook-url ... --webhook-secret ...` 을 부른다.
 * 여기서 쓰는 시크릿과 서버의 TB_WEBHOOK_SECRET 이 같아야 서명 검증이 통과한다.
 */

import { config } from '../server/config.js';
import { runCli, launcherInfo } from '../server/cli.js';

const cmd = process.argv[2];
const webhookUrl = process.env.TB_WEBHOOK_URL || `http://${config.host}:${config.port}/webhook`;

async function run(args, label) {
  console.log(`\n$ ${config.cli} ${args.join(' ').replace(config.webhookSecret, '***')}`);
  const r = await runCli(args, { timeoutMs: 30000 });
  process.stdout.write(r.stdout);
  if (r.stderr.trim()) process.stderr.write(r.stderr);
  if (r.code !== 0) {
    console.error(`\n✗ ${label} 실패 (exit ${r.code})`);
    process.exit(r.code || 1);
  }
  return r;
}

switch (cmd) {
  case 'setup': {
    const L = launcherInfo();
    console.log(`CLI: ${config.cli} (${L.mode}: ${L.target})`);
    console.log(`브랜드: ${config.brand}`);
    console.log(`Webhook sink → ${webhookUrl}`);

    await run([
      'setup',
      '--webhook-url', webhookUrl,
      '--webhook-secret', config.webhookSecret,
      '--webhook-brand', config.brand,
      '--webhook-console',
    ], 'sink 구성');

    console.log('\n✓ sink 구성 완료 — 다음: npm run gateway:start');
    break;
  }

  case 'start':
    await run(['gateway', 'start'], '게이트웨이 기동');
    console.log('\n✓ 기동됨. 로그: ~/.bridge-agent/gateway.log');
    console.log('  주의: 첫 기동 시 저장된 오프셋이 없으면 저널을 처음부터 재생합니다.');
    break;

  case 'stop':
    await run(['gateway', 'stop'], '게이트웨이 종료');
    break;

  case 'restart':
    await run(['gateway', 'restart'], '게이트웨이 재기동');
    break;

  case 'status':
    await run(['gateway', 'status'], '상태 조회');
    break;

  default:
    console.error('사용법: node scripts/gateway.mjs <setup|start|stop|restart|status>');
    process.exit(1);
}
