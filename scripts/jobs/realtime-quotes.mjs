#!/usr/bin/env node
/**
 * 보유종목 실시간 시세 잡 — 한투(KIS) Open API로 국내·해외 보유종목 현재가를 조회해 별도
 * 시트 "실시간시세"에 갱신한다. 시세 조회 전용(주문 API 미사용 — 자동매매는 이 잡의 범위 밖).
 *
 * 왜: 계좌 시트(ISA/위탁/연금저축/IRP) F열(현재가)은 GOOGLEFINANCE 라이브 수식이고 G/H/I
 * (수익손실/평가금/수익률)가 F에 의존 — F를 직접 덮어쓰면 수식이 사라지고
 * usePortfolioEdits.js의 "수식 아니면 수동편집" 판정도 오작동한다. 그래서 KIS 시세는 별도
 * 시트에 "참고용" 보조값으로만 쌓는다. 보유종목·수량·계좌 구조는 그대로 Google Sheets 정본.
 *
 * 시장 판정: readHoldings()의 market 필드(자산군 텍스트 추정)는 게이트로 쓰지 않는다 —
 * "TIGER 미국S&P500"처럼 실제로는 KRX 상장인데 자산군이 "해외"로 분류된 ETF가 있다(2026-07
 * 발견, 국내 전용이던 시절의 회귀 버그였음). 대신 매 종목마다 krStockCode() 먼저 시도 →
 * 실패하면 usTicker() 시도(순서 고정: DART/KIS 종목마스터 둘 다 KRX 상장분만 들고 있어 해외
 * 개별주가 krStockCode에 걸릴 일이 없으므로 순서를 바꿔도 안전하지만, KR이 절대다수라 KR을
 * 먼저 시도하는 쪽이 평균 조회 비용이 낮다) → 어느 쪽이 성공했는지로 실제 시장을 결정한다.
 * 이 방식이면 market 필드가 틀려 있어도(위 ETF처럼) 항상 올바르게 해석된다.
 *
 * 시간 게이트: 국내·해외 정규장 여부를 잡 자체가 판단한다(isKrMarketOpen/isUsMarketOpen,
 * DST 자동 반영 — kis.mjs 참고). 어느 쪽도 안 열려 있으면 Google 호출 전에 즉시 skip. 국내만
 * 열려 있으면 해외 종목은 이번 폴링에서 건드리지 않음(레이트리밋 낭비 방지) — 그 반대도 동일.
 * scripts/launchd/run.sh도 별도로 대략적인(국내·해외 통합) 사전 필터를 두어 완전 장외 시간엔
 * 서비스계정 OAuth 호출조차 안 하게 막는다 — 여기 정밀 게이트는 그 필터를 신뢰하지 않고
 * 독립적으로 다시 판단한다(수동 실행 시에도 항상 정확하게 동작해야 하므로).
 *
 * 안전: 종목별 개별 조회 실패는 collectWarning 후 직전 값 유지(전체 잡은 안 죽음). KIS
 * 크리덴셜 미설정(~/.config/banana-portfolio/kis-key.json 없음)이면 잡은 정상 skip(오류
 * 아님) — Frank가 아직 API 키를 발급 안 했을 수 있는 상태를 실패로 취급하지 않는다.
 *
 * 사용: node scripts/jobs/realtime-quotes.mjs [token]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getToken, getRange, ensureSheet, clearValues, setValues, nowKST, readHoldings,
} from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { krStockCode, usTicker, usExchange } from '../lib/instruments.mjs';
import {
  hasKisCredentials, loadKisCredentials, getKisToken, getKrQuote, getUsQuote,
  buildRealtimeRows, isKrMarketOpen, isUsMarketOpen, KIS_RATE_LIMIT_CODE,
} from '../lib/kis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHEET = '실시간시세';
const HEADER = ['종목명', '시장', '티커', '실시간가', '등락률', '갱신시각'];
// 국내 레이트리밋 정확한 수치 미확인(공식문서 "초당 거래건수 초과 EGW00201"만 언급) —
// 실측(2026-07): 200ms→400ms로 늘려도 여전히 부족(같은 달 재실측: 17건 중 4건(24%)이 재시도
// 2회(700ms·1400ms 백오프) 다 써도 실패 — 텔레그램에 EGW00201 경고가 거의 매 폴링(30초)마다
// 발생하는 근본 원인이었음, Frank 신고로 발견). 800ms로 재상향 + 재시도 예산도 늘림(2→3회).
const STAGGER_MS = 800;
const QUOTE_RETRIES = 3;
const QUOTE_RETRY_DELAY_MS = 700;

// "매핑 없음"(종목코드/티커 자체가 없는 채권·실물자산·OTC펀드 등)은 구조적으로 영구히 안
// 풀리는 상태라 매 폴링(30초)마다 경고를 반복하면 텔레그램 스팸이 된다(job-alerts.mjs의 24h
// 억제는 "경고 세트 전체의 해시"가 같아야 걸리는데, 같은 배치 안에 무작위로 달라지는
// EGW00201 실패 종목이 섞이면 세트 해시가 매번 달라져 억제가 무력화됨 — 이게 실제 스팸의
// 핵심 원인, Frank 신고로 발견). 이름별로 마지막 경고 시각을 캐시해 재확인 주기(7일, 마스터
// 파일이 나중에 갱신돼 매핑될 가능성 고려)마다만 1회 경고한다.
const UNMAPPED_CACHE_FILE = join(HERE, '..', '.cache', 'realtime-quotes-unmapped.json');
const UNMAPPED_RECHECK_MS = 7 * 24 * 3600 * 1000;

function loadUnmappedCache() {
  try { return JSON.parse(readFileSync(UNMAPPED_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveUnmappedCache(map) {
  mkdirSync(dirname(UNMAPPED_CACHE_FILE), { recursive: true });
  writeFileSync(UNMAPPED_CACHE_FILE, JSON.stringify(map));
}

// 레이트리밋(EGW00201)은 "항상 같은 종목"이 아니라 매 폴링마다 무작위로 다른 종목이 걸린다
// (2026-07 재조사: 최근 로그에서 12개 서로 다른 종목이 1~12회씩 무작위 분산 — Frank가 "특정
// 4종목만 실패"로 오인한 원인이 이것. 실제론 고정된 문제 종목이 없다). 종목명이 매번 달라지면
// job-alerts.mjs의 24h 억제(경고 세트 전체 해시 기준)가 매번 새 세트로 인식돼 무력화된다
// (이전 수정에서 "매핑없음" 3건은 이 방식으로 고쳤지만 EGW00201은 그때 그대로 뒀었음 — 잔여
// 스팸의 원인). 레이트리밋은 종목이 아니라 "시스템 전역의 일시적 상태"(다음 폴링에서 자동
// 회복, carry-forward로 화면엔 영향 없음)라 종목명과 무관하게 이 주기 안엔 딱 한 번만 알린다.
// 판별은 err.message 정규식이 아니라 kis.mjs가 err.code(KIS msg_cd 원본값)로 붙여주는 값과
// 비교한다 — msg1(사람이 읽는 문구)로 판별하면 KIS가 문구를 바꿀 때 조용히 깨진다(코드리뷰
// 지적, kis.test.js 레이트리밋 픽스처가 msg1엔 코드 문자열을 안 넣는다는 점에서도 확인됨).
const RATE_LIMIT_CACHE_FILE = join(HERE, '..', '.cache', 'realtime-quotes-ratelimit.json');
const RATE_LIMIT_ALERT_COOLDOWN_MS = 6 * 3600 * 1000; // 6시간 — 정규장 세션당 대략 1회 수준(경험적 선택)

function loadRateLimitCache() {
  try { return JSON.parse(readFileSync(RATE_LIMIT_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveRateLimitCache(obj) {
  mkdirSync(dirname(RATE_LIMIT_CACHE_FILE), { recursive: true });
  writeFileSync(RATE_LIMIT_CACHE_FILE, JSON.stringify(obj));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 현금성 행 — 시세 조회 대상 아님(movers.js·order-candidates.mjs isCashLike와 동일 기준).
// 매 폴링(30초)마다 "종목코드 매핑 없음" 경고가 영구 반복되는 걸 막는다(예수금은 종목이 아니라
// 애초에 매핑될 수 없음 — 경고할 대상이 아님).
const isCashLike = (name) => {
  const n = String(name ?? '').trim();
  return n === '예수금' || n === '외화 RP' || n.includes('MMF');
};

async function main() {
  if (!hasKisCredentials()) {
    console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵(설정 시 ~/.config/banana-portfolio/kis-key.json 생성)');
    return;
  }

  const krOpen = isKrMarketOpen();
  const usOpen = isUsMarketOpen();
  if (!krOpen && !usOpen) {
    console.log('국내·해외 모두 장외 — 스킵');
    return;
  }

  const explicitToken = process.argv[2];
  const token = await getToken(explicitToken?.trim() || null, { allowBrowser: false });

  // targets는 매핑 성공한 보유종목 전체(시장 개장 여부와 무관) — buildRealtimeRows의
  // carry-forward가 "이번에 조회 안 한 종목은 직전 값 유지"로 동작하려면 그 종목이 목록에
  // 있어야 한다. 여기서 열려있지 않은 시장 종목을 아예 빼버리면 그 시장이 닫힐 때마다
  // clearValues+setValues 과정에서 직전 시세 행이 통째로 사라진다(carry-forward 무력화) —
  // 그래서 "이번에 실제로 조회할지"는 fetch 플래그로만 분리하고 목록 자체엔 항상 포함시킨다.
  const unmappedCache = loadUnmappedCache();
  let unmappedCacheDirty = false;
  // 영구 미매핑(채권 직접보유·실물자산·OTC펀드 등 KRX/미국거래소 코드 자체가 없는 상품)은
  // 이름별로 UNMAPPED_RECHECK_MS(7일)에 한 번만 경고 — 매 폴링(30초)마다 반복 경고하는 걸
  // 막는다(Frank 신고 — 3개 고정 항목이 매번 텔레그램에 뜨던 스팸의 원인).
  const warnUnmapped = (name, reason) => {
    const last = unmappedCache[name];
    if (last && Date.now() - last < UNMAPPED_RECHECK_MS) return;
    collectWarning(`실시간시세 제외: ${name} — ${reason}`);
    unmappedCache[name] = Date.now();
    unmappedCacheDirty = true;
  };

  const holdingsRaw = await readHoldings(token);
  const targets = [];
  for (const h of holdingsRaw) {
    if (isCashLike(h.name)) continue;
    const krCode = krStockCode(h.name);
    if (krCode) { targets.push({ name: h.name, code: krCode, market: 'KR', fetch: krOpen }); continue; }
    const ticker = usTicker(h.name);
    if (ticker) {
      const excd = usExchange(ticker);
      // usExchange도 usTicker처럼 미등록이면 null(추정 금지) — instruments.mjs 참고.
      // 신규 US 종목을 US_MAP에만 등록하고 US_EXCD_MAP 등록을 깜빡한 경우 여기서 드러난다.
      if (!excd) { warnUnmapped(h.name, '거래소코드(EXCD) 미등록(usExchange 등록 필요)'); continue; }
      targets.push({ name: h.name, code: ticker, market: 'US', excd, fetch: usOpen });
      continue;
    }
    warnUnmapped(h.name, '종목코드/티커 매핑 없음');
  }
  if (unmappedCacheDirty) saveUnmappedCache(unmappedCache);
  if (!targets.length) {
    console.log('매핑된 보유종목 0건 — 종료');
    await flushWarnings('realtime-quotes');
    return;
  }

  const { appkey, appsecret } = loadKisCredentials();
  const kisToken = await getKisToken({ appkey, appsecret });

  const rateLimitCache = loadRateLimitCache();
  let rateLimitCacheDirty = false;
  let rateLimitAlertedThisRun = false; // 이번 실행 안에서는 최대 1건만 collectWarning
  let rateLimitFailCount = 0;

  const quotes = new Map();
  for (const h of targets) {
    if (!h.fetch) continue; // 그 시장이 지금 장외 — 조회 안 함(carry-forward로 직전 값 유지)
    try {
      const quote = h.market === 'US'
        ? await getUsQuote({ token: kisToken, appkey, appsecret, excd: h.excd, symb: h.code, retries: QUOTE_RETRIES, retryDelayMs: QUOTE_RETRY_DELAY_MS })
        : await getKrQuote({ token: kisToken, appkey, appsecret, code: h.code, retries: QUOTE_RETRIES, retryDelayMs: QUOTE_RETRY_DELAY_MS });
      quotes.set(h.name, quote);
    } catch (e) {
      if (e.code === KIS_RATE_LIMIT_CODE) {
        rateLimitFailCount++;
        console.log(`   ⏳ ${h.name}: 레이트리밋(EGW00201) — carry-forward, 다음 폴링 자동 재시도`);
        const last = rateLimitCache.lastAlert;
        if (!rateLimitAlertedThisRun && (!last || Date.now() - last >= RATE_LIMIT_ALERT_COOLDOWN_MS)) {
          collectWarning(`실시간시세 레이트리밋(EGW00201) 발생 중 — 예: ${h.name} 등. 자동 재시도되는 일시적 현상(조치 불필요, 종목은 폴링마다 무작위) — 지속 시에만 ${Math.round(RATE_LIMIT_ALERT_COOLDOWN_MS / 3600000)}시간마다 재알림.`);
          rateLimitCache.lastAlert = Date.now();
          rateLimitCacheDirty = true;
          rateLimitAlertedThisRun = true;
        }
      } else {
        collectWarning(`실시간시세 조회 실패: ${h.name} — ${e.message.slice(0, 80)}`);
      }
    }
    await sleep(STAGGER_MS);
  }
  if (rateLimitCacheDirty) saveRateLimitCache(rateLimitCache);
  if (rateLimitFailCount) console.log(`   ⏳ 레이트리밋 총 ${rateLimitFailCount}건(carry-forward로 흡수됨)`);

  const created = await ensureSheet(token, SHEET, HEADER);
  const prevRows = created ? [] : await getRange(token, `${SHEET}!A2:F`);
  const rows = buildRealtimeRows(targets, quotes, prevRows, nowKST());

  await clearValues(token, `${SHEET}!A2:F`);
  if (rows.length) await setValues(token, `${SHEET}!A2`, rows);

  const fetchAttempted = targets.filter(h => h.fetch).length;
  console.log(`✅ 실시간시세 갱신 ${quotes.size}/${fetchAttempted}건(전체 매핑 ${targets.length}건)`);
  await flushWarnings('realtime-quotes');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('realtime-quotes').catch(() => {});
  process.exit(1);
});
