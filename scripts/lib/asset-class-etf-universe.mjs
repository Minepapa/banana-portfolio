// 자산군별 ETF 후보 유니버스 — 2026-09-06 신설. "자산분배 트랙 핵심 로직 설계" §2.
// 그 계좌에 보유 후보가 전혀 없을 때(완전 신규 매수)만 쓰인다 — Athena가 매번 자유롭게
// 브랜드를 지어내던 문제(2026-08-29 오너가 실제로 겪은 "매번 다른 브랜드 제안")를 막기
// 위해, 이 목록 안에서만 데이터 기반 순위(scripts/lib/instrument-scoring.mjs
// rankAssetClassUniverse)로 골라 프롬프트에 주입한다. `etf-expense-ratios.mjs`와 같이
// 시작은 비워두고 오너가 확인해서 채운다 — 빈 자산군은 이 경로가 그냥 스킵된다(기존
// "자유 판단" 프롬프트 문구로 폴백하지 않음, 데이터 없이 추정 안 함).
// 2026-09-06 오너 확인 — "현재 보유 중인 종목으로 채워서 운영"하기로 확정. State/
// Holdings 실측(위탁·연금저축) 기준, 아래는 뺐다(이유는 각 줄 참고 — KRX etp/
// etf_bydd_trd에 아예 없어 fetchEtfSeries로 스코어링이 안 되는 상품군):
//   - 채권: 삼척블루파워12(위탁, 직접채권 — krbond 도메인 별도 소스, ETF 아님)
//   - 금: 금 99.99K(금현물, 실물 상품 — gen/gold_bydd_trd 소스, ETF 아님. TIGER
//     KRX금현물은 같은 금 익스포저를 주는 실제 ETF라 이건 포함)
//   - 달러: 외화 RP(위탁, isCashLike 예금성 상품 — RP는 KRX 상장 ETF가 아니라
//     애초에 etp/etf_bydd_trd 소스로 스코어링할 대상 자체가 아님. 보유수량(qty) 자체는
//     2026-09-19부터 reconcile-nh-fx-rp.mjs가 NH API로 자동 갱신함 — 예전엔 qty
//     조회도 API로 안 됐지만[[project-nh-fx-rp-not-queryable]] 결론이 뒤집혔음,
//     단 이 목록에서 빠지는 이유(ETF 스코어링 대상 아님)와는 무관)
//   - 국내주식: SK하이닉스·삼성전자·삼성전자(자사주)(위탁, LEGACY_INDIVIDUAL_STOCKS
//     — 개별주식), VIP한국형가치투자증권자투자신탁(주식)-C-Pe(연금저축, KRX 비상장
//     펀드 — vipasset.co.kr 별도 소스)
//   - 해외주식: 마이크로소프트·알파벳 Class A·테슬라(위탁, LEGACY_INDIVIDUAL_STOCKS)
// 2026-09-07 오너 추가 요청분 반영 — 성격이 다른 종목(액티브/패시브, 국채/회사채 등)을
// 자산군당 여러 개 담는다는 오너 확정 방향에 따라 후보를 확장(추적오차·보수율만으로
// 단일 "정답"을 강제하지 않고, Athena가 프롬프트에서 성격 차이를 보고 판단하게 함 —
// buildRebalanceProposalPrompt 등의 "이 목록 안에서만 골라라" 지시는 유지하되 그
// 목록 자체가 다양한 선택지를 담게 됨). 이름 표기는 KRX etp/etf_bydd_trd 실측으로
// 확정(오너가 준 이름 중 공백·오타 정정: "KODEX 국고채 10년액티브"→"KODEX 국고채
// 10년액티브"는 실제로 공백 없음, "ACD 미국10년국채액티브"→"ACE 미국10년국채액티브").
// VOO·QQQM(미국 직접 상장 ETF)은 KRX 데이터가 없어 원래 이 유니버스 방식으로
// 스코어링이 안 됐으나(2026-09-07 최초 확인), 같은 날 별도 yfinance 기반 경로
// (scripts/lib/us-etf-scoring.mjs)를 신설해 해소 — instrument-scoring.mjs의
// rankAssetClassUniverse가 이름을 보고 KRX/yfinance 중 어디로 조회할지 자동
// 라우팅한다(US_ETF_BENCHMARK_TICKER에 등록된 이름만 yfinance로 감).
export const ASSET_CLASS_ETF_UNIVERSE = {
  채권: ['KODEX CD금리액티브(합성)', 'KIWOOM 종합채권(AA-이상)액티브', 'KODEX 국고채10년액티브', 'ACE 미국10년국채액티브'],
  금: ['TIGER KRX금현물', 'ACE KRX금현물'],
  달러: ['ACE 미국달러SOFR금리(합성)', 'TIGER 일본엔선물'],
  국내주식: ['KoAct K수출핵심기업TOP30액티브', 'TIGER 200', 'KODEX 200TR', 'ACE 200'],
  해외주식: ['KoAct 미국나스닥성장기업액티브', 'KODEX 미국나스닥100', 'TIGER 미국S&P500', 'VOO', 'QQQM'],
};
