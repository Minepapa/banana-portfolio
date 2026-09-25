// NH PLUG gbstock 일별거래내역은 주문번호를 제공하지 않는다. 대신 API가 제공하는
// 거래일·trd_sno를 sourceEventId로 보존해 같은 조건의 별도 행도 구분한다.
import { maskNhActNo } from './nh-accounts.mjs';

// 카카오 파서와 같은 브로커명은 원문 감사·표시 일관성 목적이다. Ledger 정본은
// API 하나뿐이므로 카카오와 날짜 기반으로 대조하지 않는다.
const BROKER = 'NH투자증권 해외';

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function toDashedDate(value) {
  const compact = String(value ?? '').trim();
  if (!/^\d{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function previousKstCalendarDate(dashedDate) {
  const date = new Date(`${dashedDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// 실측한 미국주식 응답은 "AAPL US" 형식이다. 다른 국가 접미사 형식은 아직
// 실측하지 않았으므로 임의로 제거하지 않는다.
function normalizeGbStockCode(value) {
  return String(value ?? '').trim().replace(/\s+US$/, '');
}

function isUsGbStockCode(value) {
  return /\s+US$/.test(String(value ?? '').trim());
}

// 이 라우팅은 현재 실측한 미국 USD 주식만 대상으로 한다. 호출부도 이 함수를 써서
// 파서에서 제외한 행을 조용히 유실한 것처럼 보이지 않게 로그를 남긴다.
export function isSupportedGbUsTradeRow(row) {
  return String(row?.cur_cd_nm ?? '').trim() === 'USD' && isUsGbStockCode(row?.iem_cd);
}

export function parseGbDailyTransactionRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    // 이번 배선 범위는 실측한 USD·미국시장 거래뿐이다. gbstock API가 다른 국가 시장도
    // 함께 반환할 수 있으므로, 미국시장 실측의 날짜 보정 규칙을 다른 시장에 검증 없이
    // 적용하지 않도록 USD와 실측된 " US" 종목 접미사로 함께 좁힌다.
    .filter(isSupportedGbUsTradeRow)
    .map((row) => {
      const tradeDate = toDashedDate(row.trd_dt);
      const dirRaw = String(row.act_trd_tp_nm ?? '').trim();
      const tradeType = dirRaw === '매수' || dirRaw === '매도' ? dirRaw : null;
      const serial = String(row.trd_sno ?? '').trim();
      return {
        tradeDate,
        tradeType,
        stockCode: normalizeGbStockCode(row.iem_cd),
        stockName: String(row.iem_nm ?? '').trim(),
        quantity: numberOrNull(row.trd_qty),
        price: numberOrNull(row.trd_uit_pr),
        sourceEventId: tradeDate && serial ? `gb-${tradeDate.replaceAll('-', '')}-${serial}` : null,
      };
    })
    .filter((row) => row.tradeDate && row.tradeType && row.stockCode && row.stockName
      && row.quantity != null && row.quantity > 0 && row.price != null && row.price > 0 && row.sourceEventId);
}

export function buildGbExecutionLedgerInput(row, { account, actNo }) {
  return {
    // USD·미국시장 실측: API trd_dt 2026-06-10(AAPL 2주 매도 @314.5057)는 카카오
    // 실측 AAPL 1건은 API 날짜보다 하루 이른 KST 체결일이었다. 다른 실측에는 3일
    // 차이도 있어 고정 역산식은 존재하지 않는다. 단일 API 정본 전환 뒤 이 값은
    // 중복판정에 쓰이지 않는 표시일자 최선근사치일 뿐이다.
    tradeDate: `${previousKstCalendarDate(row.tradeDate)} 00:00:00`,
    tradeType: row.tradeType,
    stockCode: row.stockCode,
    stockName: row.stockName,
    quantity: row.quantity,
    price: row.price,
    currency: 'USD',
    broker: BROKER,
    account,
    acctNo: maskNhActNo(actNo) || '',
    sourceEventId: row.sourceEventId,
  };
}
