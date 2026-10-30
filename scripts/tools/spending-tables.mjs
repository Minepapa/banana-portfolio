#!/usr/bin/env node
// 소비 보고 1단계 후보 보기(읽기 전용): 카드 표·가맹점 항목·고정비 후보를 출력한다. 오너 확인용이며 볼트에 쓰지 않는다.
// 사용: node scripts/tools/spending-tables.mjs [--json]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildMerchantIndex, cardCandidates, categoryFor, fixedCostCandidates, readBanksaladTransactions } from '../lib/spending-tables.mjs';

// 일별 요약(`{YYYY}/{date}.summary.json`)의 지출 건을 모두 읽는다.
export function readAlertEntries(spendingDir) {
  const entries = [];
  if (!existsSync(spendingDir)) return entries;
  for (const year of readdirSync(spendingDir).filter((name) => /^\d{4}$/.test(name))) {
    for (const name of readdirSync(join(spendingDir, year)).filter((file) => file.endsWith('.summary.json')).sort()) {
      entries.push(...(JSON.parse(readFileSync(join(spendingDir, year, name), 'utf8')).entries ?? []));
    }
  }
  return entries;
}

export function buildCandidates(spendingDir) {
  const { folder, transactions } = readBanksaladTransactions(spendingDir);
  const alerts = readAlertEntries(spendingDir);
  const index = buildMerchantIndex(transactions);
  const merchants = [...new Set(alerts.filter((entry) => entry.status === 'expense' && entry.merchant).map((entry) => entry.merchant))].sort();
  return { banksaladFolder: folder, alertExpenses: alerts.filter((entry) => entry.status === 'expense').length,
    cards: cardCandidates(alerts, transactions),
    merchants: merchants.map((merchant) => ({ merchant, ...(categoryFor(merchant, index) ?? { category: null }) })),
    fixed: fixedCostCandidates(transactions) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildCandidates(VAULT_PATHS.spending);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printCandidates(result);
}

function printCandidates(result) {
  console.log(`뱅크샐러드 ${result.banksaladFolder ?? '없음'} · 알림 지출 ${result.alertExpenses}건\n`);
  console.log('■ 카드 표 후보(알림 카드 → 뱅크샐러드 결제수단)');
  for (const card of result.cards) console.log(`- ${card.card} ${card.mask ?? '(번호 없음)'} · 알림 ${card.alerts}건 → ${card.instrument ?? '미정'} ${JSON.stringify(card.votes)}`);
  console.log('\n■ 알림 가맹점 항목');
  for (const item of result.merchants) console.log(`- ${item.merchant} → ${item.category ? `${item.category}/${item.subcategory} (${item.via}, ${item.count}건)` : '미분류'}`);
  console.log('\n■ 고정비 후보(뱅크샐러드)');
  for (const fixed of result.fixed) console.log(`- ${fixed.merchant} · ${fixed.instrument} · ${fixed.months}개월 · 매월 ${fixed.dayFrom}~${fixed.dayTo}일 · ${fixed.amount.toLocaleString('ko-KR')}원(${fixed.amountMin.toLocaleString('ko-KR')}~${fixed.amountMax.toLocaleString('ko-KR')})`);
}
