import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachHistoricalOcf } from './historical-ranking.mjs';
import { rankByOcfToPrice } from './quant-factor.mjs';

const candidate = (code, marcap, overrides = {}) => ({ code, name: `종목${code}`, market: 'KOSPI', marcap, avgTradingValue: 5_000_000_000, ...overrides });

test('attachHistoricalOcf: corpCode·OCF 조회 결과가 있으면 Code/Name/Marcap/operCf로 매핑', () => {
  const candidates = [candidate('A', 1000)];
  const corpCodeByStock = { A: 'corpA' };
  const ocfByCorpCode = { corpA: { '2020-01-01': { operCf: 500, disclosureDate: '2019-12-01' } } };
  const out = attachHistoricalOcf(candidates, corpCodeByStock, ocfByCorpCode, '2020-01-01');
  assert.equal(out[0].Code, 'A');
  assert.equal(out[0].Name, '종목A');
  assert.equal(out[0].Marcap, 1000);
  assert.equal(out[0].operCf, 500);
  assert.equal(out[0].ocfDisclosureDate, '2019-12-01');
});

test('attachHistoricalOcf: corpCode 매칭 실패면 operCf null(추정 안 함)', () => {
  const candidates = [candidate('A', 1000)];
  const out = attachHistoricalOcf(candidates, {}, {}, '2020-01-01');
  assert.equal(out[0].operCf, null);
});

test('attachHistoricalOcf: corpCode는 있는데 그 날짜 OCF 조회결과가 없으면 operCf null', () => {
  const candidates = [candidate('A', 1000)];
  const corpCodeByStock = { A: 'corpA' };
  const out = attachHistoricalOcf(candidates, corpCodeByStock, { corpA: {} }, '2020-01-01');
  assert.equal(out[0].operCf, null);
});

// 핵심 통합 성질 — attachHistoricalOcf + rankByOcfToPrice(Phase 9, 이미 검증됨)를 그대로
// 이어붙이면 새 랭킹 로직 없이 역사적 순위가 정확히 나와야 한다.
test('attachHistoricalOcf + rankByOcfToPrice: 새 로직 없이 기존 랭킹 함수 그대로 재사용해 정확한 순위 산출', () => {
  const candidates = [candidate('A', 10000), candidate('B', 10000), candidate('C', 10000)];
  const corpCodeByStock = { A: 'ca', B: 'cb', C: 'cc' };
  const ocfByCorpCode = {
    ca: { d: { operCf: 500, disclosureDate: 'd' } },  // 0.05
    cb: { d: { operCf: 2000, disclosureDate: 'd' } }, // 0.20 (1위)
    cc: { d: { operCf: 1000, disclosureDate: 'd' } }, // 0.10
  };
  const attached = attachHistoricalOcf(candidates, corpCodeByStock, ocfByCorpCode, 'd');
  const ranked = rankByOcfToPrice(attached);
  assert.deepEqual(ranked.map((c) => c.Code), ['B', 'C', 'A']);
  assert.equal(ranked[0].rank, 1);
});
