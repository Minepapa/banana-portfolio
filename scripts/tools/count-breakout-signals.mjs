#!/usr/bin/env node
// 일회성 분석 스크립트(2026-09-19, 오너 요청) — 2025~2026 기간에 카이로스 실전
// 매수조건(daily-breakout-signal-scan.mjs와 동일 파라미터)을 만족한 (종목,날짜)
// 쌍이 몇 번이나 있었는지 센다. 슬롯(최대 10종목) 제약 없이 매일 전 후보에 대해
// 신호를 판정 — 백테스트 엔진(runBreakoutBacktest)은 슬롯이 차면 그날 신호평가
// 자체를 스킵하므로 "조건을 만족한 원시 횟수"를 구할 수 없음(daily-breakout-
// signal-scan.mjs의 슬롯 사전체크와 동일 이유 — remainingSlots<=0이면 그날은
// 라이브 조회 자체를 안 함).
//
// 사용법: node scripts/tools/count-breakout-signals.mjs [--from=2025-01-01] [--to=2026-09-19]
import { buildCandidatePool } from '../lib/historical-universe.mjs';
import { loadPriceSeriesBatch, findIndexAtOrBefore } from '../lib/breakout-price-series.mjs';
import { cacheIndexPrices, loadIndexSeries } from '../lib/index-price-cache.mjs';
import { computeDailyCandidates, LIQUIDITY_FLOOR_WON } from '../lib/breakout-simulator.mjs';
import {
  computeBreakoutEntrySignal, MARKET_CAP_FLOOR_WON, RS_ANCHOR_SMOOTH_DAYS, MIN_RELATIVE_STRENGTH,
} from '../lib/breakout-factor.mjs';

const args = process.argv.slice(2);
const FROM = args.find((a) => a.startsWith('--from='))?.split('=')[1] ?? '2025-01-01';
const TO = args.find((a) => a.startsWith('--to='))?.split('=')[1] ?? '2026-09-19';

async function main() {
  console.error('[1/3] 후보풀+가격시계열 로드...');
  const pool = buildCandidatePool();
  const codes = pool.map((c) => c.code);
  const seriesByCode = loadPriceSeriesBatch(codes);

  console.error('[2/3] 코스피 벤치마크 로드...');
  await cacheIndexPrices('KOSPI', FROM, TO);
  const benchmarkSeries = loadIndexSeries('KOSPI');
  if (!benchmarkSeries) throw new Error('코스피 캐시 로드 실패');

  const tradingDates = benchmarkSeries.dates.filter((d) => d >= FROM && d <= TO);
  console.error(`[3/3] ${tradingDates.length}거래일 × 전종목 신호판정 중(슬롯 제약 없이)...`);

  const ENTRY_SIGNAL_OPTS = {
    marketCapFloor: MARKET_CAP_FLOOR_WON, rsAnchorSmoothDays: RS_ANCHOR_SMOOTH_DAYS, minRelativeStrength: MIN_RELATIVE_STRENGTH,
  };

  const hits = []; // { date, code, name, rs }
  for (const date of tradingDates) {
    const benchIdx = findIndexAtOrBefore(benchmarkSeries.dates, date);
    const benchmarkCloses = benchIdx >= 0 ? benchmarkSeries.closes.slice(0, benchIdx + 1) : [];
    const candidates = computeDailyCandidates(pool, seriesByCode, date, { marketCapFloor: MARKET_CAP_FLOOR_WON, liquidityFloor: LIQUIDITY_FLOOR_WON });
    for (const cand of candidates) {
      const series = seriesByCode[cand.code];
      const closes = series.closes.slice(0, cand.idx + 1);
      const highs = series.highs.slice(0, cand.idx + 1);
      const lows = series.lows.slice(0, cand.idx + 1);
      const volumes = series.volumes.slice(0, cand.idx); // 오늘 제외
      const todayVolume = series.volumes[cand.idx];
      const signal = computeBreakoutEntrySignal(
        { closes, highs, lows, benchmarkCloses, marcap: cand.marcap, volumes, todayVolume },
        ENTRY_SIGNAL_OPTS,
      );
      if (signal.pass) hits.push({ date, code: cand.code, name: cand.name, rs: signal.relativeStrength });
    }
  }

  const byYear = {};
  for (const h of hits) {
    const y = h.date.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + 1;
  }
  const distinctDays = new Set(hits.map((h) => h.date));
  const byYearDays = {};
  for (const d of distinctDays) {
    const y = d.slice(0, 4);
    byYearDays[y] = (byYearDays[y] || 0) + 1;
  }

  console.log(JSON.stringify({
    period: { from: FROM, to: TO, tradingDays: tradingDates.length },
    totalSignalHits: hits.length,
    byYearSignalHits: byYear,
    distinctSignalDays: distinctDays.size,
    byYearSignalDays: byYearDays,
    allHits: hits,
  }, null, 2));
}

main().catch((e) => { console.error('❌', e.message, e.stack); process.exit(1); });
