import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvalFacts } from './eval-facts.mjs';
import { LEARNING_MODULES } from '../../src/lib/constants.js';

const krFundStub = () => ({ market: 'KR', source: 'OpenDart 2026 1Q(연결)',
  revenueYoY: 12.3, opMargin: 18.5, roe: 9.2, debtRatio: 51.4, opYoYCurr: 5, opYoYPrev: 3 });
const mktStub = () => ({ forwardPE: 14.2, pbr: 1.3, rsi14: 47.5, pos52w: 38.0,
  fcfYield: 4.1, payoutRatio: 25.0, source: 'yfinance 005930.KS' });

test('buildEvalFacts: KR 정상 — 5축 axisItems 채움, 숫자는 Node값', async () => {
  const f = await buildEvalFacts({ name: '삼성전자', market: 'KR' },
    { corpCode: '00126380', stockCode: '005930' },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.equal(f.axisItems.수익성.find(i => i.metric === 'operating_margin').value, '18.5%');
  assert.equal(f.axisItems.밸류에이션.find(i => i.label.includes('PER')).value, '14.2');
  assert.equal(f.axisItems.모멘텀.find(i => i.metric === 'rsi').value, '47.5');
  assert.ok(f.axisItems.수익성[0].source.includes('OpenDart'));
});

test('buildEvalFacts: 모든 metric 키는 LEARNING_MODULES에 실재 (CLAUDE.md 규칙5)', async () => {
  // metric이 LEARNING_MODULES 키와 어긋나면 앱 학습모듈 연결이 깨진다 — 환각 방지와 별개로 계약 위반.
  const f = await buildEvalFacts({ name: '삼성전자', market: 'KR' },
    { corpCode: '00126380', stockCode: '005930' },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  for (const items of Object.values(f.axisItems)) {
    for (const it of items) {
      if (it.metric) assert.ok(it.metric in LEARNING_MODULES, `미존재 metric 키: ${it.metric}`);
    }
  }
});

test('buildEvalFacts: 비동기 재무 페처(Promise) await — 동기 누락 시 데이터부족 회귀', async () => {
  // fetchKrFundamentals는 async(Promise 반환). buildEvalFacts가 await 안 하면 fund가
  // 미해소 Promise가 되어 모든 재무 축이 조용히 비어버린다 — 그 회귀를 잡는다.
  const asyncKrFund = async () => krFundStub();
  const f = await buildEvalFacts({ name: '삼성전자', market: 'KR' },
    { corpCode: '00126380', stockCode: '005930' },
    { krFund: asyncKrFund, usFund: null, krMkt: mktStub, usMkt: null });
  assert.equal(f.axisItems.수익성.find(i => i.metric === 'operating_margin').value, '18.5%');
  assert.ok(f.axisItems.수익성[0].source.includes('OpenDart'));
});

test('buildEvalFacts: 매핑 실패 — 추정 없이 데이터부족 표기', async () => {
  const f = await buildEvalFacts({ name: '미지의종목', market: 'KR' },
    { corpCode: null, stockCode: null },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.ok(f.factsText.includes('데이터 부족'));
  assert.deepEqual(f.axisItems.수익성, []);
});
