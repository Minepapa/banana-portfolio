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
import {
  getToken, getRange, ensureSheet, clearValues, setValues, nowKST, readHoldings,
} from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { krStockCode, usTicker, usExchange } from '../lib/instruments.mjs';
import {
  hasKisCredentials, loadKisCredentials, getKisToken, getKrQuote, getUsQuote,
  buildRealtimeRows, isKrMarketOpen, isUsMarketOpen,
} from '../lib/kis.mjs';

const SHEET = '실시간시세';
const HEADER = ['종목명', '시장', '티커', '실시간가', '등락률', '갱신시각'];
// 국내 레이트리밋 정확한 수치 미확인(공식문서 "초당 거래건수 초과 EGW00201"만 언급) —
// 실측(2026-07): 200ms 간격도 종목 14개 순차호출 중 무작위로 레이트리밋에 걸림.
// 400ms로 늘리고, get{Kr,Us}Quote 자체에도 EGW00201 재시도를 넣어 이중 방어. 해외 API도
// 같은 KIS 앱키 아래 호출이라 보수적으로 동일 간격 적용.
const STAGGER_MS = 400;

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
      if (!excd) { collectWarning(`실시간시세 제외: ${h.name} — 거래소코드(EXCD) 미등록(usExchange 등록 필요)`); continue; }
      targets.push({ name: h.name, code: ticker, market: 'US', excd, fetch: usOpen });
      continue;
    }
    collectWarning(`실시간시세 제외: ${h.name} — 종목코드/티커 매핑 없음`);
  }
  if (!targets.length) {
    console.log('매핑된 보유종목 0건 — 종료');
    await flushWarnings('realtime-quotes');
    return;
  }

  const { appkey, appsecret } = loadKisCredentials();
  const kisToken = await getKisToken({ appkey, appsecret });

  const quotes = new Map();
  for (const h of targets) {
    if (!h.fetch) continue; // 그 시장이 지금 장외 — 조회 안 함(carry-forward로 직전 값 유지)
    try {
      const quote = h.market === 'US'
        ? await getUsQuote({ token: kisToken, appkey, appsecret, excd: h.excd, symb: h.code })
        : await getKrQuote({ token: kisToken, appkey, appsecret, code: h.code });
      quotes.set(h.name, quote);
    } catch (e) {
      collectWarning(`실시간시세 조회 실패: ${h.name} — ${e.message.slice(0, 80)}`);
    }
    await sleep(STAGGER_MS);
  }

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
