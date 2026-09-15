#!/usr/bin/env node
// daily-breakout-signal-scan.mjs — 돌파매매 전략(퀀트 트랙) 일별 신호스캔. "오늘 어느
// 종목을 살지"를 실제로 판단하는 유일한 지점 — place-breakout-entry-order.mjs는 이
// 잡이 넘겨준 종목 하나하나를 발주만 담당한다(관심사 분리, 2026-09-13 설계).
//
// ⚠️ 승인 없이 자동 발주함(오너 확정, 2026-09-13 — "자동체결+사후통보", 장후시간외
// 15:40~16:00 20분 창이 너무 좁아 매번 텔레그램 승인을 거치면 그 창을 놓칠 위험이
// 크다는 이유). **이 원칙은 카이로스(이 전략)에만 해당 — 자산분배 트랙(Athena)은
// 여전히 텔레그램 승인을 거친다**, 혼동 금지.
//
// 실행 시각(15:32 KST 제안, 아직 launchd 미배선): KRX 정규장 마감(15:30)+약간의
// 버퍼 뒤, 장후시간외(15:40) 시작 전. 265종목(2026-09-13 실측 — 시가총액1조원+
// 유동성 필터 통과 수, 매일 변동)×STAGGER_MS(800ms, update-holdings-prices.mjs와
// 동일한 2026-07 실측 확정값 재사용)≈3.5분 소요, 여유 있게 끝남.
//
// 데이터 소스 설계(핵심): 52주신고가·변동성수축 임계값은 전일까지의 캐시된 일별
// 시세(loadPriceSeriesBatch)로 미리 계산 가능 — 그래서 시가총액+유동성 사전필터
// (computeDailyCandidates)까지는 라이브 데이터가 전혀 필요 없다. 라이브 데이터가
// 필요한 건 "오늘 종가"뿐(KRX 일별 배치데이터는 당일 장중엔 아직 없음) — KIS
// 실시간 현재가(getKrQuote)를 장마감 직후 "오늘 종가"로 근사한다(intraday-market-
// move-monitor.mjs가 이미 코스피 실시간지수를 같은 방식으로 쓰는 선례 재사용,
// Knowledge/API/KIS.md 참고). 요일(토/일)만 걸러내고 KRX 평일휴장(공휴일)은 별도
// 체크 안 함 — 그런 날은 라이브가=전일종가라 등락률 조건(3%p 이상)이 저절로
// 불통과되므로 필요 없음.
//
// ⚠️ 하루 1회 실행 보장(코드리뷰 HIGH 지적, 2026-09-13) — State/BreakoutScanRuns로
// 재실행 시 이중매수를 방지한다(--force로 무시 가능, 테스트용). --dry-run은 실주문이
// 없어 이 잠금 대상이 아니다(반복 실행 자유).
//
// 사용법: node scripts/jobs/daily-breakout-signal-scan.mjs [--dry-run] [--force] [--max-entries=N]
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildCandidatePool } from '../lib/historical-universe.mjs';
import { loadPriceSeriesBatch, findLatestDateStrictlyBefore, findIndexAtOrBefore } from '../lib/breakout-price-series.mjs';
import { cacheIndexPrices, loadIndexSeries } from '../lib/index-price-cache.mjs';
import { computeDailyCandidates } from '../lib/breakout-simulator.mjs';
import { computeBreakoutEntrySignal, MARKET_CAP_FLOOR_WON } from '../lib/breakout-factor.mjs';
import { computePositionSize, RISK_PER_TRADE_PCT, MAX_CONCURRENT_POSITIONS } from '../lib/breakout-risk.mjs';
import { parseBreakoutPosition, findOpenPositions } from '../lib/breakout-position-vault.mjs';
import {
  hasKisCredentials, loadKisCredentials, loadQuantAccount, getKisToken, getKrQuote, getKrIndexQuote, getAccountBalance,
} from '../lib/kis.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
// KIS 레이트리밋(EGW00201) 실측 기반 — update-holdings-prices.mjs·realtime-quotes.mjs와
// 동일 수치(2026-07 재실측 확정값 그대로 재사용, 별도 튜닝 근거 없음).
const STAGGER_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 사전필터 기준일(cachedDate) 시점 데이터를 실제로 가진 상장종목 비율이 이 아래로
// 떨어지면 개별종목 캐시 갱신(update-breakout-price-cache.mjs)이 정상적으로 안 돈
// 것으로 의심하고 경고한다(2026-09-14 신설, 코드리뷰 HIGH 지적 반영 — 최초엔 "며칠
// 전인지"(달력일)로 쟀는데 그 기준일 자체가 항상 라이브로 최신 유지되는 캐시라
// 이 사고를 하나도 못 잡는다는 지적으로 교체). 평시엔 사실상 100%에 가까워야 정상
// (당일 거래정지·신규상장 직후 등 소수 예외만 빠짐) — 2026-09-14 사고 당일 이
// 비율은 0%였다.
const MIN_CACHE_COVERAGE_RATIO = 0.8;

function loadOpenPositionCodes() {
  const dir = VAULT_PATHS.state.breakoutPositions;
  if (!existsSync(dir)) return new Set();
  const contents = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8'));
  const positions = contents.map((c) => parseBreakoutPosition(c));
  return new Set(findOpenPositions(positions).map((p) => p.code));
}

// 순수함수 — 오늘 이 잡을 실제로 돌려도(=실주문을 낼 수 있는 상태로) 되는지.
// monthly-macro-tilt-proposal.mjs shouldRunThisMonth와 동일 원칙(하루 1회, 주말
// 스킵) — 코드리뷰 HIGH 지적(2026-09-13) 재발방지: 재실행이 같은 신호를 또
// 발주하는 이중매수를 막는다. --dry-run은 실주문이 없어 이 체크 대상이 아니다.
// ⚠️ 요일·날짜 판정 둘 다 date.getDay()/getFullYear() 같은 "시스템 로컬 타임존"
// 함수 대신 UTC+9h 수동계산(todayKSTLabel과 동일 방식)만 쓴다 — 이 프로세스가
// KST가 아닌 타임존에서 돌 가능성(CI 등)을 배제하지 않기 위함.
export function shouldRunToday(date, lastRunDayLabel) {
  const kst = new Date(date.getTime() + 9 * 3600_000);
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return todayKSTLabel(date) !== lastRunDayLabel;
}
function todayKSTLabel(date) {
  const kst = new Date(date.getTime() + 9 * 3600_000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

function readLastRunDay(stateFile) {
  if (!existsSync(stateFile)) return null;
  return parseFrontmatter(readFileSync(stateFile, 'utf8')).day ?? null;
}
function writeLastRunDay(stateFile, day) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeAtomic(stateFile, buildFrontmatter({ day, updatedAt: new Date().toISOString() }));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const maxEntriesArg = Number(process.argv.find((a) => a.startsWith('--max-entries='))?.split('=')[1]);
  const maxEntries = Number.isInteger(maxEntriesArg) && maxEntriesArg > 0 ? maxEntriesArg : null;

  // 하루 1회 실행 보장(코드리뷰 HIGH 지적, 2026-09-13) — 실주문이 나갈 수 있는
  // 비-dry-run 경로에서만 잠근다. 무엇을 하기도 전에 가장 먼저 선점(claim)해야
  // 거의 동시에 두 번 실행돼도(수동 재실행 등) 둘 다 통과하는 경쟁조건을 막는다
  // (execute-quant-proposal.mjs의 recordExecutedOrder 선점 원칙과 동일).
  if (!dryRun) {
    const lastRunDay = readLastRunDay(VAULT_PATHS.state.breakoutScanRuns);
    if (!force && !shouldRunToday(new Date(), lastRunDay)) {
      console.log(`ℹ️ 오늘(${todayKST()}) 이미 실행됐거나 주말 — 중복 실행 방지로 중단(--force로 무시 가능)`);
      return;
    }
    writeLastRunDay(VAULT_PATHS.state.breakoutScanRuns, todayKST());
  }

  console.error('[1/5] 후보풀+캐시 시세 로드 중...');
  const pool = buildCandidatePool();
  const codes = pool.map((c) => c.code);
  const seriesByCode = loadPriceSeriesBatch(codes);

  console.error('[2/5] 코스피 지수 캐시 로드 중...');
  await cacheIndexPrices('KOSPI', '2014-01-01', todayKST());
  const benchmarkSeries = loadIndexSeries('KOSPI');
  if (!benchmarkSeries) throw new Error('코스피 지수 캐시 로드 실패');

  // 2026-09-14 수정(실전 첫 테스트에서 발견한 실사고) — 사전필터 기준일은 "오늘"이면
  // 절대 안 된다(위 "데이터 소스 설계" 절 — "전일까지의 캐시 데이터"가 설계 전제,
  // 오늘 종가는 뒤에서 라이브로 따로 조회). 예전엔 benchmarkSeries의 절대 최신
  // 날짜를 그대로 썼는데, 코스피 지수 캐시는 라이브 소스(cacheIndexPrices)라 장마감
  // 직후 이미 오늘자를 포함해버려서, 매일 아침 전일까지만 갱신되는 개별종목 캐시
  // (historical-prices/*.csv)와 날짜가 구조적으로 어긋나 전 종목이 탈락하고 있었다
  // (코드리뷰 HIGH 지적, 2026-09-13에 경고 로그까지만 심어뒀던 걸 이번에 실제 수정 —
  // 상세 경위는 Log/Implementation/2026-09-13-돌파매매-백테스트엔진-구현.md "실전
  // 첫 테스트 결과" 절 참고). findLatestDateStrictlyBefore로 "오늘보다 전"만 기준일
  // 후보로 명시적으로 강제한다.
  const cachedDate = findLatestDateStrictlyBefore(benchmarkSeries.dates, todayKST());
  if (!cachedDate) throw new Error('코스피 지수 캐시에 오늘 이전 거래일 데이터가 없음');

  // 개별종목 캐시 정합률 체크(2026-09-14 코드리뷰 HIGH 지적으로 교체) — 처음엔
  // "cachedDate가 오늘보다 며칠 전인지"(달력일)로 staleness를 쟀는데, cachedDate는
  // 코스피 지수 캐시(cacheIndexPrices가 매 실행 오늘까지 라이브로 재조회 — 절대
  // 안 낡음) 기준이라 정작 낡을 수 있는 개별종목 캐시 상태와는 무관했다 — "개별
  // 종목 캐시 갱신 잡이 하루만 빠져도" 2026-09-14와 같은 사고가 재발하는데 이
  // 체크로는 하나도 못 잡는다는 지적(실측 재현됨). 대신 cachedDate 시점 데이터를
  // 실제로 가진 종목 비율을 직접 잰다 — 이게 이 사고를 그대로 재현·검출한다
  // (2026-09-14 사고 당일 기준 이 비율은 0%였을 것).
  const liveCandidates = pool.filter((p) => !p.delistingDate || p.delistingDate > cachedDate);
  const haveCachedDate = liveCandidates.filter((p) => {
    const s = seriesByCode[p.code];
    if (!s) return false;
    const i = findIndexAtOrBefore(s.dates, cachedDate);
    return i >= 0 && s.dates[i] === cachedDate;
  }).length;
  const cacheCoverageRatio = liveCandidates.length ? haveCachedDate / liveCandidates.length : 0;
  if (cacheCoverageRatio < MIN_CACHE_COVERAGE_RATIO) {
    const msg = `개별종목 시세 캐시 정합률 ${(cacheCoverageRatio * 100).toFixed(0)}%(기준일 ${cachedDate} 데이터 보유 ${haveCachedDate}/${liveCandidates.length}종목) — update-breakout-price-cache.mjs가 최근에 정상적으로 안 돈 것으로 의심됨. 신호 결과를 신뢰하지 말 것.`;
    console.error(`⚠️ ${msg}`);
    if (!dryRun) {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '경고',
        body: `<b>돌파매매 일별 신호스캔 — 시세 캐시 정합률 이상</b>\n${msg}`,
      }));
    }
  }

  console.error(`[3/5] 시가총액+유동성 사전필터 중(기준일 ${cachedDate}, 캐시 정합률 ${(cacheCoverageRatio * 100).toFixed(0)}%)...`);
  const candidates = computeDailyCandidates(pool, seriesByCode, cachedDate, { marketCapFloor: MARKET_CAP_FLOOR_WON });
  console.error(`  통과 후보 ${candidates.length}종목`);

  const heldCodes = loadOpenPositionCodes();
  const openCount = heldCodes.size;
  const remainingSlots = MAX_CONCURRENT_POSITIONS - openCount;
  console.error(`  현재 보유 ${openCount}종목, 남은 슬롯 ${remainingSlots}`);
  if (remainingSlots <= 0) {
    console.log('ℹ️ 슬롯이 이미 다 찼음 — 라이브 조회 없이 종료(API 절약)');
    return;
  }
  const freeCandidates = candidates.filter((c) => !heldCodes.has(c.code));

  if (!hasKisCredentials()) { console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵'); return; }
  const { appkey: quoteAppkey, appsecret: quoteAppsecret } = loadKisCredentials();
  const quoteToken = await getKisToken({ appkey: quoteAppkey, appsecret: quoteAppsecret });

  console.error(`[4/5] 라이브 종가 조회+신호 판정 중(${freeCandidates.length}종목, 약 ${(freeCandidates.length * STAGGER_MS / 1000).toFixed(0)}초 소요 예상)...`);
  let benchmarkToday;
  try {
    ({ price: benchmarkToday } = await getKrIndexQuote({ token: quoteToken, appkey: quoteAppkey, appsecret: quoteAppsecret, iscd: '0001' }));
  } catch (e) {
    console.error(`❌ 코스피 실시간지수 조회 실패 — 신호판정 불가, 중단: ${e.message}`);
    if (!dryRun) {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '경고',
        body: `<b>돌파매매 일별 신호스캔 중단 — 코스피 실시간지수 조회 실패</b>\n${e.message}\n오늘은 신호판정 자체를 못 했습니다(발주 없음).`,
      }));
    }
    return;
  }
  const benchmarkCloses = [...benchmarkSeries.closes, benchmarkToday];

  const passed = [];
  for (const cand of freeCandidates) {
    const series = seriesByCode[cand.code];
    let livePrice;
    try {
      ({ price: livePrice } = await getKrQuote({ token: quoteToken, appkey: quoteAppkey, appsecret: quoteAppsecret, code: cand.code }));
    } catch (e) {
      console.error(`  ⚠️ ${cand.code} 현재가 조회 실패(${e.message}) — 이 종목만 스킵`);
      await sleep(STAGGER_MS);
      continue;
    }
    // getKrQuote(parseQuoteResponse)는 이미 price<=0이면 throw하므로(위 catch가
    // 그 경로를 덮음) 여기 도달하는 livePrice는 항상 양수다 — 코드리뷰 LOW 지적
    // (2026-09-13)으로 있으나 마나 한 재검증 가드를 없애고 그대로 진행.
    const closes = [...series.closes.slice(0, cand.idx + 1), livePrice];
    const highs = [...series.highs.slice(0, cand.idx + 1), livePrice]; // 오늘의 고가 placeholder — is52WeekHighBreakout은 이 마지막 원소를 안 씀(priorHighs가 직전까지만 봄)
    const lows = [...series.lows.slice(0, cand.idx + 1), livePrice]; // consolidationMethod 기본값(stddev)에서는 안 쓰임
    const signal = computeBreakoutEntrySignal(
      { closes, highs, lows, benchmarkCloses, marcap: cand.marcap },
      { marketCapFloor: MARKET_CAP_FLOOR_WON },
    );
    if (signal.pass) {
      console.error(`  🟢 ${cand.name}(${cand.code}) 신호 통과 — RS=${signal.relativeStrength.toFixed(1)}`);
      passed.push({ code: cand.code, name: cand.name, relativeStrength: signal.relativeStrength });
    }
    await sleep(STAGGER_MS);
  }
  console.error(`  신호 통과 ${passed.length}종목`);
  if (!passed.length) {
    console.log('ℹ️ 오늘 신호 통과 종목 없음');
    // 코드리뷰 HIGH 지적(2026-09-13) — "무신호"와 "캐시 기준일 불일치로 전 종목
    // 탈락"을 겉보기로 구분 못 하면 매일 조용히 아무 일도 안 하는 상태가 정상인지
    // 버그인지 알 길이 없다. 최소한 실행됐다는 사실+후보수는 남긴다.
    if (!dryRun) {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '완료',
        body: `<b>돌파매매 일별 신호스캔 완료 — 신호 없음</b>\n사전필터 통과 ${candidates.length}종목(기준일 ${cachedDate}) 중 오늘 신호 통과 0건 — 매수 없음.`,
      }));
    }
    return;
  }

  passed.sort((a, b) => b.relativeStrength - a.relativeStrength);
  const rawSelected = passed.slice(0, remainingSlots);
  const selected = maxEntries ? rawSelected.slice(0, maxEntries) : rawSelected;
  console.error(`[5/5] 슬롯(${remainingSlots}${maxEntries ? `, --max-entries=${maxEntries}로 제한` : ''}) 배정 — ${selected.map((s) => s.name).join(', ')}`);

  const quant = loadQuantAccount();
  if (!quant) { console.error('❌ 퀀트 계좌정보(quantAccount) 미설정 — 발주 불가'); return; }
  const balanceToken = await getKisToken({ appkey: quant.appkey, appsecret: quant.appsecret });
  const { cash } = await getAccountBalance({
    token: balanceToken, appkey: quant.appkey, appsecret: quant.appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
  });
  if (cash == null) { console.error('❌ 예수금 조회 실패(0으로 추정하지 않음) — 발주 불가'); return; }

  let remainingCash = cash;
  const entryDate = todayKST();
  const here = dirname(fileURLToPath(import.meta.url));
  for (const s of selected) {
    // Math.min(...): 현재 RISK_PER_TRADE_PCT(2%)/STOP_LOSS_PCT(8%) 조합에서는
    // computePositionSize가 항상 remainingCash×0.25를 돌려줘 이 min이 실질적으로
    // 안 묶인다(코드리뷰 LOW 지적, 2026-09-13) — 그래도 남겨둔다: 나중에 이 두
    // 상수 비율이 바뀌어(예: riskPct를 올리는 실험) 산정치가 remainingCash를
    // 넘어서는 조합이 되면 이 min이 실제 안전장치로 작동해야 하기 때문
    // (자본 초과 배정 방지 최후 방어선). 죽은 코드 아님 — 의도된 방어적 게이트.
    const sizeWon = Math.min(computePositionSize(remainingCash, { riskPct: RISK_PER_TRADE_PCT }), remainingCash);
    if (!(sizeWon > 0)) { console.log(`  ℹ️ ${s.name} — 가용 예수금 소진으로 스킵`); continue; }
    remainingCash -= sizeWon;
    if (dryRun) {
      console.log(`  [DRY-RUN] ${s.name}(${s.code}) 투입예산 ${Math.round(sizeWon).toLocaleString('ko-KR')}원 — 실제 발주 안 함`);
      continue;
    }
    const child = spawn('node', [
      join(here, '..', 'tools', 'place-breakout-entry-order.mjs'),
      `--code=${s.code}`, `--name=${s.name}`, `--entry-date=${entryDate}`, `--invested-won=${Math.round(sizeWon)}`,
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error(`  ⚠️ ${s.name} 발주 스크립트 기동 실패: ${e.message}`));
    child.unref();
    console.log(`  👉 ${s.name}(${s.code}) 발주 시작 — 투입예산 ${Math.round(sizeWon).toLocaleString('ko-KR')}원`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message, e.stack); process.exit(1); });
}
