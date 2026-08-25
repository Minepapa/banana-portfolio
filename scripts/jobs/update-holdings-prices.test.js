import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHolding, recomputeValuation, recomputeFxCashValuation } from './update-holdings-prices.mjs';

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

test('classifyHolding: VIP펀드 정식명과 정확히 일치하면 FUND(다른 KR/US/GOLD 모두 실패했을 때)', () => {
  const r = classifyHolding({ name: 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe', account: '연금저축' }, {
    resolveKr: () => null, resolveUs: () => null,
  });
  assert.deepEqual(r, { kind: 'FUND' });
});

test('classifyHolding: VIP펀드와 이름이 비슷해도 정확히 안 맞으면 unmapped(오탐 방지)', () => {
  const r = classifyHolding({ name: 'VIP한국형가치투자증권자투자신탁(주식)-A', account: '연금저축' }, {
    resolveKr: () => null, resolveUs: () => null,
  });
  assert.equal(r.kind, 'unmapped');
});

test('classifyHolding: "TIGER KRX금현물"처럼 금현물 계좌가 아니어도 krStockCode가 풀리면 KR(ETF 정상경로)', () => {
  // 연금저축 계좌의 금현물 추종 ETF — account가 '금현물'이 아니라 krStockCode가 먼저
  // 풀려서 GOLD가 아니라 KR로 가야 한다(실제 KRX 상장 ETF라 KIS 실시간조회 대상).
  const r = classifyHolding({ name: 'TIGER KRX금현물', account: '연금저축' }, { resolveKr: () => '132030' });
  assert.deepEqual(r, { kind: 'KR', code: '132030' });
});

// 2026-08-22 — 자사주 계좌(파이프라인 밖에서 수동 등록, 이름을 원본과 다르게 붙임)
// 대응. ticker가 이미 6자리 KR코드로 채워져 있으면 이름 조회(resolveKr)를 아예
// 안 타야 한다 — resolveKr을 "절대 안 불림" 자체로 검증(호출되면 즉시 실패).
test('classifyHolding: ticker가 KR 6자리면 이름매칭 없이 바로 KR(수동등록 보유 대응)', () => {
  const r = classifyHolding({ name: '삼성전자(자사주)', account: '위탁', ticker: '005930' }, {
    resolveKr: () => { throw new Error('resolveKr이 호출되면 안 됨'); },
  });
  assert.deepEqual(r, { kind: 'KR', code: '005930' });
});

test('classifyHolding: ticker가 6자리가 아니면(빈 문자열 등) 기존처럼 이름매칭으로 폴백', () => {
  const r = classifyHolding({ name: '삼성전자', account: '위탁', ticker: '' }, { resolveKr: () => '005930' });
  assert.deepEqual(r, { kind: 'KR', code: '005930' });
});

// 2026-08-22 — 개별채권(구조적으로 시세 소스가 없는 보유) 대응. resolveKr/resolveUs가
// 호출되면 즉시 실패하도록 넘겨서 "이름매칭을 아예 안 타고 먼저 걸러진다"를 검증.
test('classifyHolding: 개별채권(삼척블루파워12)은 이름매칭 없이 바로 NO_PRICE_SOURCE(collectWarning 안 타는 별도 종류)', () => {
  const r = classifyHolding({ name: '삼척블루파워12', account: '위탁' }, {
    resolveKr: () => { throw new Error('resolveKr이 호출되면 안 됨'); },
    resolveUs: () => { throw new Error('resolveUs가 호출되면 안 됨'); },
  });
  assert.deepEqual(r, { kind: 'NO_PRICE_SOURCE' });
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

test('recomputeValuation: usdKrwRate 지정 시 해외주식 curPrice(USD)를 KRW로 환산 — 2026-08-19 실사고 회귀방지', () => {
  // 마이크로소프트 실사고 케이스 재현: curPrice 481.34(USD), invest는 KRW로 저장.
  // usdKrwRate 없이(기본값 1) 계산하면 evalAmount가 USD 그대로라 profitPct가
  // -99.9%대로 잘못 나왔던 버그.
  const r = recomputeValuation({ qty: 15, invest: 8463615 }, 481.34, { usdKrwRate: 1400 });
  assert.equal(r.evalAmount, 481.34 * 15 * 1400);
  assert.ok(r.profitPct > -50 && r.profitPct < 200, `비정상 profitPct: ${r.profitPct}`);
});

// 2026-08-25 오너 지시 — 외화 현금성 보유(달러 RP 등)는 recomputeValuation이 아니라
// 전용 recomputeFxCashValuation을 쓴다. 투자 포지션이 아니라 "현금을 외화로 들고
// 있는 것"뿐이라 매수 시점 환율(옛 avgPrice)을 원가로 고정해두면 그 뒤 환율 변동이
// 마치 투자손익처럼 표시됐다 — avgPrice·invest도 매번 이번 환율로 재기준해 손익을
// 항상 0으로 유지한다.
test('recomputeFxCashValuation: curPrice·avgPrice 둘 다 이번 환율로 맞춰 손익을 항상 0으로', () => {
  const r = recomputeFxCashValuation({ qty: 651, invest: 928140, avgPrice: 1426 }, 1452.30);
  assert.equal(r.curPrice, 1452.30);
  assert.equal(r.avgPrice, 1452.30);
  assert.equal(r.evalAmount, 651 * 1452.30);
  assert.equal(r.invest, 651 * 1452.30);
  assert.equal(r.profitAmount, 0);
  assert.equal(r.profitPct, 0);
});

test('recomputeFxCashValuation: 환율이 매수 시점보다 크게 움직여도(원화 약세) 여전히 손익 0 — 환전타이밍 손익을 추적하는 게 아님', () => {
  const r = recomputeFxCashValuation({ qty: 100, invest: 130000, avgPrice: 1300 }, 1500);
  assert.equal(r.profitAmount, 0);
  assert.equal(r.profitPct, 0);
  assert.equal(r.evalAmount, 100 * 1500);
});

test('recomputeValuation: unitScale 지정 시 1,000좌당 기준가를 좌당으로 환산(한국 펀드 관례)', () => {
  // VIP펀드 실측 케이스: curPrice(1,000좌당 기준가) 1950, qty(보유 좌수) 8202681.
  // unitScale 없이(기본값 1) 계산하면 qty×curPrice가 1,000배 부풀려진 평가금이 된다.
  const r = recomputeValuation({ qty: 8202681, invest: 12800000 }, 1950, { unitScale: 0.001 });
  assert.equal(r.evalAmount, 1950 * 8202681 * 0.001);
  assert.ok(r.evalAmount > 10_000_000 && r.evalAmount < 20_000_000, `비정상 evalAmount: ${r.evalAmount}`);
});
