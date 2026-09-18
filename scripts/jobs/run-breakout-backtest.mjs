#!/usr/bin/env node
// run-breakout-backtest.mjs — 돌파매매(추세추종) 전략 백테스트 실행(2026-09-12,
// 오너 확정 규칙: 52주신고가+변동성확장(VCP)+RS+시가총액1조원 진입, -8% 손절+
// 1R/2R/3R 트레일링+피라미딩 청산). run-quant-backtest.mjs(월간 리밸런싱)와 달리
// 이 전략은 매일 신호를 확인해야 해서 별도 시뮬레이터(breakout-simulator.mjs)를 쓴다.
//
// 사용법:
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-12
//   node scripts/jobs/run-breakout-backtest.mjs --from=2023-01-01 --to=2025-01-01 --initialCapital=40000000
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-12 --useBettingUnits=true  # 점진적 배팅(유닛) 사이징 비교(2026-09-14)
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-14 --rsMethod=short  # RS 다구간 방법론 비교(2026-09-15, 아래 RS_METHOD_PERIODS 참고)
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-14 --rsAnchorSmoothDays=5  # RS 앵커 스무딩 비교(2026-09-15, 오너 재지적 — 다구간 블렌드와는 다른 접근)
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-19 --useVolumeConfirmation=true  # 거래량 확인(평균 1.5배) 조건 비교(2026-09-19)
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-19 --useAdaptiveStop=true  # ATR 가변손절(4%/8%) 비교(2026-09-19)
//   node scripts/jobs/run-breakout-backtest.mjs --from=2014-01-01 --to=2026-09-19 --minRs=5  # RS 절대문턱 상향 비교(2026-09-19, 기본 0)
import { buildCandidatePool } from '../lib/historical-universe.mjs';
import { loadPriceSeriesBatch } from '../lib/breakout-price-series.mjs';
import { cacheIndexPrices, loadIndexSeries } from '../lib/index-price-cache.mjs';
import { runBreakoutBacktest, LIQUIDITY_FLOOR_WON } from '../lib/breakout-simulator.mjs';
import {
  MARKET_CAP_FLOOR_WON, RS_ANCHOR_SMOOTH_DAYS, MIN_RELATIVE_STRENGTH, VOLUME_CONFIRMATION_MULTIPLIER,
} from '../lib/breakout-factor.mjs';
import { RISK_PER_TRADE_PCT } from '../lib/breakout-risk.mjs';
import { buildComparisonReport } from '../lib/benchmark-comparison.mjs';
import { cumulativeReturns } from '../lib/walk-forward-simulator.mjs';
import { maxDrawdown, annualizedReturn } from '../lib/stats.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRADING_DAYS_PER_YEAR = 252;

// RS 방법론 비교용(2026-09-15, 오너 지적 — 단일 60거래일 시점 비교는 그 하루
// 급등락에 취약, 여러 구간을 섞은 게 나은지 실측 필요). 모듈 최상단으로(2026-09-15
// 코드리뷰 LOW 지적 — 원래 main() 내부에 있어 매 실행마다 재생성되고 테스트/import가
// 불가능했음):
// - baseline: 기존(단일 60거래일 시점, rsPeriods 미지정 — RS_LOOKBACK_DAYS 사용)
// - baselineMulti: **통제군**(코드리뷰 HIGH 지적으로 신설) — 중심 룩백을 60일로
//   고정한 채 54/60/66일 3구간 균등가중만 섞는다. baseline과의 차이가 "다구간
//   평균화 자체의 효과"만 순수하게 분리해 보여준다(룩백 길이 변화와 뒤섞이지 않음).
// - short: 1/3/6개월 균등가중(21/63/126거래일, 21일/개월 관례)
// - long: IBD RS Rating 스타일 3/6/9/12개월(63/126/189/252거래일, 최근분기 40%+
//   나머지 20%씩)
const RS_METHOD_PERIODS = {
  baselineMulti: [{ days: 54, weight: 1 }, { days: 60, weight: 1 }, { days: 66, weight: 1 }],
  short: [{ days: 21, weight: 1 }, { days: 63, weight: 1 }, { days: 126, weight: 1 }],
  long: [{ days: 63, weight: 0.4 }, { days: 126, weight: 0.2 }, { days: 189, weight: 0.2 }, { days: 252, weight: 0.2 }],
};
// allow-list를 RS_METHOD_PERIODS 키에서 자동 도출(2026-09-15 코드리뷰 LOW 지적 —
// 방법론 추가 시 이 배열과 위 맵 양쪽을 따로 고쳐야 하면, 한쪽만 고쳤을 때 "allow-list는
// 통과하는데 실제론 undefined→baseline으로 조용히 동작"하는 함정이 있었다).
const RS_METHODS = ['baseline', ...Object.keys(RS_METHOD_PERIODS)];

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
  // ??(2026-09-15 코드리뷰 LOW 지적 — ||였으면 --rsMethod=(빈 문자열)가 조용히
  // baseline으로 흡수됨, useBettingUnits처럼 명시값 오타는 즉시 걸려야 함)
  const rsMethod = args.rsMethod ?? 'baseline';
  if (!RS_METHODS.includes(rsMethod)) {
    throw new Error(`--rsMethod는 ${RS_METHODS.join('|')}만 허용(받은 값: "${rsMethod}")`);
  }
  const rsPeriods = RS_METHOD_PERIODS[rsMethod];
  // RS 앵커 스무딩 비교용(2026-09-15, 오너 재지적 — "60일 전 단일시점 대신 5일
  // 정도 롤링평균이 어떤지" — 위 rsMethod(다구간 블렌드, 서로 다른 길이의 구간을
  // 섞음)와는 다른 접근으로, 구간 길이(60일)는 그대로 두고 비교 기준점 한 곳만
  // 그 날짜 근처 며칠 평균으로 대체한다). rsMethod가 baseline이 아닐 때 같이
  // 넘기면 breakout-factor.mjs의 computeBreakoutEntrySignal이 rsPeriods를 우선
  // 적용해 이 값이 조용히 무시되므로(no-silent-fallback 원칙 위반) 즉시 throw.
  let rsAnchorSmoothDays;
  if (args.rsAnchorSmoothDays != null) {
    rsAnchorSmoothDays = Number(args.rsAnchorSmoothDays);
    if (!Number.isInteger(rsAnchorSmoothDays) || rsAnchorSmoothDays < 1) {
      throw new Error(`--rsAnchorSmoothDays는 1 이상의 정수여야 함(받은 값: "${args.rsAnchorSmoothDays}")`);
    }
    if (rsMethod !== 'baseline') {
      throw new Error(`--rsAnchorSmoothDays는 --rsMethod=baseline(또는 미지정)과만 같이 쓸 수 있음 — rsPeriods가 우선 적용돼 조용히 무시되는 조합은 금지(받은 rsMethod: "${rsMethod}")`);
    }
  }
  // ⚠️ 실전과의 조용한 괴리 경고(2026-09-15 코드리뷰 HIGH 지적 — daily-breakout-
  // signal-scan.mjs는 RS_ANCHOR_SMOOTH_DAYS를 항상 씀. 이 CLI의 baseline 기본값은
  // "순수 단일시점"이라는 이 프로젝트 문서 전체의 기존 의미를 깨지 않기 위해 그대로
  // 두되 — 무플래그 실행이 실전과 다른 설정을 검증 중임을 눈에 띄게 알린다).
  if (rsAnchorSmoothDays == null) {
    console.error(`⚠️ 참고: 실전(daily-breakout-signal-scan.mjs)은 현재 RS 앵커 ${RS_ANCHOR_SMOOTH_DAYS}일 스무딩을 씁니다 — 이 실행은 --rsAnchorSmoothDays를 안 줘서 순수 단일시점으로 도는 중이라 실전과 다른 설정입니다. 실전과 맞추려면 --rsAnchorSmoothDays=${RS_ANCHOR_SMOOTH_DAYS} 추가.`);
  }
  // 2026-09-14 점진적 배팅(유닛) 사이징 비교용 — breakout-unit-tracker.mjs. 오타·오입력이
  // 조용히 false로 처리되지 않도록(2026-09-14 코드리뷰 지적) true/false 외 값은 즉시 throw.
  if (args.useBettingUnits != null && args.useBettingUnits !== 'true' && args.useBettingUnits !== 'false') {
    throw new Error(`--useBettingUnits는 true|false만 허용(받은 값: "${args.useBettingUnits}")`);
  }
  const useBettingUnits = args.useBettingUnits === 'true';

  // 2026-09-19 오너 지시 3종 비교용(거래량 확인·ATR 가변손절·RS 절대문턱) — 동일하게
  // 오타·오입력이 조용히 흡수되지 않도록 검증.
  if (args.useVolumeConfirmation != null && args.useVolumeConfirmation !== 'true' && args.useVolumeConfirmation !== 'false') {
    throw new Error(`--useVolumeConfirmation은 true|false만 허용(받은 값: "${args.useVolumeConfirmation}")`);
  }
  const useVolumeConfirmation = args.useVolumeConfirmation === 'true';

  if (args.useAdaptiveStop != null && args.useAdaptiveStop !== 'true' && args.useAdaptiveStop !== 'false') {
    throw new Error(`--useAdaptiveStop은 true|false만 허용(받은 값: "${args.useAdaptiveStop}")`);
  }
  const useAdaptiveStop = args.useAdaptiveStop === 'true';

  // ATR 손절폭 선택 임계값 재조정용(2026-09-19) — 기본 백테스트(임계값 4.0%)가
  // baseline보다 성과가 나빠(좁은 손절이 Max2%룰과 결합해 2배 사이징을 받는
  // 포지션이 31%나 돼 분산이 무너짐, 코드리뷰 지적) 더 높은 문턱으로 재검증하려는
  // 목적. 지정 안 하면 breakout-risk.mjs ATR_STOP_THRESHOLD_PCT 기본값(4.0) 그대로.
  let adaptiveStopThresholdPct;
  if (args.adaptiveStopThreshold != null) {
    if (args.adaptiveStopThreshold === '') throw new Error('--adaptiveStopThreshold에 빈 값을 줄 수 없음');
    adaptiveStopThresholdPct = Number(args.adaptiveStopThreshold);
    if (!Number.isFinite(adaptiveStopThresholdPct) || adaptiveStopThresholdPct <= 0) {
      throw new Error(`--adaptiveStopThreshold는 양의 유한한 숫자여야 함(받은 값: "${args.adaptiveStopThreshold}")`);
    }
    if (!useAdaptiveStop) {
      throw new Error('--adaptiveStopThreshold는 --useAdaptiveStop=true와만 같이 쓸 수 있음 — 조용히 무시되는 조합 금지');
    }
  }

  // 코드리뷰 LOW 지적(2026-09-19) — `--minRs=`(빈 문자열)이 `Number('')===0`이라
  // 조용히 문턱 0으로 흡수될 뻔했다(오타·잘림 입력이 "문턱 없음"으로 둔갑) —
  // --rsAnchorSmoothDays처럼 빈 값도 명시적으로 막는다.
  let minRelativeStrength;
  if (args.minRs != null) {
    if (args.minRs === '') throw new Error('--minRs에 빈 값을 줄 수 없음(문턱을 지정하려면 숫자를 넘길 것)');
    minRelativeStrength = Number(args.minRs);
    if (!Number.isFinite(minRelativeStrength)) {
      throw new Error(`--minRs는 유한한 숫자여야 함(받은 값: "${args.minRs}")`);
    }
  }
  // 백테스트 무플래그 실행이 실전과 조용히 어긋나는 걸 경고(코드리뷰 MEDIUM 지적,
  // 2026-09-19) — rsAnchorSmoothDays 경고와 동일 원칙(2026-09-15 선례). 실전은
  // 2026-09-19부터 거래량 확인 ON + RS≥MIN_RELATIVE_STRENGTH로 확정 배선됨.
  if (!useVolumeConfirmation) {
    console.error(`⚠️ 참고: 실전(daily-breakout-signal-scan.mjs)은 거래량 확인(평균 ${VOLUME_CONFIRMATION_MULTIPLIER}배 이상)을 켜고 돕니다 — 이 실행은 --useVolumeConfirmation을 안 줘서 꺼진 채로 도는 중이라 실전과 다른 설정입니다. 실전과 맞추려면 --useVolumeConfirmation=true 추가.`);
  }
  if (minRelativeStrength == null) {
    console.error(`⚠️ 참고: 실전은 RS 절대문턱 ${MIN_RELATIVE_STRENGTH}를 씁니다 — 이 실행은 --minRs를 안 줘서 문턱 0으로 도는 중이라 실전과 다른 설정입니다. 실전과 맞추려면 --minRs=${MIN_RELATIVE_STRENGTH} 추가.`);
  }

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
  await cacheIndexPrices('KOSPI', fromDate, toDate);
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
  const benchmarkCloses = fullBenchmark.closes.slice(startIdx, endIdx + 1); // 리포트(전략 vs 벤치마크 수익률 비교)용 — 트리밍 유지
  console.error(`  거래일 ${tradingDates.length}개(${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})`);

  // ⚠️ 시뮬레이터에는 트리밍 안 한 fullBenchmark를 그대로 넘긴다(2026-09-15 코드리뷰
  // HIGH 지적 — 트리밍된 benchmarkSeries를 넘기면 RS 룩백(computeRelativeStrength가
  // benchmarkCloses.length<lookbackDays+1이면 null)이 창 앞부분에서 구조적으로
  // 미달돼 진입이 0건이 되는데, 이 워밍업 손실 기간이 방법론마다 다르다(baseline
  // 60거래일 vs short 최대126일 vs long 최대252일≈1년) — arm마다 실효 시작일이
  // 최대 1년까지 달라져 "다구간 평균이 도움되는가"라는 질문에 "시작 시점이 다르다"는
  // 별개 효과가 섞여버린다. fullBenchmark는 캐시에 있는 만큼(현재 2014-01-02~) 항상
  // fromDate보다 앞선 이력을 포함하므로(단, --from을 캐시 최초일자보다 이르게 주면
  // 그 구간만큼은 물리적 워밍업 한계 — 실제 데이터가 없어 못 채움) 워밍업으로 쓰인다.
  // tradingDates(시뮬레이션 창 정의)는 그대로 fromDate~toDate로 트리밍된 값.
  // rsAnchorSmoothDays=1은 수학적으로 baseline과 완전 동일(no-op) — 별개 조건처럼
  // 라벨링되면 오독 소지가 있어(2026-09-15 코드리뷰 LOW 지적) 그 경우만 명시.
  const rsLabel = rsAnchorSmoothDays == null
    ? rsMethod
    : rsAnchorSmoothDays === 1
      ? `${rsMethod}+앵커1일평균(=baseline과 동일)`
      : `${rsMethod}+앵커${rsAnchorSmoothDays}일평균`;
  console.error(`[4/4] 일별 시뮬레이션 실행 중(진입: 52주신고가+변동성확장(${consolidationMethod})+RS(${rsLabel})${minRelativeStrength != null ? `≥${minRelativeStrength}` : ''}${useVolumeConfirmation ? '+거래량확인' : ''}+시총${(marketCapFloor / 1e12).toFixed(1)}조원, 청산: ${useAdaptiveStop ? 'ATR가변손절(4%/8%)' : '-8%고정'}+R배수트레일링+3R부분익절)...`);
  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries: fullBenchmark, tradingDates, initialCapital,
    marketCapFloor, riskPerTradePct: RISK_PER_TRADE_PCT, consolidationMethod, entryTiming, useBettingUnits, rsPeriods, rsAnchorSmoothDays,
    minRelativeStrength, useVolumeConfirmation, useAdaptiveStop, adaptiveStopThresholdPct,
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
  // 손익비(2026-09-19 신설 — 오너 목표 "승률 30%+·손익비 1:3+"를 CLI 출력에서 바로
  // 확인 가능하게). |평균손실|이 0이거나 손실 거래가 없으면(전부 익절) 비율 정의 불가 — null.
  const profitLossRatio = avgWinPct != null && avgLossPct != null && avgLossPct !== 0
    ? Math.abs(avgWinPct / avgLossPct)
    : null;

  console.log(JSON.stringify({
    period: { from: fromDate, to: toDate, tradingDays: tradingDates.length },
    params: {
      initialCapital, marketCapFloor, liquidityFloor: LIQUIDITY_FLOOR_WON, riskPerTradePct: RISK_PER_TRADE_PCT,
      consolidationMethod, entryTiming, useBettingUnits, rsMethod,
      rsPeriods: rsPeriods ?? null, // rsMethod 정의(RS_METHOD_PERIODS)가 나중에 바뀌어도 이 결과가 어떤 파라미터였는지 재현 가능하도록 같이 기록(2026-09-15 코드리뷰 LOW 지적)
      rsAnchorSmoothDays: rsAnchorSmoothDays ?? null,
      minRelativeStrength: minRelativeStrength ?? null,
      useVolumeConfirmation, useAdaptiveStop, adaptiveStopThresholdPct: adaptiveStopThresholdPct ?? null,
    },
    tradeStats: {
      totalTrades: closedTrades.length,
      partialProfitTrades,
      winRate,
      avgWinPct,
      avgLossPct,
      profitLossRatio,
      openPositionsAtEnd: result.openPositionsAtEnd,
      skippedNoOpenPrice: result.skippedNoOpenPrice,
      finalBettingUnits: result.finalBettingUnits,
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
