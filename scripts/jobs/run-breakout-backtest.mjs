#!/usr/bin/env node
// run-breakout-backtest.mjs — 돌파매매(추세추종) 전략 백테스트 실행(2026-09-12,
// 오너 확정 규칙: 52주신고가+변동성확장(VCP)+RS+시가총액1조원 진입, -8% 손절+
// 1R/2R/3R 트레일링+피라미딩 청산). run-quant-backtest.mjs(월간 리밸런싱)와 달리
// 이 전략은 매일 신호를 확인해야 해서 별도 시뮬레이터(breakout-simulator.mjs)를 쓴다.
//
// 사용법:
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-12
//   node scripts/jobs/run-breakout-backtest.mjs --from=2023-01-01 --to=2025-01-01 --initialCapital=40000000
import { buildCandidatePool } from '../lib/historical-universe.mjs';
import { loadPriceSeriesBatch } from '../lib/breakout-price-series.mjs';
import { cacheIndexPrices, loadIndexSeries } from '../lib/index-price-cache.mjs';
import { runBreakoutBacktest, LIQUIDITY_FLOOR_WON } from '../lib/breakout-simulator.mjs';
import { MARKET_CAP_FLOOR_WON } from '../lib/breakout-factor.mjs';
import { RISK_PER_TRADE_PCT } from '../lib/breakout-risk.mjs';
import { buildComparisonReport } from '../lib/benchmark-comparison.mjs';
import { cumulativeReturns } from '../lib/walk-forward-simulator.mjs';
import { maxDrawdown, annualizedReturn } from '../lib/stats.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRADING_DAYS_PER_YEAR = 252;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromDate = args.from || '2014-01-01';
  const toDate = args.to || new Date().toISOString().slice(0, 10);
  const initialCapital = args.initialCapital != null ? Number(args.initialCapital) : 40_000_000;
  const marketCapFloor = args.marketCapFloor != null ? Number(args.marketCapFloor) : MARKET_CAP_FLOOR_WON;
  const consolidationMethod = args.consolidationMethod === 'range' ? 'range' : 'stddev'; // 2026-09-13 VCP 정의 비교용
  const entryTiming = args.entryTiming === 'sameDayClose' ? 'sameDayClose' : 'nextDayOpen'; // 2026-09-13 장후시간외 우선체결 비교용

  if (!DATE_RE.test(fromDate)) throw new Error(`--from 형식 오류(YYYY-MM-DD 필요): ${fromDate}`);
  if (!DATE_RE.test(toDate)) throw new Error(`--to 형식 오류(YYYY-MM-DD 필요): ${toDate}`);
  if (fromDate > toDate) throw new Error(`--from(${fromDate})이 --to(${toDate})보다 나중일 수 없음`);

  console.error(`[1/4] 후보풀 조회 중...`);
  const pool = buildCandidatePool();
  console.error(`  후보풀 ${pool.length}종목`);

  console.error(`[2/4] 종목별 가격 시계열 로드 중(캐시, historical-universe.py 재수집 완료 전제)...`);
  const codes = pool.map((c) => c.code);
  const seriesByCode = loadPriceSeriesBatch(codes);
  const withData = Object.values(seriesByCode).filter(Boolean).length;
  console.error(`  ${withData}/${pool.length}종목 시세 확보(나머지는 캐시 없음/빈 결과)`);

  console.error(`[3/4] 코스피 지수 벤치마크 확보 중...`);
  cacheIndexPrices('KOSPI', fromDate, toDate);
  const fullBenchmark = loadIndexSeries('KOSPI');
  if (!fullBenchmark) throw new Error('코스피 지수 캐시 로드 실패');
  const startIdx = fullBenchmark.dates.findIndex((d) => d >= fromDate);
  const endIdx = (() => {
    let last = -1;
    for (let i = 0; i < fullBenchmark.dates.length; i++) if (fullBenchmark.dates[i] <= toDate) last = i;
    return last;
  })();
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`코스피 지수 데이터가 요청 구간(${fromDate}~${toDate})을 못 덮음`);
  const tradingDates = fullBenchmark.dates.slice(startIdx, endIdx + 1);
  const benchmarkCloses = fullBenchmark.closes.slice(startIdx, endIdx + 1);
  const benchmarkSeries = { dates: tradingDates, closes: benchmarkCloses };
  console.error(`  거래일 ${tradingDates.length}개(${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})`);

  console.error(`[4/4] 일별 시뮬레이션 실행 중(진입: 52주신고가+변동성확장(${consolidationMethod})+RS+시총${(marketCapFloor / 1e12).toFixed(1)}조원, 청산: -8%+R배수트레일링+3R부분익절)...`);
  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates, initialCapital,
    marketCapFloor, riskPerTradePct: RISK_PER_TRADE_PCT, consolidationMethod, entryTiming,
  });
  console.error(`  거래 ${result.trades.length}건, 최종 현금 ${Math.round(result.finalCapital).toLocaleString()}원(시가 데이터 없어 예약체결 스킵 ${result.skippedNoOpenPrice}건)`);

  const strategyReturns = [];
  const benchmarkReturns = [];
  for (let i = 1; i < result.equityCurve.length; i++) {
    const prevEq = result.equityCurve[i - 1].totalEquity;
    const currEq = result.equityCurve[i].totalEquity;
    strategyReturns.push(prevEq > 0 ? currEq / prevEq - 1 : 0);
    const p0 = benchmarkCloses[i - 1];
    const p1 = benchmarkCloses[i];
    benchmarkReturns.push(p0 > 0 ? p1 / p0 - 1 : 0);
  }

  const comparison = buildComparisonReport(strategyReturns, benchmarkReturns, { periodsPerYear: TRADING_DAYS_PER_YEAR });
  const strategyCumulative = cumulativeReturns(strategyReturns);
  const benchmarkCumulative = cumulativeReturns(benchmarkReturns);
  const years = strategyReturns.length / TRADING_DAYS_PER_YEAR;

  const closedTrades = result.trades;
  const wins = closedTrades.filter((t) => t.pnlWon > 0);
  const winRate = closedTrades.length ? wins.length / closedTrades.length : null;
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.pnlWon / t.investedWon, 0) / wins.length : null;
  const losses = closedTrades.filter((t) => t.pnlWon <= 0);
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnlWon / t.investedWon, 0) / losses.length : null;
  const partialProfitTrades = closedTrades.filter((t) => t.reason === '3R 부분익절(50%)').length;

  console.log(JSON.stringify({
    period: { from: fromDate, to: toDate, tradingDays: tradingDates.length },
    params: { initialCapital, marketCapFloor, liquidityFloor: LIQUIDITY_FLOOR_WON, riskPerTradePct: RISK_PER_TRADE_PCT, consolidationMethod, entryTiming },
    tradeStats: {
      totalTrades: closedTrades.length,
      partialProfitTrades,
      winRate,
      avgWinPct,
      avgLossPct,
      openPositionsAtEnd: result.openPositionsAtEnd,
      skippedNoOpenPrice: result.skippedNoOpenPrice,
    },
    comparison,
    strategy: {
      cumulativeReturn: strategyCumulative[strategyCumulative.length - 1] - 1,
      annualizedReturn: annualizedReturn(strategyCumulative, years),
      maxDrawdown: maxDrawdown(strategyCumulative),
    },
    benchmark: {
      cumulativeReturn: benchmarkCumulative[benchmarkCumulative.length - 1] - 1,
      annualizedReturn: annualizedReturn(benchmarkCumulative, years),
      maxDrawdown: maxDrawdown(benchmarkCumulative),
    },
  }, null, 2));
  console.error('\n※ 이 보고는 벤치마크 대비 상대비교 사실까지만 — 통과/재검토 판단은 Zeus/Themis+오너 몫.');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message, e.stack); process.exit(1); });
