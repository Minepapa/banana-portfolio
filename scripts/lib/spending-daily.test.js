import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDailySpending, formatTodaySpending, formatDailyNoteSpending, spendingSummaryPath } from './spending-daily.mjs';

const record = (body, sender = '하나카드') => ({ ts: '2026-10-10 12:34:00', packageName: 'example.app', sender, body });

test('일별 지출은 확정 결제만 합산하고 송금 판정 대기는 기록하며 원문은 보존한다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const path = join(spendingDir, '2026', '2026-10-10.jsonl');
  const rows = [
    record('사용금액 : 1,500원\n가맹점 : 가상버스'),
    { ...record('가상은행 1234 (가*상)계좌로 8,000원 송금했어요.', '송금이 완료되었어요'), packageName: 'com.kakaopay.app' },
    record('온누리 결제대금 5,000원'),
  ];
  const original = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(path, original);
  const summary = readDailySpending('2026-10-10', { spendingDir });
  assert.deepEqual([summary.total, summary.expenseCount, summary.pendingCount, summary.byCategory['교통비']], [1500, 1, 1, 1500]);
  assert.match(formatTodaySpending(summary), /송금 판정 대기 1건 \(합계 제외\)/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(spendingSummaryPath('2026-10-10', spendingDir), join(spendingDir, '2026', '2026-10-10.summary.json'));
  writeFileSync(join(spendingDir, 'settings.json'), JSON.stringify({ recipientDecisions: [
    { bank: '가상은행', last4: '1234', status: 'expense' },
  ] }));
  const resolved = readDailySpending('2026-10-10', { spendingDir });
  assert.deepEqual([resolved.total, resolved.pendingCount], [9500, 0]);
});

test('오늘 지출은 서로 다른 가맹점 지출을 각각 표시하고 판정 대기와 제외는 항목에서 뺀다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const rows = [
    record('사용금액 : 2,500원\n가맹점 : 가상식당'),
    record('사용금액 : 3,700원\n가맹점 : 예시서점'),
    { ...record('가상은행 1111 (가*상)계좌로 8,000원 송금했어요.', '송금이 완료되었어요'), packageName: 'com.kakaopay.app' },
    { ...record('예시은행 2222 (예*시)계좌로 9,000원 송금했어요.', '송금이 완료되었어요'), packageName: 'com.kakaopay.app' },
  ];
  writeFileSync(join(spendingDir, '2026', '2026-10-10.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  const summary = readDailySpending('2026-10-10', { spendingDir,
    ownAccounts: [{ bank: '예시은행', last4: '2222' }] });
  const output = formatTodaySpending(summary);
  assert.match(output, /확인된 지출 6,200원 \(2건\)/);
  assert.match(output, /- 가상식당 2,500원/);
  assert.match(output, /- 예시서점 3,700원/);
  assert.match(output, /송금 판정 대기 1건 \(합계 제외\)/);
  assert.doesNotMatch(output, /8,000원|9,000원|가상은행|예시은행|1111|2222/);
});

test('확정된 타인 송금은 계좌이체로 합산하고 수취 계좌 대신 안전한 항목명을 표시한다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const transfer = { ...record('가상은행 1111 (가*상)계좌로 8,000원 송금했어요.', '송금이 완료되었어요'),
    packageName: 'com.kakaopay.app' };
  writeFileSync(join(spendingDir, '2026', '2026-10-10.jsonl'), JSON.stringify(transfer));
  const summary = readDailySpending('2026-10-10', { spendingDir,
    recipientDecisions: [{ bank: '가상은행', last4: '1111', status: 'expense' }] });
  assert.deepEqual([summary.total, summary.byCategory['계좌이체'], summary.entries[0].category],
    [8000, 8000, '계좌이체']);
  const output = formatTodaySpending(summary);
  assert.match(output, /- 계좌이체 8,000원/);
  assert.doesNotMatch(output, /가상은행|1111/);
});

test('상점명이 없는 승인과 많은 확정 지출도 항목을 빠짐없이 표시한다', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    status: 'expense', merchant: index === 0 ? null : `가상상점${index}`, amount: index + 1,
    category: index === 0 ? '온누리상품권' : '일반',
  }));
  const output = formatTodaySpending({ hasSource: true, total: 820, expenseCount: 40,
    pendingCount: 0, invalidLines: 0, byCategory: { 일반: 819, 교통비: 0, 온누리상품권: 1 }, entries });
  assert.match(output, /- 온누리상품권 승인 1원/);
  assert.match(output, /- 가상상점39 40원/);
  assert.equal(output.split('\n').filter((line) => line.startsWith('- ') && /원$/.test(line)).length, 41);
});

test('온누리 승인 지출과 결제대금 청구 제외 근거를 날짜별 요약과 브리핑에 남긴다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const path = join(spendingDir, '2026', '2026-10-10.jsonl');
  const rows = [
    { ...record('온누리(1*2*)가*상 10/10 12:34/일시불/승인/5,000원/가상식당', '결제'),
      packageName: 'com.hanaskcard.paycla' },
    record('온누리 결제대금 5,000원'),
  ];
  const original = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, original);
  const summary = readDailySpending('2026-10-10', { spendingDir });
  assert.deepEqual([summary.total, summary.expenseCount, summary.onnuriBillExcludedCount], [5000, 1, 1]);
  for (const output of [formatTodaySpending(summary), formatDailyNoteSpending(summary)]) {
    assert.match(output, /온누리 결제대금 청구 1건 \(승인 지출과 중복되어 합계 제외\)/);
  }
  assert.match(formatDailyNoteSpending(summary), /2026-10-10 확인된 지출 5,000원 \(1건\)/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('삼성 온누리 승인의 결제대금 미포함 근거를 지출과 함께 표시한다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const approval = { ...record('[삼성카드]10,100원 승인(온누리상품권 10,100원 사용)\n*결제대금에 미포함', '삼성카드'),
    packageName: 'com.kakao.talk' };
  writeFileSync(join(spendingDir, '2026', '2026-10-10.jsonl'), `${JSON.stringify(approval)}\n`);
  const summary = readDailySpending('2026-10-10', { spendingDir });
  assert.deepEqual([summary.total, summary.expenseCount, summary.billExcludedCount,
    summary.onnuriBillOmissionCount], [10100, 1, 0, 1]);
  for (const output of [formatTodaySpending(summary), formatDailyNoteSpending(summary)]) {
    assert.match(output, /온누리 승인 1건: 결제대금에 미포함 \(승인 지출에는 포함\)/);
  }
});

test('같은 시각·금액·가맹점의 일반 승인과 온누리 승인은 날짜 합계에 별건으로 남는다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  mkdirSync(join(spendingDir, '2026'));
  const rows = [
    { ...record('사용금액 : 5,000원\n가맹점 : 가상식당'), packageName: 'com.kakao.talk' },
    { ...record('온누리(1*2*)가*상 10/10 12:34/일시불/승인/5,000원/가상식당', '결제'),
      packageName: 'com.hanaskcard.paycla' },
  ];
  writeFileSync(join(spendingDir, '2026', '2026-10-10.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  const summary = readDailySpending('2026-10-10', { spendingDir });
  assert.deepEqual([summary.total, summary.expenseCount, summary.byCategory['일반'],
    summary.byCategory['온누리상품권']], [10000, 2, 5000, 5000]);
});

test('원문이 없는 날은 손상된 설정을 읽지 않고 원문이 있는 날은 오류를 드러낸다', (t) => {
  const spendingDir = mkdtempSync(join(tmpdir(), 'spending-daily-'));
  t.after(() => rmSync(spendingDir, { recursive: true, force: true }));
  writeFileSync(join(spendingDir, 'settings.json'), '{bad');
  assert.match(formatTodaySpending(readDailySpending('2026-10-10', { spendingDir })), /오늘 지출 알림 기록 없음/);
  mkdirSync(join(spendingDir, '2026'));
  writeFileSync(join(spendingDir, '2026', '2026-10-10.jsonl'), `${JSON.stringify(record('사용금액 : 1,000원\n가맹점 : 가상식당'))}\n`);
  assert.throws(() => readDailySpending('2026-10-10', { spendingDir }), /JSON/);
});
