import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstDayDiff, findMatchingExecution, shouldRemind, buildReminderText } from './proposal-execution-reminder.mjs';

test('kstDayDiff: 정확히 3일 차이', () => {
  assert.equal(kstDayDiff('2026-08-20T01:00:00.000Z', new Date('2026-08-23T01:00:00.000Z')), 3);
});

test('kstDayDiff: 같은 날이면 0', () => {
  assert.equal(kstDayDiff('2026-08-23T00:30:00.000Z', new Date('2026-08-23T10:00:00.000Z')), 0);
});

test('findMatchingExecution: 계좌·매매구분·종목·시각순서 전부 일치해야 매칭', () => {
  const proposal = { account: '위탁', side: '매수', assetKey: 'TIGER 200', decidedAt: '2026-08-20T00:00:00.000Z' };
  const executions = [
    { account: '위탁', tradeType: '매수', stockName: 'TIGER 200', recordedAt: '2026-08-21T00:00:00.000Z' },
  ];
  assert.ok(findMatchingExecution(proposal, executions));
});

test('findMatchingExecution: 계좌 다르면 매칭 안 됨', () => {
  const proposal = { account: '위탁', side: '매수', assetKey: 'TIGER 200', decidedAt: '2026-08-20T00:00:00.000Z' };
  const executions = [{ account: '연금저축', tradeType: '매수', stockName: 'TIGER 200', recordedAt: '2026-08-21T00:00:00.000Z' }];
  assert.equal(findMatchingExecution(proposal, executions), null);
});

test('findMatchingExecution: 종목코드로도 매칭 가능(stockName 대신 stockCode 일치)', () => {
  const proposal = { account: '위탁', side: '매수', assetKey: '102110', decidedAt: '2026-08-20T00:00:00.000Z' };
  const executions = [{ account: '위탁', tradeType: '매수', stockCode: '102110', stockName: 'TIGER 200', recordedAt: '2026-08-21T00:00:00.000Z' }];
  assert.ok(findMatchingExecution(proposal, executions));
});

test('findMatchingExecution: 체결이 승인 이전이면 매칭 안 됨(우연한 과거 거래 오매칭 방지)', () => {
  const proposal = { account: '위탁', side: '매수', assetKey: 'TIGER 200', decidedAt: '2026-08-20T00:00:00.000Z' };
  const executions = [{ account: '위탁', tradeType: '매수', stockName: 'TIGER 200', recordedAt: '2026-08-19T00:00:00.000Z' }];
  assert.equal(findMatchingExecution(proposal, executions), null);
});

test('findMatchingExecution: 수량이 있으면 수량까지 일치해야 매칭 — 연금저축 정기적립매수(다른 수량)를 오매칭하지 않기 위함(2026-08-23 코드리뷰 지적)', () => {
  const proposal = { account: '연금저축', side: '매수', assetKey: 'TIGER 200', quantity: 10, decidedAt: '2026-08-20T00:00:00.000Z' };
  const monthlyAutoBuy = [{ account: '연금저축', tradeType: '매수', stockName: 'TIGER 200', quantity: 3, recordedAt: '2026-08-21T00:00:00.000Z' }];
  assert.equal(findMatchingExecution(proposal, monthlyAutoBuy), null, '수량이 다른 정기적립매수를 리밸런싱 체결로 오판하면 안 됨');

  const actualMatch = [{ account: '연금저축', tradeType: '매수', stockName: 'TIGER 200', quantity: 10, recordedAt: '2026-08-21T00:00:00.000Z' }];
  assert.ok(findMatchingExecution(proposal, actualMatch));
});

test('findMatchingExecution: proposal.quantity가 없으면(신규종목이라 Node가 수량 계산 못한 경우) 수량 비교 생략', () => {
  const proposal = { account: '위탁', side: '매수', assetKey: '미국달러ETF', quantity: null, decidedAt: '2026-08-20T00:00:00.000Z' };
  const executions = [{ account: '위탁', tradeType: '매수', stockName: '미국달러ETF', quantity: 7, recordedAt: '2026-08-21T00:00:00.000Z' }];
  assert.ok(findMatchingExecution(proposal, executions));
});

test('shouldRemind: 승인 3일 미만이면 false', () => {
  const proposal = { status: '승인', decidedAt: '2026-08-21T00:00:00.000Z' };
  assert.equal(shouldRemind({ proposal, now: new Date('2026-08-23T00:00:00.000Z') }), false);
});

test('shouldRemind: 승인 3일 이상이고 첫 리마인드면 true', () => {
  const proposal = { status: '승인', decidedAt: '2026-08-20T00:00:00.000Z' };
  assert.equal(shouldRemind({ proposal, now: new Date('2026-08-23T00:00:00.000Z') }), true);
});

test('shouldRemind: 마지막 리마인드 후 3일 안 지났으면 false(naggy 방지)', () => {
  const proposal = { status: '승인', decidedAt: '2026-08-10T00:00:00.000Z' };
  const lastRemindedAt = '2026-08-22T00:00:00.000Z';
  assert.equal(shouldRemind({ proposal, now: new Date('2026-08-23T00:00:00.000Z'), lastRemindedAt }), false);
});

test('shouldRemind: 마지막 리마인드 후 3일 지났으면 재발송 true', () => {
  const proposal = { status: '승인', decidedAt: '2026-08-10T00:00:00.000Z' };
  const lastRemindedAt = '2026-08-19T00:00:00.000Z';
  assert.equal(shouldRemind({ proposal, now: new Date('2026-08-23T00:00:00.000Z'), lastRemindedAt }), true);
});

test('shouldRemind: 승인 상태가 아니면 false(거부·대체됨 등)', () => {
  const proposal = { status: '거부', decidedAt: '2026-08-10T00:00:00.000Z' };
  assert.equal(shouldRemind({ proposal, now: new Date('2026-08-23T00:00:00.000Z') }), false);
});

test('buildReminderText: 며칠째인지·제안ID·안내문구 포함', () => {
  const text = buildReminderText({ side: '매수', account: '위탁', assetKey: 'TIGER 200', quantity: 5, id: 'test-id' }, 3);
  assert.match(text, /3일째/);
  assert.match(text, /test-id/);
  assert.match(text, /이미 브로커 앱에서 직접 체결하셨다면 무시/);
});
