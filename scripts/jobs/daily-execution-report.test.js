import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTodayExecutions, buildExecutionReportText, dedupExecutionsForReport } from './daily-execution-report.mjs';

test('filterTodayExecutions: tradeDate 앞 10자리가 오늘 날짜와 일치하는 것만 남긴다', () => {
  const executions = [
    { tradeDate: '2026-08-24 09:46:44', stockName: 'A' },
    { tradeDate: '2026-08-23 15:00:00', stockName: 'B' },
    { tradeDate: '2026-08-24 13:20:11', stockName: 'C' },
  ];
  const today = filterTodayExecutions(executions, '2026-08-24');
  assert.equal(today.length, 2);
  assert.deepEqual(today.map((e) => e.stockName), ['A', 'C']);
});

test('filterTodayExecutions: 오늘자가 하나도 없으면 빈 배열', () => {
  const executions = [{ tradeDate: '2026-08-20 09:00:00', stockName: 'A' }];
  assert.deepEqual(filterTodayExecutions(executions, '2026-08-24'), []);
});

test('filterTodayExecutions: 빈 배열/undefined 입력도 안전하게 빈 배열 반환', () => {
  assert.deepEqual(filterTodayExecutions([], '2026-08-24'), []);
  assert.deepEqual(filterTodayExecutions(undefined, '2026-08-24'), []);
});

test('buildExecutionReportText: 오늘 체결이 없으면 "오늘 체결 없음"', () => {
  assert.equal(buildExecutionReportText([]), '오늘 체결 없음');
});

test('buildExecutionReportText: 각 줄은 [매매유형] 종목명 수량주 @가격 (계좌) 형태', () => {
  const executions = [
    { tradeType: '매도', stockName: 'TIGER 미국배당다우존스', quantity: 200, price: 15450, currency: 'KRW', account: '위탁' },
  ];
  const text = buildExecutionReportText(executions);
  assert.match(text, /\[매도\] TIGER 미국배당다우존스 200주 @15,450 \(위탁\)/);
});

test('buildExecutionReportText: 같은 계좌 체결은 이어서 나열되어 계좌별로 묶인다', () => {
  const executions = [
    { tradeType: '매수', stockName: 'A', quantity: 1, price: 1000, currency: 'KRW', account: '위탁' },
    { tradeType: '매수', stockName: 'B', quantity: 1, price: 1000, currency: 'KRW', account: '연금저축' },
    { tradeType: '매도', stockName: 'C', quantity: 1, price: 1000, currency: 'KRW', account: '위탁' },
  ];
  const text = buildExecutionReportText(executions);
  const lines = text.split('\n');
  const idxA = lines.findIndex((l) => l.includes('] A '));
  const idxC = lines.findIndex((l) => l.includes('] C '));
  const idxB = lines.findIndex((l) => l.includes('] B '));
  assert.ok(idxA < idxC, '위탁 계좌(A, C)는 이어서 나열돼야 함');
  assert.ok(idxB > idxA, '연금저축(B)이 중간에 끼어 위탁 묶음을 갈라놓지 않아야 함(연금저축이 A 뒤에 오더라도 A/C가 서로 붙어 있어야 함)');
});

test('buildExecutionReportText: 계좌·통화별 합산 금액(quantity*price)을 포함', () => {
  const executions = [
    { tradeType: '매도', stockName: 'A', quantity: 200, price: 15450, currency: 'KRW', account: '위탁' },
    { tradeType: '매수', stockName: 'B', quantity: 10, price: 550, currency: 'KRW', account: '위탁' },
  ];
  const text = buildExecutionReportText(executions);
  // 200*15450 + 10*550 = 3,090,000 + 5,500 = 3,095,500
  assert.match(text, /거래대금 합산\(매수\+매도, 상계 없음\) — 위탁 \(KRW\): 3,095,500/);
});

test('buildExecutionReportText: 계좌가 다르면 합산도 계좌별로 분리된다', () => {
  const executions = [
    { tradeType: '매수', stockName: 'A', quantity: 1, price: 1000, currency: 'KRW', account: '위탁' },
    { tradeType: '매수', stockName: 'B', quantity: 2, price: 2000, currency: 'KRW', account: '연금저축' },
  ];
  const text = buildExecutionReportText(executions);
  assert.match(text, /거래대금 합산\(매수\+매도, 상계 없음\) — 위탁 \(KRW\): 1,000/);
  assert.match(text, /거래대금 합산\(매수\+매도, 상계 없음\) — 연금저축 \(KRW\): 4,000/);
});

test('buildExecutionReportText: account가 없으면 "미배정"으로 표시', () => {
  const executions = [{ tradeType: '매수', stockName: 'A', quantity: 1, price: 1000, currency: 'KRW', account: null }];
  const text = buildExecutionReportText(executions);
  assert.match(text, /\(미배정\)/);
  assert.match(text, /거래대금 합산\(매수\+매도, 상계 없음\) — 미배정 \(KRW\): 1,000/);
});

// ── dedupExecutionsForReport(2026-09-04 신설, 오너 실거래 재현) ──────────────────

test('[실사고 재현] dedupExecutionsForReport: 금현물 금 99.99K 1주 매수를 NH API·카카오 두 소스가 각자 기록해도 한 줄만 남김', () => {
  // 실제 2026-09-04 라이브 Vault 레코드 그대로(파일명 다름·dedupKey 다름, 같은 실제 체결).
  const nhExec = {
    tradeDate: '2026-09-04 00:00:00', tradeType: '매수', stockName: '금 99.99K', quantity: 1, price: 195760,
    account: '금현물', currency: 'KRW', orderNo: '2344110', recordedAt: '2026-09-04T02:36:40.605Z',
  };
  const kakaoExec = {
    tradeDate: '2026-09-04 11:33:57', tradeType: '매수', stockName: '금 99.99K', quantity: 1, price: 195760,
    account: '금현물', currency: 'KRW', recordedAt: '2026-09-04T02:38:31.996Z',
  };
  const deduped = dedupExecutionsForReport([kakaoExec, nhExec]);
  assert.equal(deduped.length, 1);
});

test('dedupExecutionsForReport: recordedAt 오름차순으로 먼저 기록된 쪽을 대표로 남김', () => {
  const later = { tradeDate: '2026-09-04', tradeType: '매수', stockName: 'X', quantity: 1, price: 100, recordedAt: '2026-09-04T02:38:00.000Z', account: 'A' };
  const earlier = { tradeDate: '2026-09-04', tradeType: '매수', stockName: 'X', quantity: 1, price: 100, recordedAt: '2026-09-04T02:36:00.000Z', account: 'B' };
  const deduped = dedupExecutionsForReport([later, earlier]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].account, 'B'); // 더 먼저 기록된 쪽
});

test('dedupExecutionsForReport: 진짜 다른 체결(수량 다름)은 안 지워짐 — 위탁 사례처럼 정당한 병행', () => {
  const buy1 = { tradeDate: '2026-09-04', tradeType: '매수', stockName: 'X', quantity: 1, price: 100, recordedAt: '2026-09-04T02:36:00.000Z' };
  const buy2 = { tradeDate: '2026-09-04', tradeType: '매수', stockName: 'X', quantity: 2, price: 100, recordedAt: '2026-09-04T02:37:00.000Z' };
  assert.equal(dedupExecutionsForReport([buy1, buy2]).length, 2);
});

test('dedupExecutionsForReport: 빈 배열/undefined 입력도 안전', () => {
  assert.deepEqual(dedupExecutionsForReport([]), []);
  assert.deepEqual(dedupExecutionsForReport(undefined), []);
});
