#!/usr/bin/env node
/**
 * 예수금 수동 앵커 기록 — 오너가 앱에서 직접 확인한 잔고를 CashEvent로 즉시 기록.
 *
 * 왜(2026-09-03 신설): 연금저축은 API도 카카오 자동알림도 없는 유일한 계좌라
 * (Strategy 문서·update-cash-from-ledger.mjs 헤더 참고), 매월 급여 연동 자동입금
 * (알림 없음) 등으로 기준점+델타 계산이 실제 잔고와 어긋나면 오너가 앱에서 확인한
 * 값을 수동으로 넣어줘야만 최신화된다. 지금까지는 이 작업을 매번 즉석 스크립트로
 * 처리했는데(재사용 가능한 도구가 없었음), 텔레그램 세션이 이 임시 작업을 시도하다
 * "구현 금지" 가드에 걸린 사고(2026-09-03)를 계기로 재사용 가능한 CLI로 분리한다 —
 * 이제 텔레그램 세션도 "이미 있는 운영 스크립트 실행"으로 안전하게 돌릴 수 있다
 * (CLAUDE.md "텔레그램 세션 구현 금지" 규칙은 새 코드 작성만 막지, 기존 스크립트
 * 실행은 막지 않는다).
 *
 * account는 실제로는 거의 항상 연금저축이지만(유일한 수동 계좌), 미래에 다른
 * 계좌의 API 경로가 일시적으로 깨졌을 때도 같은 도구로 수동 보정할 수 있게 특정
 * 계좌명으로 하드코딩하지 않는다 — buildCashEventRecord를 그대로 재사용해
 * update-cash-from-ledger.mjs가 다음 실행에서 이 값을 기준점으로 그대로 읽는다
 * (신규 로직 없음, 기존 예수금앵커 파이프라인 그대로 재사용).
 *
 * 사용법:
 *   node scripts/tools/record-cash-anchor.mjs --account=연금저축 --balance=1079918
 *   node scripts/tools/record-cash-anchor.mjs --account=연금저축 --balance=1079918 --dry-run
 *
 * 기록 직후 실제 반영은 update-cash-from-ledger.mjs가 다음 정기 실행 때(평일 16:10)
 * 자동으로 하거나, 즉시 반영하려면 이어서 `node scripts/jobs/update-cash-from-
 * ledger.mjs`를 직접 돌리면 된다(이 스크립트가 자동으로 호출하진 않는다 — 계산
 * 로직과 원문 기록을 분리하는 이 프로젝트의 기존 원칙, parse-notifications-to-
 * vault.mjs와 동일).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCashEventRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// KST 벽시계 기준 "YYYY-MM-DD HH:MM:SS" — 이 프로젝트 전체가 쓰는 관례(order-
// gate.mjs checkMarketOpen·reconcile-irp.mjs 등과 동일, UTC로 쓰면 9시간 어긋나는
// 실사고가 이미 여러 번 있었음).
function kstNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const DRY_RUN = process.argv.includes('--dry-run');

  const account = args.account?.trim();
  const balance = Number(args.balance);
  // 계좌명 오타로 엉뚱한 계좌를 덮어쓰는 걸 막기 위해 화이트리스트를 두지 않는다
  // (일부러) — 대신 balance 자체를 엄격히 검증해 "0으로 추정" 같은 사고를 막는다.
  if (!account) { console.error('❌ --account=계좌명 필요(예: --account=연금저축)'); process.exit(2); }
  if (!Number.isFinite(balance) || balance < 0) { console.error('❌ --balance=잔고(0 이상 숫자) 필요'); process.exit(2); }

  const ts = kstNow();
  const { filename, content, dir } = buildCashEventRecord({ account, balance, ts });
  const filepath = join(dir, filename);

  console.log(`  + [예수금앵커·수동] ${ts} ${account} 잔고 ${balance.toLocaleString()}원 — ${filepath}`);
  if (!DRY_RUN) {
    mkdirSync(dir, { recursive: true });
    writeAtomic(filepath, content);
    console.log('\n✅ 기록 완료 — 실제 계산 반영은 update-cash-from-ledger.mjs 다음 실행(평일 16:10) 때 자동 적용됩니다.');
    console.log('   즉시 반영하려면: node scripts/jobs/update-cash-from-ledger.mjs');
  } else {
    console.log('\n✅ 드라이런 — 쓰기 없음');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
