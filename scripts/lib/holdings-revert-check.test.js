import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRevertedHoldings, buildRevertedHoldingsMessage, isExternallyManagedAccount } from './holdings-revert-check.mjs';
import { renderAgentMessage } from './pantheon-send.mjs';

const key = (tradeDate, tradeType, name, quantity) => `${tradeDate}|${tradeType}|${name}|${quantity}`;
// appliedAt: 잡이 실제로 반영한 시각(holdingsAppliedAt). 판정 기준축이다.
const exec = (account, name, tradeDate, tradeType, quantity, appliedAt, extra = {}) => ({
  account, stockName: name, tradeDate, tradeType, quantity,
  dedupKey: key(tradeDate, tradeType, name, quantity), holdingsApplied: true,
  holdingsAppliedAt: appliedAt, ...extra,
});
const holding = (account, name, qty, keys, extra = {}) => ({
  account, name, qty, appliedDedupKeys: JSON.stringify(keys), ...extra,
});

test('알파벳 실사례: 전량매도 뒤 되살아난 옛 사본 위에 매수가 쌓이면 빠진 체결을 잡는다', () => {
  const name = '알파벳 Class A';
  const executions = [
    exec('위탁', name, '2026-10-22 00:00:00', '매수', 2, '2026-10-23T07:05:00.000Z'),
    exec('위탁', name, '2026-10-27 00:00:00', '매수', 2, '2026-10-28T07:05:00.000Z'),
    exec('위탁', name, '2026-10-28 00:00:00', '매도', 22, '2026-10-29T07:05:00.000Z'),
    exec('위탁', name, '2026-10-29 00:00:00', '매수', 5, '2026-10-30T07:05:00.000Z'),
  ];
  // 10-23 시점 사본(키 1개)이 되살아난 뒤 10-29 매수 5주가 그 위에 적용됨.
  const holdings = [holding('위탁', name, 25, [executions[0].dedupKey, executions[3].dedupKey])];
  const result = findRevertedHoldings(executions, holdings);
  assert.equal(result.length, 1);
  assert.equal(result[0].account, '위탁');
  assert.equal(result[0].name, name);
  assert.equal(result[0].qty, 25);
  assert.deepEqual(result[0].missing.map((item) => `${item.tradeDate}|${item.tradeType}|${item.quantity}`),
    ['2026-10-27 00:00:00|매수|2', '2026-10-28 00:00:00|매도|22']);
  assert.equal(result[0].missing[1].dedupKey, executions[2].dedupKey);
});

test('정상: 부분 매도 뒤 키가 계속 누적되면 이상 없음', () => {
  const executions = [
    exec('ISA', '삼성전자', '2026-09-01 09:00:00', '매수', 10, '2026-09-01T07:05:00.000Z'),
    exec('ISA', '삼성전자', '2026-09-10 09:00:00', '매도', 3, '2026-09-10T07:05:00.000Z'),
    exec('ISA', '삼성전자', '2026-09-20 09:00:00', '매수', 5, '2026-09-20T07:05:00.000Z'),
  ];
  assert.deepEqual(findRevertedHoldings(executions, [holding('ISA', '삼성전자', 12, executions.map((item) => item.dedupKey))]), []);
});

test('정상: 전량청산 뒤 신규 매수로 키가 새로 시작하면 청산 전 이력은 보지 않는다', () => {
  const executions = [
    exec('위탁', '엔비디아', '2026-09-01 09:00:00', '매수', 5, '2026-09-01T07:05:00.000Z'),
    exec('위탁', '엔비디아', '2026-09-05 09:00:00', '매도', 5, '2026-09-05T07:05:00.000Z'),
    exec('위탁', '엔비디아', '2026-09-08 14:00:00', '매수', 3, '2026-09-08T07:05:00.000Z'),
  ];
  assert.deepEqual(findRevertedHoldings(executions, [holding('위탁', '엔비디아', 3, [executions[2].dedupKey])]), []);
});

test('정상: 날짜만 있는 NH 체결로 같은 날 전량매도 뒤 재매수하면 매도는 누락이 아니다', () => {
  const executions = [
    exec('위탁', '알파벳 Class A', '2026-10-20 00:00:00', '매수', 4, '2026-10-21T07:05:00.000Z'),
    exec('위탁', '알파벳 Class A', '2026-10-28 00:00:00', '매도', 4, '2026-10-29T07:05:00.100Z'),
    exec('위탁', '알파벳 Class A', '2026-10-28 00:00:00', '매수', 3, '2026-10-29T07:05:00.200Z'),
  ];
  assert.deepEqual(findRevertedHoldings(executions, [holding('위탁', '알파벳 Class A', 3, [executions[2].dedupKey])]), []);
});

test('정상: 알림 누락분을 나중에 반영해 과거 체결시각 키가 새 파일에 들어와도 옛 로트 매도는 누락이 아니다', () => {
  const executions = [
    exec('위탁', '테스트', '2026-10-10 00:00:00', '매수', 5, '2026-10-10T07:05:00.000Z'),
    exec('위탁', '테스트', '2026-10-19 00:00:00', '매도', 5, '2026-10-19T07:05:00.000Z'),
    exec('위탁', '테스트', '2026-10-20 00:00:00', '매수', 2, '2026-10-20T07:05:00.000Z'),
    // 10-18 매수 알림이 빠졌다가 10-25에 오너 확인 행으로 반영됨.
    exec('위탁', '테스트', '2026-10-18 00:00:00', '매수', 1, '2026-10-25T07:05:00.000Z', { source: 'OWNER_CONFIRMED' }),
  ];
  const holdings = [holding('위탁', '테스트', 3, [executions[2].dedupKey, executions[3].dedupKey])];
  assert.deepEqual(findRevertedHoldings(executions, holdings), []);
});

test('정상: IRP·퀀트는 API 잔고가 정본이라 적용 키가 재설정돼도 대조하지 않는다', () => {
  assert.equal(isExternallyManagedAccount('IRP'), true);
  assert.equal(isExternallyManagedAccount('퀀트'), true);
  assert.equal(isExternallyManagedAccount('위탁'), false);
  const executions = ['IRP', '퀀트'].flatMap((account) => [
    exec(account, '테스트', '2026-10-01 09:00:00', '매수', 1, '2026-10-01T07:05:00.000Z'),
    exec(account, '테스트', '2026-10-02 09:00:00', '매수', 1, '2026-10-02T07:05:00.000Z'),
  ]);
  const holdings = ['IRP', '퀀트'].map((account) => holding(account, '테스트', 2, [key('2026-10-01 09:00:00', '매수', '테스트', 1)]));
  assert.deepEqual(findRevertedHoldings(executions, holdings), []);
});

test('정상: 현금성 행과 키 없는 옛 파일은 건너뛴다', () => {
  const executions = [
    exec('위탁', '예수금', '2026-10-01 09:00:00', '매수', 1, '2026-10-01T07:05:00.000Z'),
    exec('위탁', '예수금', '2026-10-02 09:00:00', '매수', 1, '2026-10-02T07:05:00.000Z'),
    exec('ISA', '옛종목', '2026-10-02 09:00:00', '매수', 1, '2026-10-02T07:05:00.000Z'),
  ];
  const holdings = [
    holding('위탁', '예수금', 100, [executions[0].dedupKey], { isCashLike: true }),
    holding('ISA', '옛종목', 50, []),
    { account: 'ISA', name: '키필드없음', qty: 1 },
    holding('ISA', '깨진키', 1, [], { appliedDedupKeys: 'not-json' }),
  ];
  assert.deepEqual(findRevertedHoldings(executions, holdings), []);
});

test('정상: null 키가 섞인 마이그레이션 파일은 문자열 키만 기준으로 본다', () => {
  const executions = [
    exec('ISA', '리츠', '2026-08-01 09:00:00', '매수', 10, '2026-08-01T07:05:00.000Z', { legacy: true }),
    exec('ISA', '리츠', '2026-09-29 09:27:53', '매수', 10, '2026-09-29T07:05:00.000Z'),
    exec('ISA', '리츠', '2026-10-13 12:50:58', '매수', 10, '2026-10-13T07:05:00.000Z'),
  ];
  const holdings = [holding('ISA', '리츠', 1480, [null, executions[1].dedupKey, executions[2].dedupKey])];
  assert.deepEqual(findRevertedHoldings(executions, holdings), []);
});

test('정상: 미반영·중복표시·legacy·다른 계좌·dedupKey 없는 체결은 누락으로 세지 않는다', () => {
  const base = exec('위탁', '테스트', '2026-10-01 09:00:00', '매수', 1, '2026-10-01T07:05:00.000Z');
  const executions = [base,
    exec('위탁', '테스트', '2026-10-02 09:00:00', '매수', 1, undefined, { holdingsApplied: false }),
    exec('위탁', '테스트', '2026-10-03 09:00:00', '매수', 1, '2026-10-03T07:05:00.000Z', { holdingsApplied: 'duplicate-skipped', duplicateOf: 'x' }),
    exec('위탁', '테스트', '2026-10-04 09:00:00', '매수', 1, '2026-10-04T07:05:00.000Z', { duplicateOf: 'y' }),
    exec('위탁', '테스트', '2026-10-05 09:00:00', '매수', 1, '2026-10-05T07:05:00.000Z', { legacy: true }),
    exec('ISA', '테스트', '2026-10-06 09:00:00', '매수', 1, '2026-10-06T07:05:00.000Z'),
    exec('위탁', '테스트', '2026-10-07 09:00:00', '매수', 1, '2026-10-07T07:05:00.000Z', { dedupKey: undefined }),
  ];
  assert.deepEqual(findRevertedHoldings(executions, [holding('위탁', '테스트', 1, [base.dedupKey])]), []);
});

test('키에 대응하는 반영 체결이 원장에 없으면 기준점을 세우지 않고 건너뛴다', () => {
  const later = exec('위탁', '테스트', '2026-10-05 09:00:00', '매수', 1, '2026-10-05T07:05:00.000Z');
  assert.deepEqual(findRevertedHoldings([later], [holding('위탁', '테스트', 1, ['원장에-없는-키'])]), []);
});

test('같은 날짜 체결도 첫 키보다 나중에 반영됐는데 빠지면 이상으로 본다', () => {
  const first = exec('위탁', '테스트', '2026-10-01 00:00:00', '매수', 1, '2026-10-01T07:05:00.000Z');
  const sameDay = exec('위탁', '테스트', '2026-10-01 00:00:00', '매수', 2, '2026-10-01T07:05:00.500Z');
  const result = findRevertedHoldings([first, sameDay], [holding('위탁', '테스트', 1, [first.dedupKey])]);
  assert.equal(result.length, 1);
  assert.equal(result[0].missing[0].dedupKey, sameDay.dedupKey);
});

test('경고 메시지: 4단 구조·종목당 사실 한 항목·체결 한 줄씩·HTML 이스케이프·플루토스 발신', () => {
  const message = buildRevertedHoldingsMessage([
    { account: '위탁', name: '알파벳 Class A', qty: 25, missing: [
      { tradeDate: '2026-10-27 00:00:00', tradeType: '매수', quantity: 2 },
      { tradeDate: '2026-10-28 00:00:00', tradeType: '매도', quantity: 22 }] },
    { account: 'ISA', name: 'TIGER 미국S&P500', qty: 5, missing: Array.from({ length: 7 }, (_, index) => (
      { tradeDate: `2026-10-0${index + 1} 09:00:00`, tradeType: '매수', quantity: 1 })) },
  ]);
  assert.equal(message.agent, 'plutus');
  assert.equal(message.facts.length, 2);
  assert.equal(message.facts[0], '위탁 알파벳 Class A: 보유 파일 25주, 빠진 체결 2건\n10-27 매수 2주\n10-28 매도 22주');
  assert.match(message.facts[1], /S&amp;P500/);
  assert.match(message.facts[1], /\n외 2건$/);
  const text = renderAgentMessage(message);
  const order = ['[결론]', '[사실]', '[맥락]', '[의사결정]'].map((marker) => text.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(text.split('\n')[0], /^\[플루토스 Plutus\] /);
  assert.match(text, /적용 키 목록을 함께 고칩니다/);
});
