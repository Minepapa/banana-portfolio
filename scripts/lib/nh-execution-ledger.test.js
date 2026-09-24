import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';
import { recordNhTerminalExecution } from './nh-execution-ledger.mjs';

const row = (overrides = {}) => ({
  orderNo: '847026', stockCode: '005930', stockName: '삼성전자', tradeType: '매수',
  quantity: 5, orderQty: 10, fullyFilled: false, price: 100, executionAmount: 500,
  unfilledQty: 0, ...overrides,
});

function tempLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nh-execution-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('recordNhTerminalExecution: 종료된 부분체결은 체결분만 기록하고 재실행해도 중복하지 않음', async (t) => {
  const dir = tempLedger(t);
  const args = { row: row(), tradeDate: '2026-09-24 00:00:00', account: '위탁', acctNo: '2050****019', dir };
  const first = await recordNhTerminalExecution(args);
  const second = await recordNhTerminalExecution(args);
  assert.equal(first.ok, true);
  assert.ok(first.filepath);
  assert.equal(second.ok, true);
  assert.equal(second.event, null);
  const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 1);
  const record = parseFrontmatter(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(record.quantity, 5);
  assert.equal(record.price, 100);
  assert.equal(record.source, 'NH_API');
  assert.equal(record.orderCumulativeQty, 5);
});

test('recordNhTerminalExecution: 누적 체결수량이 커지면 앞서 기록한 누적분과 차액만 추가', async (t) => {
  const dir = tempLedger(t);
  const common = { tradeDate: '2026-09-24 00:00:00', account: '위탁', acctNo: '2050****019', dir };
  const first = await recordNhTerminalExecution({ ...common, row: row() });
  const next = await recordNhTerminalExecution({
    ...common,
    row: row({ quantity: 8, orderQty: 10, price: 102.5, executionAmount: 820 }),
  });
  assert.equal(first.event.quantity, 5);
  assert.equal(next.event.quantity, 3);
  assert.equal(next.event.price, 106.66666666666667);
  const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 2);
});

test('recordNhTerminalExecution: 동시 watcher/reconcile 호출도 하나의 레코드만 생성', async (t) => {
  const dir = tempLedger(t);
  const args = { row: row(), tradeDate: '2026-09-24 00:00:00', account: '위탁', dir };
  const results = await Promise.all([
    recordNhTerminalExecution(args),
    recordNhTerminalExecution(args),
  ]);
  assert.equal(results.filter((result) => result.event).length, 1);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.md')).length, 1);
});

test('recordNhTerminalExecution: 같은 주문 카카오 체결분은 차감하고 누적 체결의 나머지만 기록', async (t) => {
  const dir = tempLedger(t);
  const kakao = buildFrontmatter({
    type: 'execution', tradeDate: '2026-09-24 09:01:00', tradeType: '매수',
    stockCode: '005930', stockName: '삼성전자', quantity: 3, price: 90,
    broker: 'NH투자증권', orderNo: '847026', account: null,
  });
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(dir, 'kakao.md'), kakao));
  const result = await recordNhTerminalExecution({
    row: row({ quantity: 5, price: 96, executionAmount: 480 }),
    tradeDate: '2026-09-24 00:00:00', account: '위탁', acctNo: '2050****019', dir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.quantity, 2);
  assert.equal(result.event.price, 105);
  const record = parseFrontmatter(readFileSync(result.filepath, 'utf8'));
  assert.equal(record.orderCumulativeQty, 5);
  assert.equal(record.orderCumulativeAmount, 480);
});

test('recordNhTerminalExecution: 진행 중 부분체결과 잔량상태 불명은 기록하지 않음', async (t) => {
  const dir = tempLedger(t);
  const args = { row: row({ unfilledQty: 5 }), tradeDate: '2026-09-24 00:00:00', account: '위탁', dir };
  const active = await recordNhTerminalExecution(args);
  assert.equal(active.ok, false);
  assert.match(active.reason, /종료되지 않았거나/);
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.md')), false);
});

test('recordNhTerminalExecution: 누적 체결금액과 평균단가가 어긋나면 기록하지 않음', async (t) => {
  const dir = tempLedger(t);
  const result = await recordNhTerminalExecution({
    row: row({ executionAmount: 700 }), tradeDate: '2026-09-24 00:00:00', account: '위탁', dir,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /일치하지 않음/);
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.md')), false);
});
