#!/usr/bin/env node
// breakout-watchlist-preview.mjs — 돌파매매 전략(퀀트 트랙) 아침 워치리스트
// 프리뷰(2026-09-14 신설, 오너 요청 — "내일 아침에 체결 발생할지 예상해서
// 후보군 텔레그램 푸시").
//
// ⚠️ 이건 실제 신호판정(daily-breakout-signal-scan.mjs)이 아니다 — 그 잡은
// 장마감 직후 "오늘 종가"를 라이브로 조회해 52주신고가·변동성확장·RS 세 조건을
// 전부 확인해야 신호로 인정한다. 이 스크립트는 아침(장 시작 전)에 돌기 때문에
// 오늘 종가를 알 수 없다 — 대신 **전일까지의 캐시 데이터만으로 "52주 고점에
// 얼마나 가까운지"**를 계산해 참고용 워치리스트를 보여준다. 오늘 실제로 돌파가
// 일어날지는 순수히 오늘 하루의 가격 움직임에 달려있어 이 스크립트로 예측할 수
// 없다 — "이미 근접한 종목이 몇 개인지"를 보여주는 사전 관찰 목적.
//
// ⚠️ update-breakout-price-cache.mjs가 먼저 성공해야 의미 있다(개별종목 캐시가
// 전일까지 최신이어야 "전일 종가"가 정확함) — 이 스크립트 자체는 캐시를 갱신하지
// 않는다(관심사 분리, daily-breakout-signal-scan.mjs와 동일 원칙).
//
// 사용법: node scripts/tools/breakout-watchlist-preview.mjs [--dry-run] [--top=15]
import { buildCandidatePool } from '../lib/historical-universe.mjs';
import { loadPriceSeriesBatch, findLatestDateStrictlyBefore, findIndexAtOrBefore } from '../lib/breakout-price-series.mjs';
import { cacheIndexPrices, loadIndexSeries } from '../lib/index-price-cache.mjs';
import { computeDailyCandidates } from '../lib/breakout-simulator.mjs';
import { is52WeekHighBreakout, computeRelativeStrength, MARKET_CAP_FLOOR_WON } from '../lib/breakout-factor.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
const RS_LOOKBACK_DAYS = 60; // breakout-simulator.mjs/daily-breakout-signal-scan.mjs와 동일 기준
const HIGH_LOOKBACK_DAYS = 252;
const DEFAULT_TOP = 15;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

// 순수함수 — 후보 1개의 "52주 고점에 얼마나 가까운지" 계산. 데이터 부족이면 null
// (추정 안 함). is52WeekHighBreakout을 그대로 재사용(라이브 신호스캔과 동일한
// priorHigh 계산 로직 — 별도 재구현 안 함, 값만 다르게 해석).
export function computeProximity({ closes, highs, benchmarkCloses }) {
  const lastClose = closes[closes.length - 1];
  const week52 = is52WeekHighBreakout(highs, lastClose, { lookbackDays: HIGH_LOOKBACK_DAYS });
  if (!(week52.priorHigh > 0)) return null;
  const distancePct = (lastClose / week52.priorHigh - 1) * 100;
  const relativeStrength = computeRelativeStrength(closes, benchmarkCloses, RS_LOOKBACK_DAYS);
  return { distancePct, relativeStrength, alreadyAboveHigh: week52.pass, priorHigh: week52.priorHigh, lastClose };
}

// 순수함수 — proximity 있는 후보만, distancePct 내림차순(0에 가까울수록/양수일수록
// 고점에 근접) 상위 top개. 테스트 가능하도록 main()에서 분리.
export function rankByProximity(candidates, top = DEFAULT_TOP) {
  return candidates
    .filter((c) => c.proximity)
    .sort((a, b) => b.proximity.distancePct - a.proximity.distancePct)
    .slice(0, top);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);
  const top = args.top ? Number(args.top) : DEFAULT_TOP;

  console.error('[1/3] 후보풀+캐시 시세 로드 중...');
  const pool = buildCandidatePool();
  const codes = pool.map((c) => c.code);
  const seriesByCode = loadPriceSeriesBatch(codes);

  console.error('[2/3] 코스피 지수 캐시 로드 중...');
  await cacheIndexPrices('KOSPI', '2014-01-01', todayKST());
  const benchmarkSeries = loadIndexSeries('KOSPI');
  if (!benchmarkSeries) throw new Error('코스피 지수 캐시 로드 실패');
  const cachedDate = findLatestDateStrictlyBefore(benchmarkSeries.dates, todayKST());
  if (!cachedDate) throw new Error('코스피 지수 캐시에 오늘 이전 거래일 데이터가 없음');

  const candidates = computeDailyCandidates(pool, seriesByCode, cachedDate, { marketCapFloor: MARKET_CAP_FLOOR_WON });
  console.error(`  기준일 ${cachedDate} — 시가총액+유동성 통과 후보 ${candidates.length}종목`);

  const benchIdx = findIndexAtOrBefore(benchmarkSeries.dates, cachedDate);
  const benchmarkCloses = benchIdx >= 0 ? benchmarkSeries.closes.slice(0, benchIdx + 1) : [];

  console.error('[3/3] 52주 고점 근접도 계산 중...');
  const withProximity = candidates.map((cand) => {
    const series = seriesByCode[cand.code];
    const idx = findIndexAtOrBefore(series.dates, cachedDate);
    const closes = series.closes.slice(0, idx + 1);
    const highs = series.highs.slice(0, idx + 1);
    return { code: cand.code, name: cand.name, proximity: computeProximity({ closes, highs, benchmarkCloses }) };
  });

  const ranked = rankByProximity(withProximity, top);
  const facts = ranked.map((c) => {
    const p = c.proximity;
    const rsLabel = p.relativeStrength != null ? `${p.relativeStrength >= 0 ? '+' : ''}${p.relativeStrength.toFixed(1)}%p` : 'N/A';
    const tag = p.alreadyAboveHigh ? ' [전일 종가 이미 신고가 돌파]' : '';
    return `${c.name}(${c.code}) — 52주 고점 대비 ${p.distancePct.toFixed(1)}%, RS ${rsLabel}${tag}`;
  });

  console.log(`기준일 ${cachedDate} 종가 기준 근접 상위 ${ranked.length}종목:`);
  facts.forEach((f) => console.log(`  ${f}`));

  if (!dryRun) {
    await sendTelegram(formatFactsMessage({
      departmentLabel: DEPARTMENT_LABEL,
      tag: '안내',
      facts: [
        `아침 워치리스트(참고용) — 기준일 ${cachedDate} 종가 기준 52주 고점에 가장 근접한 상위 ${ranked.length}종목`,
        ...facts,
        '실제 돌파 여부(변동성확장·오늘 종가)는 오늘 장중 가격에 달려있어 예측 불가 — 실제 신호는 장마감 직후 별도 확인',
      ],
    }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ breakout-watchlist-preview 오류:', e.message); process.exit(1); });
}
