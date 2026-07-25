#!/usr/bin/env node
/**
 * 보유종목 실시간 시세 잡 — 한투(KIS) Open API로 국내 보유종목 현재가만 조회해 별도 시트
 * "실시간시세"에 갱신한다. 시세 조회 전용(주문 API 미사용 — 자동매매는 이 잡의 범위 밖).
 *
 * 왜: 계좌 시트(ISA/위탁/연금저축/IRP) F열(현재가)은 GOOGLEFINANCE 라이브 수식이고 G/H/I
 * (수익손실/평가금/수익률)가 F에 의존 — F를 직접 덮어쓰면 수식이 사라지고
 * usePortfolioEdits.js의 "수식 아니면 수동편집" 판정도 오작동한다. 그래서 KIS 시세는 별도
 * 시트에 "참고용" 보조값으로만 쌓는다. 보유종목·수량·계좌 구조는 그대로 Google Sheets 정본.
 *
 * 스코프: v1은 KIS 국내 시세 API로 조회 가능한 종목만 — readHoldings()의 market 필드(자산군
 * 텍스트에 "해외"/"미국" 포함 여부로 추정)를 제외 게이트로는 안 쓴다. "TIGER 미국S&P500"처럼
 * 실제로는 KRX 상장인데 자산군이 "해외"로 분류된 ETF가 있어(2026-07 발견), 그 필드로 거르면
 * 국내 조회 가능한 종목까지 잘못 걸러진다 — 대신 krStockCode() 해석 성공 여부 자체를 게이트로
 * 쓴다(DART·KIS 종목마스터 둘 다 KRX 상장분만 들고 있어 해외 개별주는 애초에 안 걸림).
 * market 필드는 "매핑 실패 시 경고를 낼지" 판단에만 참조(아래 참고) — 진짜 해외거래소 상장
 * 종목(테슬라·엔비디아 등)은 매핑 실패가 당연하므로 조용히 skip, 국내인데 매핑 실패한 경우만
 * 경고(이게 진짜 놓친 매핑이라 알아야 함). 진짜 해외 종목 자체는 이 방식으로도 여전히 시세
 * 조회 범위 밖(세션시간·환율·레이트리밋 이슈로 후속 과제).
 * 평일 09:00–15:30 KST만 실행되게 설계됨(시간 게이트는 scripts/launchd/run.sh — 이 스크립트
 * 자체엔 시간 체크 없음, 수동 실행 시 언제든 동작).
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
import { krStockCode } from '../lib/instruments.mjs';
import {
  hasKisCredentials, loadKisCredentials, getKisToken, getKrQuote, buildRealtimeRows,
} from '../lib/kis.mjs';

const SHEET = '실시간시세';
const HEADER = ['종목명', '시장', '티커', '실시간가', '등락률', '갱신시각'];
// 국내 레이트리밋 정확한 수치 미확인(공식문서 "초당 거래건수 초과 EGW00201"만 언급) —
// 실측(2026-07): 200ms 간격도 종목 14개 순차호출 중 무작위로 레이트리밋에 걸림.
// 400ms로 늘리고, getKrQuote 자체에도 EGW00201 재시도를 넣어 이중 방어.
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

  const explicitToken = process.argv[2];
  const token = await getToken(explicitToken?.trim() || null, { allowBrowser: false });

  const holdingsRaw = await readHoldings(token);
  const holdings = [];
  for (const h of holdingsRaw) {
    if (isCashLike(h.name)) continue;
    const code = krStockCode(h.name);
    if (!code) {
      // market:'US'(진짜 해외거래소 상장으로 추정되는 종목)는 매핑 실패가 당연해 조용히 skip —
      // 안 그러면 30초 폴링마다 "테슬라 매핑 없음" 같은 뻔한 경고가 영구 반복된다(예수금과
      // 동일한 "경고할 대상 아님" 원칙, isCashLike 주석 참고). market:'KR'인데 매핑 실패한
      // 경우만 경고 — 이건 실제로 놓친 매핑이라 사람이 알아야 한다.
      if (h.market !== 'US') collectWarning(`실시간시세 제외: ${h.name} — 종목코드 매핑 없음`);
      continue;
    }
    holdings.push({ name: h.name, code });
  }
  if (!holdings.length) {
    console.log('KRX 상장 보유종목 매핑 0건 — 종료');
    await flushWarnings('realtime-quotes');
    return;
  }

  const { appkey, appsecret } = loadKisCredentials();
  const kisToken = await getKisToken({ appkey, appsecret });

  const quotes = new Map();
  for (const h of holdings) {
    try {
      quotes.set(h.name, await getKrQuote({ token: kisToken, appkey, appsecret, code: h.code }));
    } catch (e) {
      collectWarning(`실시간시세 조회 실패: ${h.name} — ${e.message.slice(0, 80)}`);
    }
    await sleep(STAGGER_MS);
  }

  const created = await ensureSheet(token, SHEET, HEADER);
  const prevRows = created ? [] : await getRange(token, `${SHEET}!A2:F`);
  const rows = buildRealtimeRows(holdings, quotes, prevRows, nowKST());

  await clearValues(token, `${SHEET}!A2:F`);
  if (rows.length) await setValues(token, `${SHEET}!A2`, rows);

  console.log(`✅ 실시간시세 갱신 ${quotes.size}/${holdings.length}건`);
  await flushWarnings('realtime-quotes');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('realtime-quotes').catch(() => {});
  process.exit(1);
});
