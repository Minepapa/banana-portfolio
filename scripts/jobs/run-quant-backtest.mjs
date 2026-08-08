#!/usr/bin/env node
// run-quant-backtest.mjs — Phase 10 실제 워크포워드 백테스트 실행(구현계획서 Phase 10
// 완료기준: "월말 재계산→리컨스티튜션... 전 과정 재현 가능"). 매달 재계산 시점마다
// 유니버스 재구성→유동성 필터→OCF 조회→OCF/P 랭킹→워크포워드 시뮬레이션까지 전부
// 이미 만들어진 순수함수를 순서대로 이어붙이기만 한다(새 판단·계산 로직 없음 — Node는
// 이미 구축된 파이프라인을 그대로 실행할 뿐).
//
// ⚠️ 사전조건 2가지(안 갖추면 조용히 텅 빈/왜곡된 결과가 나옴 — 코드리뷰 지적,
// 2026-08-08):
//   1) 종목 시세: historical-universe.mjs cachePrices()로 candidatePool 전체가 이미
//      캐싱돼 있어야 함(이 스크립트는 fetchPricesAt만 부르고 캐싱 자체는 안 함).
//   2) OCF 이력: scripts/lib/ocf-history-cache.mjs cacheOcfHistory()로 미리 채워둔
//      뒤 돌리는 게 전제 — OpenDart 일일 호출한도가 있어 전체 구간(2014~2026, 약
//      146개월)을 이 스크립트가 직접 매달 조회하면 수천~수만 회 호출이 필요하다.
//      ocfAt()은 캐시가 없는 corpCode엔 조용히 null만 반환하고 API를 새로 부르지
//      않는다. 단, krCorpCodeByStock()의 법인코드 캐시가 없거나 30일 이상 오래됐으면
//      OpenDart corpCode.xml(전체 상장사 목록, 재무제표 조회와는 다른 엔드포인트)을
//      1회 호출할 수 있다 — "이 스크립트가 OpenDart를 절대 안 부른다"는 아니고
//      "재무제표 대량조회는 안 한다"가 정확한 표현.
//
// 사용법:
//   node scripts/jobs/run-quant-backtest.mjs --from=2014-07-01 --to=2026-07-31
//   node scripts/jobs/run-quant-backtest.mjs --from=2023-06-01 --to=2025-06-01  # 파일럿 검증용
//   node scripts/jobs/run-quant-backtest.mjs --from=2014-07-01 --to=2026-07-31 --buyRank=10 --sellRank=20
import { loadEnv } from '../lib/auth.mjs';
import { buildCandidatePool, fetchPricesAt, computePointInTimeUniverse, fetchLiquidityAt, attachLiquidity } from '../lib/historical-universe.mjs';
import { filterByLiquidity } from '../lib/quant-universe.mjs';
import { krCorpCodeByStock } from '../lib/instruments.mjs';
import { ocfAt } from '../lib/ocf-history-cache.mjs';
import { attachHistoricalOcf } from '../lib/historical-ranking.mjs';
import { rankByOcfToPrice } from '../lib/quant-factor.mjs';
import { simulateWalkForward, extractReturns, cumulativeReturns, countDataGaps } from '../lib/walk-forward-simulator.mjs';
import { cacheIndexPrices, indexPricesAt } from '../lib/index-price-cache.mjs';
import { buildComparisonReport } from '../lib/benchmark-comparison.mjs';
import { maxDrawdown, annualizedReturn } from '../lib/stats.mjs';

loadEnv();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 키를 대소문자 섞어 받는다(--buyRank처럼) — 원래 [a-z]+ 만 허용해 camelCase 키가
// 조용히 통째로 드롭되던 버그(코드리뷰 지적, 2026-08-08 — --buyRank/--sellRank를
// 줘도 항상 기본값 10/20으로 돌아가는데 오류도 안 났었음).
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// startDate ~ endDate(포함) 사이 매월 1일 — historical-universe.mjs 재계산 시점 컨벤션과
// 동일(월초 기준, computePointInTimeUniverse가 "그 날짜 이하 최근 거래일"로 알아서
// 가장 가까운 실제 거래일을 찾아줌). startDate가 월초가 아니어도 첫 항목부터 그 달의
// 1일로 정규화한다(코드리뷰 지적 — 원래는 startDate를 그대로 첫 항목에 썼음).
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
  const fromDate = args.from || '2014-07-01';
  const toDate = args.to || new Date().toISOString().slice(0, 10);
  const buyRank = args.buyRank != null ? Number(args.buyRank) : 10;
  const sellRank = args.sellRank != null ? Number(args.sellRank) : 20;
  const apiKey = process.env.DART_API_KEY;

  // 인자 검증 — 실행 시간이 수 시간 걸릴 수 있는 작업이라, 잘못된 인자를 조용히
  // 빈/왜곡된 결과로 흘려보내는 대신 시작하자마자 실패시킨다(코드리뷰 지적, 2026-08-08:
  // 원래는 "2014-13-01" 같은 잘못된 날짜를 넣으면 재계산 시점이 조용히 0개가 되고,
  // 끝까지 다 돈 뒤에야 텅 빈 결과가 나왔음 — 실행 몇 시간을 날리고서야 실수를 알게 됨).
  if (!DATE_RE.test(fromDate) || Number.isNaN(new Date(fromDate).getTime())) {
    throw new Error(`--from 형식 오류(YYYY-MM-DD 필요): ${fromDate}`);
  }
  if (!DATE_RE.test(toDate) || Number.isNaN(new Date(toDate).getTime())) {
    throw new Error(`--to 형식 오류(YYYY-MM-DD 필요): ${toDate}`);
  }
  if (fromDate > toDate) throw new Error(`--from(${fromDate})이 --to(${toDate})보다 나중일 수 없음`);
  if (!(Number.isInteger(buyRank) && buyRank > 0)) throw new Error(`--buyRank는 양의 정수여야 함: ${args.buyRank}`);
  if (!(Number.isInteger(sellRank) && sellRank > buyRank)) throw new Error(`--sellRank는 --buyRank(${buyRank})보다 큰 정수여야 함: ${args.sellRank}`);

  const dates = monthlyDates(fromDate, toDate);
  if (!dates.length) throw new Error(`재계산 시점이 0개 — --from/--to 범위를 확인할 것(${fromDate} ~ ${toDate})`);
  console.error(`[1/5] 재계산 시점 ${dates.length}개(${dates[0]} ~ ${dates[dates.length - 1]}), buyRank=${buyRank} sellRank=${sellRank}`);

  const pool = buildCandidatePool();
  const codes = pool.map((c) => c.code);
  const prices = fetchPricesAt(codes, dates);
  console.error(`[2/5] 후보풀 ${pool.length}종목, 시세 로드 완료`);

  // 종목코드→법인코드는 시간과 무관(과거·현재 항상 같은 회사) — 매달 다시 조회할
  // 이유가 없다. 원래는 월별 루프 안에서 매번 다시 조회했는데, loadCorpCodeCache가
  // 메모이즈 없이 캐시 파일 전체를 매번 다시 파싱해서 전체 실행(수백 개월)에 걸쳐
  // 상당한 낭비였다(코드리뷰 지적, 2026-08-08) — 풀 전체에 대해 한 번만 계산.
  const corpCodeByStock = {};
  for (const c of pool) corpCodeByStock[c.code] = krCorpCodeByStock(c.code, apiKey);

  const rankingsByDate = {};
  // 월별 데이터 감쇠(법인코드 매칭 실패·OCF 미확인으로 랭킹이 얼마나 줄었는지) 추적 —
  // 원래는 stderr 진행 로그에만 평균값이 찍히고 최종 JSON엔 전혀 안 남아서, 이 결과를
  // 읽는 사람이 "어느 달이 소수 종목만으로 계산됐는지" 알 방법이 없었다(코드리뷰 지적,
  // 2026-08-08 — 게이트 판정에 쓰일 숫자인데 그 근거의 신뢰도를 확인할 길이 없었음).
  const monthlyStats = [];
  for (const [i, date] of dates.entries()) {
    const ranked = computePointInTimeUniverse(pool, prices, date, { nKospi: 200, nKosdaq: 150 });
    const rankedCodes = ranked.map((c) => c.code);
    const liq = fetchLiquidityAt(rankedCodes, [date]);
    const withLiq = attachLiquidity(ranked, liq, date);
    const passed = filterByLiquidity(withLiq);

    const corpCodes = [...new Set(passed.map((c) => corpCodeByStock[c.code]).filter(Boolean))];
    const ocfByCorpCode = ocfAt(corpCodes, [date]);

    const attached = attachHistoricalOcf(passed, corpCodeByStock, ocfByCorpCode, date);
    const ranking = rankByOcfToPrice(attached);
    rankingsByDate[date] = ranking;
    monthlyStats.push({ date, universeSize: ranked.length, liquidityPassed: passed.length, ranked: ranking.length });
    if ((i + 1) % 12 === 0) console.error(`  ...${i + 1}/${dates.length}개월 랭킹 산출`);
  }
  const rankedCounts = monthlyStats.map((s) => s.ranked).sort((a, b) => a - b);
  const median = rankedCounts[Math.floor(rankedCounts.length / 2)];
  console.error(`[3/5] 전체 ${dates.length}개월 랭킹 산출 완료(중앙값 ${median}종목/월)`);

  const sim = simulateWalkForward(rankingsByDate, prices, { buyRank, sellRank });
  const gaps = countDataGaps(sim);
  console.error(`[4/5] 워크포워드 시뮬레이션 완료(데이터결측 ${gaps}구간)`);

  // 전략·벤치마크(코스피) 수익률을 같은 구간끼리만 정확히 대응시킨다 — 둘 중 하나라도
  // 결측인 구간은 통째로 제외(추정 안 함, buildComparisonReport의 "길이 대응" 전제와
  // 정합 — 서로 다른 구간의 값을 억지로 짝지으면 안 됨). 지수는 dates[0]보다 며칠
  // 앞서서(비영업일 대비 여유) 받아둔다 — 딱 dates[0]부터만 받으면 그날이 주말·공휴일일
  // 때 "그 이하 최근 거래일"이 하나도 없어 첫 구간이 비대칭적으로 빠질 수 있다(코드리뷰
  // 지적, 2026-08-08).
  const indexBufferStart = new Date(new Date(`${dates[0]}T00:00:00.000Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  cacheIndexPrices('KOSPI', indexBufferStart, dates[dates.length - 1]);
  const kospiPrices = indexPricesAt('KOSPI', dates);
  const paired = [];
  for (let i = 1; i < dates.length; i++) {
    // sim은 rankingsByDate 키(=dates)를 정렬해 만들어지므로 sim[i].date는 항상
    // dates[i]와 같아야 한다 — 이 정렬 불변식이 깨지면 전략·벤치마크 구간이 조용히
    // 어긋나는(다른 달끼리 비교되는) 가장 위험한 실패라 방어적으로 확인한다(코드리뷰
    // 지적, 2026-08-08).
    if (sim[i].date !== dates[i]) throw new Error(`구간 정렬 불변식 깨짐: sim[${i}].date(${sim[i].date}) !== dates[${i}](${dates[i]})`);
    const strategyReturn = sim[i].periodReturn;
    const p0 = kospiPrices[dates[i - 1]], p1 = kospiPrices[dates[i]];
    const benchmarkReturn = (p0 != null && p1 != null && p0 > 0) ? (p1 - p0) / p0 : null;
    if (strategyReturn != null && benchmarkReturn != null) paired.push({ date: dates[i], strategyReturn, benchmarkReturn });
  }
  const strategyReturns = paired.map((p) => p.strategyReturn);
  const benchmarkReturns = paired.map((p) => p.benchmarkReturn);
  const report = buildComparisonReport(strategyReturns, benchmarkReturns, { periodsPerYear: 12 });
  console.error(`[5/5] 벤치마크(코스피) 대비 비교 완료(대응구간 ${paired.length}개)`);

  const strategyCumulative = cumulativeReturns(strategyReturns);
  const benchmarkCumulative = cumulativeReturns(benchmarkReturns);
  const years = paired.length / 12;

  console.log(JSON.stringify({
    period: { from: fromDate, to: toDate, months: dates.length, dataGaps: gaps, pairedPeriods: paired.length },
    params: { buyRank, sellRank },
    dataQuality: {
      minRankedPerMonth: rankedCounts[0],
      medianRankedPerMonth: median,
      maxRankedPerMonth: rankedCounts[rankedCounts.length - 1],
      monthsBelow30Ranked: monthlyStats.filter((s) => s.ranked < 30).length,
      monthlyStats, // 달별 유니버스·유동성통과·랭킹산출 상세(신뢰도 재검토용)
    },
    comparison: report,
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

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
