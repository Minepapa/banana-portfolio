#!/usr/bin/env node
/**
 * IRP 잔고 증가 추정 체결 소급 — reconcile-irp 로그에서 지난 잔고 관측을 되살려, 잡과 같은 규칙
 * (scripts/lib/irp-balance-delta.mjs — 불변식 그 헤더 참고)으로 날짜별 순증가 중 원장에 없는 것만 보여 준다.
 *
 * 기본은 미리보기(쓰기 없음). --apply는 제우스가 오너 승인을 받은 뒤에만 쓴다 — 원장(Facts/Ledger/
 * Executions)에 추정 체결 파일을 만든다(보유는 건드리지 않음). 증권사 API를 부르지 않는다.
 *
 * 로그에는 매입금액·종목코드가 없어 단가는 평단가×수량 변화로, 원장 대조는 종목명으로 한다.
 * 로그는 하루 한 번(16:07) 실행분이 대부분이라 시각은 그날 처음 증가를 본 실행 시각이다.
 *
 * 사용:
 *   node scripts/tools/irp-balance-delta-backfill.mjs                       # 미리보기(기본 로그)
 *   node scripts/tools/irp-balance-delta-backfill.mjs --from=2026-11-01     # 이 날짜부터만
 *   node scripts/tools/irp-balance-delta-backfill.mjs --log=/path/a.log --log=/path/b.log
 *   node scripts/tools/irp-balance-delta-backfill.mjs --from=… --apply      # 오너 승인 뒤 제우스만
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IRP_ACCOUNT_NO } from '../lib/account-resolver.mjs';
import { parseReconcileIrpLog, settlesFromObservations, planIrpBalanceDeltaExecutions, ledgerDatesForSettle } from '../lib/irp-balance-delta.mjs';
import { buildExecutionRecord, readExecutionsOnDates } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FROM = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? '';
const logArgs = args.filter((a) => a.startsWith('--log=')).map((a) => a.slice('--log='.length));
const LOGS = logArgs.length ? logArgs : [join(homedir(), 'Library', 'Logs', 'banana-portfolio-v2', 'reconcile-irp.log')];

function main() {
  const observations = LOGS.filter((path) => existsSync(path))
    .flatMap((path) => parseReconcileIrpLog(readFileSync(path, 'utf8')))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (!observations.length) { console.log(`ℹ️ 잔고 관측 없음 — 로그: ${LOGS.join(', ')}`); return; }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const settles = settlesFromObservations(observations, { through: today }).filter((settle) => settle.day >= FROM);
  console.log(`🔎 관측 ${observations.length}회 · 정산 ${settles.length}일${FROM ? `(${FROM}부터)` : ''}${APPLY ? '' : ' — 미리보기(쓰기 없음)'}`);
  let planned = 0, written = 0;
  for (const settle of settles) {
    const { records, recognized, warnings } = planIrpBalanceDeltaExecutions({ ...settle, ledgerExecutions: readExecutionsOnDates(ledgerDatesForSettle(settle)) });
    for (const item of recognized) console.log(`  · ${item.day} ${item.name} ${item.quantity}주 — 원장에 이미 있음(${item.sources.join(',')})`);
    for (const warning of warnings) console.log(`  ⚠️ ${warning}`);
    for (const input of records) {
      planned++;
      const { filename, content, dir } = buildExecutionRecord({ ...input, acctNo: IRP_ACCOUNT_NO });
      const filepath = join(dir, filename);
      const exists = existsSync(filepath);
      console.log(`  + ${input.tradeDate} ${input.stockName} ${input.quantity}주 @${input.price}원(추정)${exists ? ' — 같은 파일 있음, 건너뜀' : ''} — ${filename}`);
      if (APPLY && !exists) {
        mkdirSync(dir, { recursive: true });
        writeAtomic(filepath, content);
        written++;
      }
    }
  }
  console.log(`\n✅ 추정 기록 대상 ${planned}건${APPLY ? ` · 기록 ${written}건` : ' (미리보기 — --apply로 기록, 오너 승인 뒤에만)'}`);
}

main();
