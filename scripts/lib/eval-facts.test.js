import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvalFacts } from './eval-facts.mjs';

const krFundStub = () => ({ market: 'KR', source: 'OpenDart 2026 1Q(연결)',
  revenueYoY: 12.3, opMargin: 18.5, roe: 9.2, debtRatio: 51.4, opYoYCurr: 5, opYoYPrev: 3 });
const mktStub = () => ({ forwardPE: 14.2, pbr: 1.3, rsi14: 47.5, pos52w: 38.0,
  fcfYield: 4.1, payoutRatio: 25.0, source: 'yfinance 005930.KS' });

test('buildEvalFacts: KR 정상 — 5축 axisItems 채움, 숫자는 Node값', () => {
  const f = buildEvalFacts({ name: '삼성전자', market: 'KR' },
    { corpCode: '00126380', stockCode: '005930' },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.equal(f.axisItems.수익성.find(i => i.metric === 'operating_margin').value, '18.5%');
  assert.equal(f.axisItems.밸류에이션.find(i => i.label.includes('PER')).value, '14.2');
  assert.equal(f.axisItems.모멘텀.find(i => i.metric === 'rsi').value, '47.5');
  assert.ok(f.axisItems.수익성[0].source.includes('OpenDart'));
});

test('buildEvalFacts: 매핑 실패 — 추정 없이 데이터부족 표기', () => {
  const f = buildEvalFacts({ name: '미지의종목', market: 'KR' },
    { corpCode: null, stockCode: null },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.ok(f.factsText.includes('데이터 부족'));
  assert.deepEqual(f.axisItems.수익성, []);
});
