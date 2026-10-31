// 원문 JSONL은 그대로 두고 날짜별 판정 결과를 다시 계산한다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { parseSpendingRecord, parseSpendingRecords } from './spending-parse.mjs';
import { validateRecipientDecisions } from './spending-settings.mjs';

export function spendingRawPath(date, spendingDir = VAULT_PATHS.spending) {
  return join(spendingDir, date.slice(0, 4), `${date}.jsonl`);
}

export function spendingSummaryPath(date, spendingDir = VAULT_PATHS.spending) {
  return join(spendingDir, date.slice(0, 4), `${date}.summary.json`);
}

// 오너가 확인한 가족 수취처만 recipient로 기록한다. 미확인 송금은 계속 대기다.
// 일일 경로는 송금 판정 칸만 검사한다. 월간 칸(cardMap 등)은 spending-settings 도구와 월 점검이 따로 본다.
export function readSpendingSettings(spendingDir = VAULT_PATHS.spending) {
  const path = join(spendingDir, 'settings.json');
  if (!existsSync(path)) return { recipientDecisions: [] };
  const settings = validateRecipientDecisions(JSON.parse(readFileSync(path, 'utf8')));
  return { ...settings, recipientDecisions: settings.recipientDecisions ?? [] };
}

export function readDailySpending(date, { spendingDir = VAULT_PATHS.spending, ownAccounts = [],
  recipientDecisions } = {}) {
  const path = spendingRawPath(date, spendingDir);
  const hasSource = existsSync(path);
  const records = [];
  let invalidLines = 0;
  if (hasSource) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      try { records.push(JSON.parse(line)); }
      catch { invalidLines += 1; }
    }
  }
  // 원문이 없는 날에는 송금 판정 설정을 적용할 데이터도 없다.
  const decisions = hasSource ? (recipientDecisions ?? readSpendingSettings(spendingDir).recipientDecisions) : [];
  const entries = parseSpendingRecords(records, { ownAccounts, recipientDecisions: decisions });
  const expenses = entries.filter((entry) => entry.status === 'expense');
  // 삼성 승인 문구의 '결제대금에 미포함'은 별도 청구 알림이 아닌 승인 자체의 근거다.
  const isOnnuriBillOmission = (record) => {
    if (!/\*결제대금에 미포함$/.test(record.body ?? '')) return false;
    const approval = parseSpendingRecord(record);
    return approval?.card === '삼성' && approval.category === '온누리상품권';
  };
  const onnuriBillOmissionCount = records.filter(isOnnuriBillOmission).length;
  const billClaims = records.filter((record) => /(?:결제대금|카드값)/.test(`${record.sender ?? ''}${record.body ?? ''}`)
    && !isOnnuriBillOmission(record));
  return {
    date,
    hasSource,
    total: expenses.reduce((sum, entry) => sum + entry.amount, 0),
    expenseCount: expenses.length,
    pendingCount: entries.filter((entry) => entry.status === 'pending').length,
    excludedCount: entries.filter((entry) => entry.status === 'excluded').length,
    invalidLines,
    // 결제대금 청구 알림은 승인과 별개 소비가 아니므로 합계 밖에 둔다.
    billExcludedCount: billClaims.length,
    onnuriBillExcludedCount: billClaims.filter((record) => /온누리/.test(`${record.sender ?? ''}${record.body ?? ''}`)).length,
    onnuriBillOmissionCount,
    byCategory: Object.fromEntries(['일반', '교통비', '온누리상품권', '계좌이체'].map((category) => [category,
      expenses.filter((entry) => entry.category === category).reduce((sum, entry) => sum + entry.amount, 0)])),
    entries: entries.map(({ at, amount, merchant, card, cardLast4, cardMask, status, category,
      recipientBank, recipientLast4, recipient, autopay }) => ({ at, amount, merchant, card, cardLast4, cardMask, status,
      category, recipientBank, recipientLast4, recipient, ...(autopay ? { autopay: true } : {}) })),
  };
}

export function formatTodaySpending(summary) {
  if (!summary.hasSource) return '■ 오늘 지출\n- 오늘 지출 알림 기록 없음';
  const amount = (value) => `${value.toLocaleString('ko-KR')}원`;
  const parts = [`■ 오늘 지출`, `- 확인된 지출 ${amount(summary.total)} (${summary.expenseCount}건)`];
  if (summary.byCategory['교통비']) parts.push(`- 교통비 ${amount(summary.byCategory['교통비'])}`);
  if (summary.byCategory['온누리상품권']) parts.push(`- 온누리상품권 ${amount(summary.byCategory['온누리상품권'])}`);
  if (summary.byCategory['계좌이체']) parts.push(`- 계좌이체 합계 ${amount(summary.byCategory['계좌이체'])}`);
  for (const entry of summary.entries ?? []) {
    if (entry.status !== 'expense') continue;
    const merchant = String(entry.merchant ?? '').replace(/\s+/g, ' ').trim();
    const label = merchant || (entry.category === '계좌이체' ? '계좌이체'
      : entry.category === '온누리상품권' ? '온누리상품권 승인' : '카드 승인');
    // 알림 원문에서 온 상점명은 브리핑의 HTML 본문에 들어가므로 이스케이프한다.
    const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    parts.push(`- ${safeLabel} ${amount(entry.amount)}`);
  }
  for (const entry of summary.entries ?? []) {
    if (entry.status === 'excluded' && ['휘영', '미네'].includes(entry.recipient)) {
      parts.push(`- ${entry.recipient}에게 이체 ${amount(entry.amount)} (지출 합계 제외)`);
    }
  }
  if (summary.pendingCount) parts.push(`- 송금 판정 대기 ${summary.pendingCount}건 (합계 제외)`);
  if (summary.onnuriBillOmissionCount) parts.push(`- 온누리 승인 ${summary.onnuriBillOmissionCount}건: 결제대금에 미포함 (승인 지출에는 포함)`);
  if (summary.onnuriBillExcludedCount) parts.push(`- 온누리 결제대금 청구 ${summary.onnuriBillExcludedCount}건 (승인 지출과 중복되어 합계 제외)`);
  const otherBills = (summary.billExcludedCount ?? 0) - (summary.onnuriBillExcludedCount ?? 0);
  if (otherBills > 0) parts.push(`- 결제대금 청구 ${otherBills}건 (승인 지출과 중복되어 합계 제외)`);
  if (summary.invalidLines) parts.push(`- 원문 손상 ${summary.invalidLines}줄 (합계 제외)`);
  return parts.join('\n');
}

export function formatDailyNoteSpending(summary) {
  if (!summary.hasSource) return `- ${summary.date}: 오늘 지출 알림 기록 없음`;
  const amount = (value) => `${value.toLocaleString('ko-KR')}원`;
  const lines = [`- ${summary.date} 확인된 지출 ${amount(summary.total)} (${summary.expenseCount}건)`];
  for (const entry of summary.entries ?? []) {
    if (entry.status !== 'expense') continue;
    const label = String(entry.merchant ?? (entry.category === '계좌이체' ? '계좌이체' : `${entry.category} 승인`))
      .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/[\\`*_[\]#]/g, '\\$&');
    lines.push(`- ${label} ${amount(entry.amount)}`);
  }
  for (const entry of summary.entries ?? []) {
    if (entry.status === 'excluded' && ['휘영', '미네'].includes(entry.recipient)) {
      lines.push(`- ${entry.recipient}에게 이체 ${amount(entry.amount)} (지출 합계 제외)`);
    }
  }
  if (summary.pendingCount) lines.push(`- 송금 판정 대기 ${summary.pendingCount}건 (합계 제외)`);
  if (summary.onnuriBillOmissionCount) lines.push(`- 온누리 승인 ${summary.onnuriBillOmissionCount}건: 결제대금에 미포함 (승인 지출에는 포함)`);
  if (summary.onnuriBillExcludedCount) lines.push(`- 온누리 결제대금 청구 ${summary.onnuriBillExcludedCount}건 (승인 지출과 중복되어 합계 제외)`);
  const otherBills = (summary.billExcludedCount ?? 0) - (summary.onnuriBillExcludedCount ?? 0);
  if (otherBills > 0) lines.push(`- 결제대금 청구 ${otherBills}건 (승인 지출과 중복되어 합계 제외)`);
  if (summary.invalidLines) lines.push(`- 원문 손상 ${summary.invalidLines}줄 (합계 제외)`);
  return lines.join('\n');
}
