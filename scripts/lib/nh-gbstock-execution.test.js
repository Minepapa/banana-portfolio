import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGbExecutionLedgerInput,
  isSupportedGbUsTradeRow,
  parseGbDailyTransactionRows,
} from './nh-gbstock-execution.mjs';
import { buildExecutionRecord } from './ledger-vault-writer.mjs';

const liveRow = {
  trd_dt: '20260610', trd_sno: 1, act_trd_tp_nm: '매도', sps_cd_nm: '외화증권매도',
  trd_qty: 2, trd_uit_pr: 314.5057, cur_cd_nm: 'USD',
  fc_trd_amt: 628.43, iem_cd: 'AAPL US', iem_nm: '애플', fc_amt: 629.01,
};

test('parseGbDailyTransactionRows: 실측 일별거래내역을 USD 체결 행으로 정규화한다', () => {
  assert.deepEqual(parseGbDailyTransactionRows([liveRow]), [{
    tradeDate: '2026-06-10', tradeType: '매도', stockCode: 'AAPL', stockName: '애플',
    quantity: 2, price: 314.5057, sourceEventId: 'gb-20260610-1',
  }]);
});

test('parseGbDailyTransactionRows: USD 결제여도 미국시장 접미사가 아닌 행은 보정 대상에서 제외한다', () => {
  assert.deepEqual(parseGbDailyTransactionRows([{ ...liveRow, iem_cd: '0700 HK' }]), []);
});

test('isSupportedGbUsTradeRow: 미국 종목 코드여도 USD가 아니면 지원 범위 밖으로 분류한다', () => {
  assert.equal(isSupportedGbUsTradeRow(liveRow), true);
  assert.equal(isSupportedGbUsTradeRow({ ...liveRow, cur_cd_nm: 'JPY' }), false);
  assert.equal(isSupportedGbUsTradeRow({ ...liveRow, iem_cd: '0700 HK' }), false);
});

test('parseGbDailyTransactionRows: 매수·매도가 아닌 거래구분과 유효하지 않은 숫자는 기록하지 않는다', () => {
  assert.deepEqual(parseGbDailyTransactionRows([
    { ...liveRow, act_trd_tp_nm: '배당' },
    { ...liveRow, trd_qty: 0 },
    { ...liveRow, trd_uit_pr: '' },
    { ...liveRow, trd_dt: '2026-06-10' },
    { ...liveRow, cur_cd_nm: 'JPY' },
  ]), []);
});

test('buildGbExecutionLedgerInput: API 행 순번을 주문번호와 별개의 dedupKey·파일명 식별자로 쓴다', () => {
  const row = parseGbDailyTransactionRows([liveRow])[0];
  const fromReconcile = buildExecutionRecord(buildGbExecutionLedgerInput(row, {
    account: '위탁', actNo: '20501596019',
  }));
  const fromRepeat = buildExecutionRecord(buildGbExecutionLedgerInput(row, {
    account: '위탁', actNo: '20501596019',
  }));

  assert.equal(fromReconcile.dedupKey, '2026-06-09 00:00:00|매도|애플|2|gb-20260610-1');
  assert.equal(fromReconcile.dedupKey, fromRepeat.dedupKey);
  assert.equal(fromReconcile.filename, fromRepeat.filename);
  assert.equal(fromReconcile.content.includes('orderNo: ""'), true);
  assert.equal(fromReconcile.content.includes('sourceEventId: "gb-20260610-1"'), true);
  assert.equal(fromReconcile.content.includes('broker: "NH투자증권 해외"'), true);
});

test('buildGbExecutionLedgerInput: API 날짜의 전일을 표시일자 최선근사치로만 쓴다', () => {
  const row = parseGbDailyTransactionRows([liveRow])[0];
  const execution = buildGbExecutionLedgerInput(row, { account: '위탁', actNo: '20501596019' });

  assert.equal(execution.tradeDate, '2026-06-09 00:00:00');
  assert.equal(execution.tradeType, '매도');
  assert.equal(execution.stockCode, 'AAPL');
  assert.equal(execution.quantity, 2);
  assert.equal(execution.price, 314.5057);
});
