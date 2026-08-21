// VIP한국형가치투자증권자투자신탁(주식)-C-Pe 기준가(NAV) 조회 — vipasset.co.kr
// 내부 API. KIS·KRX 어디에도 사모펀드 종목코드가 없어 별도 소스가 필요하다.
//
// v1은 이 API를 Google Apps Script(scripts/apps-script/gold-price.gs
// fetchVipFundPrice)로 매시간 호출해 시트 F15에 직접 썼다 — v2는 Vault로
// 옮겨오면서 이 소스 자체가 통째로 빠져 curPrice가 마이그레이션 스냅샷(Phase 7)에
// 멈춰있었다(2026-08-20 오너 지적으로 발견). 동일 API를 Node fetch로 그대로
// 재현 — 인증·브라우저 불필요, 실패 시 throw(다른 소스로 조용히 폴백 안 함,
// feedback-no-silent-fallback 원칙).
//
// 응답은 날짜 오름차순 배열([{date, standardPrice, ...}, ...]) — 마지막 요소가
// 최신 기준가. 한국 펀드 기준가는 1,000좌당 표기 관례라 그대로 반환(정수 반올림,
// v1 GAS와 동일 관례) — Vault holding의 avgPrice·evalAmount도 같은 1,000좌당
// 관례로 저장돼 있으므로(update-holdings-prices.mjs recomputeValuation의
// unitScale 참고) 호출부가 반드시 /1000 스케일을 적용해야 한다.
const VIP_FUND_API = 'https://vipasset.co.kr/modules/page/get_fund_data.php?opt=1&opt2=C-Pe';
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

export async function fetchVipFundPrice({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(VIP_FUND_API, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`VIP펀드 기준가 조회 실패 — HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('VIP펀드 기준가 응답이 비어있음');
  const latest = data[data.length - 1];
  const price = Math.round(parseFloat(latest.standardPrice));
  if (!Number.isFinite(price) || price < 100) throw new Error(`VIP펀드 기준가 이상: ${latest.standardPrice}`);
  return { price, date: latest.date };
}
