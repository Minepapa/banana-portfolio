#!/usr/bin/env node
// breakout-watchlist-preview.mjs — 돌파매매 전략(퀀트 트랙) 아침 워치리스트
// 프리뷰(2026-09-14 신설, 오너 요청 — "내일 아침에 체결 발생할지 예상해서
// 후보군 텔레그램 푸시").
//
// ⚠️ 이건 실제 신호판정(daily-breakout-signal-scan.mjs)이 아니다 — 그 잡은
// 장마감 직후 "오늘 종가"를 라이브로 조회해 52주신고가·변동성확장(VCP)·RS 세
// 조건을 전부 확인해야 신호로 인정한다. 이 스크립트는 아침(장 시작 전)에 돌기
// 때문에 오늘 종가를 알 수 없다 — 대신 **전일까지의 캐시 데이터만으로 계산
// 가능한 만큼**만 보여준다: 52주 고점까지의 거리(완전 계산), VCP "준비도"(변동성
// 수축이 이미 형성돼 있는지 — 오늘 상승률은 모르므로 절반만, computeVcpReadiness
// 참고, 2026-09-15 추가), RS(완전 계산). 오늘 실제로 돌파가 일어날지는 순수히
// 오늘 하루의 가격 움직임(특히 VCP의 나머지 절반인 당일 상승률)에 달려있어 이
// 스크립트로 예측할 수 없다 — "이미 근접·준비된 종목이 몇 개인지"를 보여주는
// 사전 관찰 목적.
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
import { is52WeekHighBreakout, computeRelativeStrength, computeVcpReadiness, RS_LOOKBACK_DAYS, MARKET_CAP_FLOOR_WON } from '../lib/breakout-factor.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
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

// 순수함수 — 후보 1개의 "52주 고점에 얼마나 가까운지" + "VCP 준비도"(2026-09-15
// 추가, 오너 요청 — "다음부터 워치리스트는 VCP 조건까지 3개 조건 다 넣어서
// 보여주고") + RS 계산. 데이터 부족이면 null(추정 안 함). is52WeekHighBreakout·
// computeVcpReadiness를 그대로 재사용(라이브 신호스캔과 동일한 계산 로직 — 별도
// 재구현 안 함, 값만 다르게 해석). ⚠️ VCP는 "준비도"까지만 — 오늘 종가를 몰라
// changePct(당일 상승률)는 확인 불가하므로 완전 판정(isVolatilityExpansionBreakout)
// 이 아니다(computeVcpReadiness 자체 주석 참고).
export function computeProximity({ closes, highs, benchmarkCloses }) {
  const lastClose = closes[closes.length - 1];
  const week52 = is52WeekHighBreakout(highs, lastClose, { lookbackDays: HIGH_LOOKBACK_DAYS });
  if (!(week52.priorHigh > 0)) return null;
  const distancePct = (lastClose / week52.priorHigh - 1) * 100;
  const relativeStrength = computeRelativeStrength(closes, benchmarkCloses, RS_LOOKBACK_DAYS);
  const vcp = computeVcpReadiness(closes);
  return {
    distancePct, relativeStrength, alreadyAboveHigh: week52.pass, priorHigh: week52.priorHigh, lastClose,
    vcpReady: vcp?.ready ?? null,
    vcpVolRatio: vcp ? vcp.currentVol / vcp.minVol : null, // 1.0에 가까울수록 여유 없이 간신히 준비됨(경계 케이스 구분용)
  };
}

// 순수함수 — proximity 있는 후보만, distancePct 내림차순(0에 가까울수록/양수일수록
// 고점에 근접) 상위 top개. 테스트 가능하도록 main()에서 분리.
export function rankByProximity(candidates, top = DEFAULT_TOP) {
  return candidates
    .filter((c) => c.proximity)
    .sort((a, b) => b.proximity.distancePct - a.proximity.distancePct)
    .slice(0, top);
}

// 순수함수 — 텔레그램 메시지 한 줄로 렌더링(2026-09-15 코드리뷰 MEDIUM/HIGH 지적
// 반영 — main() 안에 있으면 문구가 telegram-format-compliance류 가드 없이 테스트
// 0건으로 남는다, 이 프로젝트가 텔레그램 메시지 포맷 회귀를 7차례 겪은 전례와
// 같은 패턴). ⚠️ VCP 라벨은 일부러 "준비됨"처럼 판정형 단어를 쓰지 않는다 —
// computeVcpReadiness는 VCP 조건(변동성수축 AND 당일상승률≥3%)의 절반(변동성수축)
// 만 확인 가능하고 나머지 절반(당일상승률)은 이 스크립트가 도는 장 시작 전 시점엔
// 알 수 없다. "준비됨"만 쓰면 옆의 완전계산 필드(52주거리·RS)와 시각적으로
// 구분이 안 돼, 오너가 "이미 VCP 조건을 만족한 종목"으로 오독할 위험이 있다
// (코드리뷰 HIGH 지적 — 실제 매매판단에 쓰이는 메시지라 신중하게 처리).
export function formatWatchlistFact(c) {
  const p = c.proximity;
  const rsLabel = p.relativeStrength != null ? `${p.relativeStrength >= 0 ? '+' : ''}${p.relativeStrength.toFixed(1)}%p` : 'N/A';
  let vcpLabel;
  if (p.vcpReady == null) vcpLabel = 'VCP N/A';
  else if (p.vcpReady) vcpLabel = `VCP 수축완료(여유 ${p.vcpVolRatio.toFixed(2)}배, 당일상승률 미확인)`;
  else vcpLabel = 'VCP 수축미형성';
  const tag = p.alreadyAboveHigh ? ' [전일 종가 이미 신고가 돌파]' : '';
  return `${c.name}(${c.code}) — 52주 고점 대비 ${p.distancePct.toFixed(1)}%, ${vcpLabel}, RS ${rsLabel}${tag}`;
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
  const facts = ranked.map(formatWatchlistFact);

  console.log(`기준일 ${cachedDate} 종가 기준 근접 상위 ${ranked.length}종목:`);
  facts.forEach((f) => console.log(`  ${f}`));

  if (!dryRun) {
    await sendTelegram(formatFactsMessage({
      departmentLabel: DEPARTMENT_LABEL,
      tag: '안내',
      facts: [
        `아침 워치리스트(참고용) — 기준일 ${cachedDate} 종가 기준 52주 고점에 가장 근접한 상위 ${ranked.length}종목`,
        'VCP는 절반만 확인 가능(변동성수축 여부) — 나머지 절반(당일 상승률 3%↑)은 오늘 장중 가격에 달려있어 이 메시지로는 알 수 없음. "수축완료"가 곧 매수신호 확정이 아님',
        ...facts,
        '실제 돌파 여부(당일 상승률·오늘 종가)는 오늘 장중 가격에 달려있어 예측 불가 — 실제 신호는 장마감 직후 별도 확인',
      ],
    }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ breakout-watchlist-preview 오류:', e.message); process.exit(1); });
}
