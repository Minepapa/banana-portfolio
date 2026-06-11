// 평가 카드 facts 조립기 — Node 결정론 숫자를 5축 axisItems + 프롬프트 텍스트로 만든다.
// 페처는 인자 주입(테스트용 스텁 가능). 매핑·페처 실패는 추정 없이 '데이터 부족' 표기(환각 차단).

const fmtPct = (v) => v == null ? null : `${v}%`;
const fmtNum = (v) => v == null ? null : String(v);
const item = (label, value, source, metric) =>
  value == null ? null : { label, value, source, ...(metric ? { metric } : {}) };
const compact = (arr) => arr.filter(Boolean);

export function buildEvalFacts(entry, ids, fetchers) {
  const isKr = (entry.market || '').toUpperCase() === 'KR'
    || (!entry.market && ids.corpCode != null);
  const missing = [];

  let fund = null;
  if (isKr && ids.corpCode && fetchers.krFund) fund = fetchers.krFund(ids.corpCode);
  else if (!isKr && ids.ticker && fetchers.usFund) fund = fetchers.usFund(ids.ticker);
  else missing.push(isKr ? 'corp_code 매핑 실패(재무)' : 'US 티커 매핑 실패(재무)');

  let mkt = null;
  if (isKr && ids.stockCode && fetchers.krMkt) mkt = fetchers.krMkt(ids.stockCode);
  else if (!isKr && ids.ticker && fetchers.usMkt) mkt = fetchers.usMkt(ids.ticker);
  if (!mkt) missing.push(isKr ? '종목코드 매핑 실패(시세)' : 'US 티커 매핑 실패(시세)');

  const fs = fund?.source || '데이터 부족';
  const ms = mkt?.source || '데이터 부족';

  const axisItems = {
    수익성: compact([
      item('영업이익률', fmtPct(fund?.opMargin), fs, 'operating_margin'),
      item('매출성장률 YoY', fmtPct(fund?.revenueYoY), fs),
      item('ROE', fmtPct(fund?.roe), fs),
    ]),
    안정성: compact([
      item('부채비율', fmtPct(fund?.debtRatio), fs),
    ]),
    밸류에이션: compact([
      item('Forward PER', fmtNum(mkt?.forwardPE), ms, 'fwd_per'),
      item('PBR', fmtNum(mkt?.pbr), ms),
    ]),
    현금흐름: compact([
      item('FCF yield', fmtPct(mkt?.fcfYield), ms, 'fcf_yield'),
      item('배당성향', fmtPct(mkt?.payoutRatio), ms),
    ]),
    모멘텀: compact([
      item('RSI(14)', fmtNum(mkt?.rsi14), ms, 'rsi'),
      item('52주 위치', fmtPct(mkt?.pos52w), ms, 'pos_52w'),
    ]),
  };

  const lines = [];
  for (const ax of ['수익성', '안정성', '밸류에이션', '현금흐름', '모멘텀']) {
    const items = axisItems[ax];
    lines.push(`- ${ax}: ${items.length ? items.map(i => `${i.label} ${i.value}`).join(', ') : '데이터 부족'}`);
  }
  if (missing.length) lines.push(`- ⚠️ 데이터 부족: ${missing.join('; ')} → 해당 축은 "(데이터 부족)" 표기, 추정 금지`);

  return { axisItems, factsText: lines.join('\n'), market: isKr ? 'KR' : 'US' };
}
