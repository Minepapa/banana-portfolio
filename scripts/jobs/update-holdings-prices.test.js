import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHolding, recomputeValuation } from './update-holdings-prices.mjs';

test('classifyHolding: KR 종목코드가 풀리면 KR(krStockCode 우선)', () => {
  const r = classifyHolding({ name: '삼성전자', account: '위탁' }, { resolveKr: () => '005930' });
  assert.deepEqual(r, { kind: 'KR', code: '005930' });
});

test('classifyHolding: KR 실패·US 티커+거래소코드 둘 다 풀리면 US', () => {
  const r = classifyHolding({ name: '마이크로소프트', account: '위탁' }, {
    resolveKr: () => null, resolveUs: () => 'MSFT', resolveUsExcd: () => 'NAS',
  });
  assert.deepEqual(r, { kind: 'US', code: 'MSFT', excd: 'NAS' });
});

test('classifyHolding: US 티커는 풀렸는데 거래소코드 미등록이면 unmapped(추정 안 함)', () => {
  const r = classifyHolding({ name: '신규종목', account: '위탁' }, {
    resolveKr: () => null, resolveUs: () => 'NEWTK', resolveUsExcd: () => null,
  });
  assert.equal(r.kind, 'unmapped');
  assert.match(r.reason, /거래소코드/);
});

test('classifyHolding: KR·US 둘 다 실패했고 계좌가 금현물이면 GOLD', () => {
  const r = classifyHolding({ name: '금 99.99K', account: '금현물' }, {
    resolveKr: () => null, resolveUs: () => null,
  });
  assert.deepEqual(r, { kind: 'GOLD' });
});

test('classifyHolding: KR·US 둘 다 실패했고 금현물 계좌도 아니면 unmapped', () => {
  const r = classifyHolding({ name: '채권', account: '위탁' }, {
    resolveKr: () => null, resolveUs: () => null,
  });
  assert.equal(r.kind, 'unmapped');
  assert.match(r.reason, /매핑 없음/);
});

test('classifyHolding: "TIGER KRX금현물"처럼 금현물 계좌가 아니어도 krStockCode가 풀리면 KR(ETF 정상경로)', () => {
  // 연금저축 계좌의 금현물 추종 ETF — account가 '금현물'이 아니라 krStockCode가 먼저
  // 풀려서 GOLD가 아니라 KR로 가야 한다(실제 KRX 상장 ETF라 KIS 실시간조회 대상).
  const r = classifyHolding({ name: 'TIGER KRX금현물', account: '연금저축' }, { resolveKr: () => '132030' });
  assert.deepEqual(r, { kind: 'KR', code: '132030' });
});

test('recomputeValuation: 정상 — evalAmount·profitAmount·profitPct 재계산', () => {
  const r = recomputeValuation({ qty: 27, invest: 5628771 }, 210000);
  assert.equal(r.curPrice, 210000);
  assert.equal(r.evalAmount, 5670000);
  assert.equal(r.profitAmount, 41229);
  assert.ok(Math.abs(r.profitPct - 0.7326) < 0.001);
});

test('recomputeValuation: invest가 0/결측이면 profitPct는 추정하지 않고 null', () => {
  const r = recomputeValuation({ qty: 10, invest: 0 }, 1000);
  assert.equal(r.profitPct, null);
  const r2 = recomputeValuation({ qty: 10 }, 1000);
  assert.equal(r2.profitPct, null);
});
