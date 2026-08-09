#!/usr/bin/env node
// diagnose-backtest.mjs — Phase 10 백테스트 결과 원인 분해 진단(카이로스 요청,
// 2026-08-09). run-quant-backtest.mjs가 이미 실행된 뒤, 그 결과("벤치마크 대비
// 열위")가 (a) 동일가중 10종목이라는 구조 자체 때문인지 (b) OCF/P 팩터 선택 자체
// 때문인지 분리하고, MDD 구간을 어떤 종목들이 주도했는지 확인한다. 새 팩터·조합을
// 시도하는 게 아니라 이미 나온 결과를 뜯어보는 사후분석 — run-quant-backtest.mjs와
// 같은 파이프라인을 재사용하되 순위 기준만 rankByMarketCap으로 바꿔서 대조군을 만든다.
//
// 사용법: node scripts/jobs/diagnose-backtest.mjs --from=2016-07-01 --to=2026-08-09
import { loadEnv } from '../lib/auth.mjs';
import { buildCandidatePool, fetchPricesAt, computePointInTimeUniverse, fetchLiquidityAt, attachLiquidity } from '../lib/historical-universe.mjs';
import { filterByLiquidity } from '../lib/quant-universe.mjs';
import { krCorpCodeByStock } from '../lib/instruments.mjs';
import { ocfAt } from '../lib/ocf-history-cache.mjs';
import { attachHistoricalOcf } from '../lib/historical-ranking.mjs';
import { rankByOcfToPrice } from '../lib/quant-factor.mjs';
import { rankByMarketCap } from '../lib/marketcap-ranking.mjs';
import { simulateWalkForward, extractReturns, cumulativeReturns } from '../lib/walk-forward-simulator.mjs';
import { cacheIndexPrices, indexPricesAt } from '../lib/index-price-cache.mjs';
import { buildComparisonReport } from '../lib/benchmark-comparison.mjs';
import { maxDrawdown, annualizedReturn } from '../lib/stats.mjs';
import { findMaxDrawdownWindow, computeDrawdownContributions } from '../lib/drawdown-attribution.mjs';

loadEnv();

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function monthlyDates(startDate, endDate) {
  const dates = [];
  const s = new Date(`${startDate}T00:00:00.000Z`);
  let d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return dates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromDate = args.from || '2016-07-01';
  const toDate = args.to || new Date().toISOString().slice(0, 10);
  const buyRank = args.buyRank != null ? Number(args.buyRank) : 10;
  const sellRank = args.sellRank != null ? Number(args.sellRank) : 20;
  const apiKey = process.env.DART_API_KEY;

  const dates = monthlyDates(fromDate, toDate);
  console.error(`[준비] 재계산 시점 ${dates.length}개(${dates[0]} ~ ${dates[dates.length - 1]})`);

  const pool = buildCandidatePool();
  const prices = fetchPricesAt(pool.map((c) => c.code), dates);
  const corpCodeByStock = {};
  for (const c of pool) corpCodeByStock[c.code] = krCorpCodeByStock(c.code, apiKey);

  // 매달 유동성통과 후보를 한 번만 구해서 OCF/P·시총 두 랭킹에 공용으로 쓴다(같은
  // 유니버스·같은 유동성필터라야 "순위 기준만 다르다"는 대조군 조건이 성립함).
  const passedByDate = {};
  for (const date of dates) {
    const ranked = computePointInTimeUniverse(pool, prices, date, { nKospi: 200, nKosdaq: 150 });
    const liq = fetchLiquidityAt(ranked.map((c) => c.code), [date]);
    const withLiq = attachLiquidity(ranked, liq, date);
    passedByDate[date] = filterByLiquidity(withLiq);
  }
  console.error('[1/3] 유니버스·유동성 통과 후보 산출 완료');

  const ocfRankingsByDate = {};
  const marketcapRankingsByDate = {};
  for (const date of dates) {
    const passed = passedByDate[date];
    const corpCodes = [...new Set(passed.map((c) => corpCodeByStock[c.code]).filter(Boolean))];
    const ocfByCorpCode = ocfAt(corpCodes, [date]);
    const attached = attachHistoricalOcf(passed, corpCodeByStock, ocfByCorpCode, date);
    ocfRankingsByDate[date] = rankByOcfToPrice(attached);
    marketcapRankingsByDate[date] = rankByMarketCap(passed.map((c) => ({ ...c, Code: c.code, Marcap: c.marcap })));
  }
  console.error('[2/3] OCF/P 랭킹 + 시가총액 랭킹(대조군) 산출 완료');

  const ocfSim = simulateWalkForward(ocfRankingsByDate, prices, { buyRank, sellRank });
  const marketcapSim = simulateWalkForward(marketcapRankingsByDate, prices, { buyRank, sellRank });
  console.error('[3/3] 두 시뮬레이션 완료');

  cacheIndexPrices('KOSPI', dates[0], dates[dates.length - 1]);
  const kospiPrices = indexPricesAt('KOSPI', dates);

  function pairWithBenchmark(sim) {
    const paired = [];
    for (let i = 1; i < dates.length; i++) {
      const strategyReturn = sim[i].periodReturn;
      const p0 = kospiPrices[dates[i - 1]], p1 = kospiPrices[dates[i]];
      const benchmarkReturn = (p0 != null && p1 != null && p0 > 0) ? (p1 - p0) / p0 : null;
      if (strategyReturn != null && benchmarkReturn != null) paired.push({ strategyReturn, benchmarkReturn });
    }
    return paired;
  }

  // ── 진단 1: 동일가중 시총상위10 vs OCF/P — "구조(동일가중) 문제인지 팩터 선택
  // 문제인지" 분리. 둘 다 같은 유니버스·같은 버퍼존·같은 동일가중 사이징이고 순위
  // 기준만 다르다.
  const ocfPaired = pairWithBenchmark(ocfSim);
  const mcPaired = pairWithBenchmark(marketcapSim);
  const ocfReport = buildComparisonReport(ocfPaired.map((p) => p.strategyReturn), ocfPaired.map((p) => p.benchmarkReturn), { periodsPerYear: 12 });
  const mcReport = buildComparisonReport(mcPaired.map((p) => p.strategyReturn), mcPaired.map((p) => p.benchmarkReturn), { periodsPerYear: 12 });

  const ocfCum = cumulativeReturns(extractReturns(ocfSim));
  const mcCum = cumulativeReturns(extractReturns(marketcapSim));
  const years = ocfPaired.length / 12;

  // ── 진단 2: OCF/P 전략의 최대낙폭 구간을 어떤 종목이 주도했는지.
  const dd = findMaxDrawdownWindow(ocfCum);
  const contributions = computeDrawdownContributions(ocfSim, prices, dd.peakIndex, dd.troughIndex);

  console.log(JSON.stringify({
    diagnosis1_equalWeightVsFactor: {
      description: '같은 유니버스·같은 버퍼존·같은 동일가중, 순위기준만 다름(OCF/P vs 시가총액상위)',
      ocfFactor: {
        cumulativeReturn: ocfCum[ocfCum.length - 1] - 1,
        annualizedReturn: annualizedReturn(ocfCum, years),
        maxDrawdown: maxDrawdown(ocfCum),
        vsKospi: ocfReport,
      },
      marketCapControl: {
        cumulativeReturn: mcCum[mcCum.length - 1] - 1,
        annualizedReturn: annualizedReturn(mcCum, years),
        maxDrawdown: maxDrawdown(mcCum),
        vsKospi: mcReport,
      },
    },
    diagnosis2_drawdownAttribution: {
      description: 'OCF/P 전략의 최대낙폭 구간(고점→저점) 동안 각 종목의 그 구간 내 누적수익률',
      window: { peakDate: ocfSim[dd.peakIndex].date, troughDate: ocfSim[dd.troughIndex].date, drawdown: dd.drawdown },
      worstContributors: contributions.slice(0, 15),
    },
  }, null, 2));
  console.error('\n※ 이 보고는 원인 분해 사실까지만 — 해석·재검토 판단은 Zeus/Themis+오너 몫.');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
