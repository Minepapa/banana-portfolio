// NH PLUG 국내주식(krstock) 도메인 — 2026-09-01 신설. 인증·공용호출(callNh)·속도제한·
// 성공판정은 scripts/lib/nhplug.mjs가 담당, 이 파일은 krstock 엔드포인트 스키마만 다룬다.
// 필드명·타입은 openapi-docs/krstock/openapi.json 정본에서 직접 추출(공식 SDK
// nhplug-sdk엔 정정·취소 참고구현이 아예 없어 SDK가 아니라 openapi.json으로 검증).
//
// act_no는 /n2/acctinfo의 acct_no를 그대로 쓴다(운영 acct_type 01·02만 유효 — 이
// 코드베이스는 항상 실전 도메인만 호출하므로 03 계좌는 애초에 안 옴, nhplug.mjs
// 헤더 주석 참고).
import { callNh } from './nhplug.mjs';
import {
  validateOrderInputs, validateIdentity, validateOrgOrderRef, validatePartialQty, rethrowOrderError,
  validateSbyDitCd, validateFixedOption, extractOrderNo,
} from './nhplug-order-safety.mjs';

// 잔고조회(POST /krstock/inquiry/v1/balance). bncBseCd: 1=체결기준 총평가, 5=현재가기준
// 잔고평가(kis.mjs 스타일과 맞춰 기본값은 실시간성 있는 현재가기준). ltgAotDitCd: 1=상장
// 종목만, 9=전체(폐지종목 포함 — 기본 1). aetBse: 1=순자산, 2=총자산(기본 1). qutDitCd:
// UNT(통합)·KRX·NXT 중 하나 필수(기본 UNT).
export async function getKrBalance({
  token, actNo, bncBseCd = '5', ltgAotDitCd = '1', aetBse = '1', qutDitCd = 'UNT', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/inquiry/v1/balance', fetchImpl,
    input0: {
      act_no: actNo, bnc_bse_cd: bncBseCd, ltg_aot_dit_cd: ltgAotDitCd,
      aet_bse: aetBse, qut_dit_cd: qutDitCd,
    },
  });
}

// 현재가조회(POST /krstock/quote/v1/currentPrice). marketCd: KRX/NXT/UNT.
export async function getKrCurrentPrice({ token, iemCd, marketCd = 'KRX', fetchImpl }) {
  return callNh({
    token, uri: '/krstock/quote/v1/currentPrice', fetchImpl,
    input0: { market_cd: marketCd, iem_cd: iemCd },
  });
}

// 매수가능수량조회(POST /krstock/inquiry/v1/buyableQuantity). ostDitCd='1' 현금만 지원
// (신용·매입자금대출은 이 프로젝트 범위 밖 — 2트랙 구조가 신용거래를 안 씀).
// nmnPrTpCd: '01'=지정가(price 필요) '05'=시장가(price 생략).
export async function getKrBuyableQuantity({ token, actNo, iemCd, price, fetchImpl }) {
  const nmnPrTpCd = price != null ? '01' : '05';
  const input0 = { ost_dit_cd: '1', act_no: actNo, iem_cd: iemCd, nmn_pr_tp_cd: nmnPrTpCd };
  if (price != null) input0.orr_pr = price;
  return callNh({ token, uri: '/krstock/inquiry/v1/buyableQuantity', input0, fetchImpl });
}

// 매도가능수량조회(POST /krstock/inquiry/v1/sellableQuantity). cfdLonCd='00' 일반거래
// (신용 매도 이 프로젝트 범위 밖, 위와 동일 이유).
export async function getKrSellableQuantity({ token, actNo, iemCd, cfdLonCd = '00', fetchImpl }) {
  return callNh({
    token, uri: '/krstock/inquiry/v1/sellableQuantity', fetchImpl,
    input0: { act_no: actNo, iem_cd: iemCd, cfd_lon_cd: cfdLonCd },
  });
}

// ⚠️ 주문 계열(cashBuy·cashSell·modify·cancel) 안전장치는 nhplug-order-safety.mjs로
// 이관됨(2026-09-01, krgold가 두 번째 소비자가 되며 분리 — 안전장치 로직을
// 자산군마다 복붙하면 한쪽만 고치는 회귀 위험이 생김). 계약은 그대로: "확실히
// 안 나감"과 "불명"을 confirmedNotSent로 구분(kis.mjs placeKrOrder와 동일 철학,
// 2026-08-09 코드리뷰로 확정된 이 프로젝트 전역 규칙). 상세 근거는 그 파일 헤더 주석.
const ORDER_TYPE_CODE = { 지정가: '01', 시장가: '05' };

async function placeCashOrder(uri, { token, actNo, iemCd, quantity, price, fetchImpl }) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  const nmnPrTpCd = price != null ? ORDER_TYPE_CODE.지정가 : ORDER_TYPE_CODE.시장가;
  const input0 = {
    act_no: actNo, iem_cd: iemCd, orr_qty: quantity, nmn_pr_tp_cd: nmnPrTpCd,
    // orr_cnd_dit_cd(주문조건구분코드): 00.없음 01.IOC 02.FOK — 조건 없는 일반 주문.
    orr_cnd_dit_cd: '00',
    // ssl_nmn_pr_dit_cd(공매도호가구분코드): 00.정상(기본값) 01.차입주식매도 02.기타공매도
    // 99.권리공매도 — openapi.json 확인 결과 cashBuy·cashSell 둘 다 필수 필드이고
    // "00.정상"이 기본값. 매수 주문은 공매도가 성립할 수 없어 어차피 "정상" 외 값이
    // 나올 수 없으므로 매수·매도 공통으로 고정값 사용은 스펙과 일치(2026-09-01
    // 코드리뷰 MEDIUM 지적 — kis.mjs SLL_TYPE처럼 매도 전용 필드로 오해할 수 있어
    // 근거를 명시).
    ssl_nmn_pr_dit_cd: '00',
    rmt_mkt_cd: 'KRX',
    // sor_mkt_sli_yn(SOR시장분할여부): SOR일 때만 Y/N 선택, KRX/NXT면 무조건 N —
    // rmt_mkt_cd를 'KRX'로 고정했으므로 'N' 고정.
    sor_mkt_sli_yn: 'N',
  };
  if (price != null) input0.orr_pr = price;

  let body;
  try {
    body = await callNh({ token, uri, input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e); // NH가 명시적으로 거부한 경우만 confirmedNotSent 승격
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '주문');
  return { orderNo, raw: body };
}

// 현금매수주문(POST /krstock/order/v1/cashBuy). price 생략 시 시장가.
export async function placeKrCashBuyOrder(args) {
  return placeCashOrder('/krstock/order/v1/cashBuy', args);
}

// 현금매도주문(POST /krstock/order/v1/cashSell). price 생략 시 시장가.
export async function placeKrCashSellOrder(args) {
  return placeCashOrder('/krstock/order/v1/cashSell', args);
}

// 정정주문(POST /krstock/order/v1/modify). allPatDitCd: '1'=전체(전량) '2'=일부(잔량,
// corQty 필요). corPr: 정정가격(필수 — 시장가로의 정정은 이 엔드포인트 범위 밖).
//
// ⚠️ sop_cnd_pr(정지조건가격)을 0으로 고정 — openapi.json 설명: "원주문의 호가유형
// 코드 16(스톱지정가일때) KRX는 효력발생전으로만 수정가능". 이 함수는 스톱지정가
// (16) 원주문 정정을 지원 목적으로 만들지 않았다(2트랙 구조는 지정가·시장가만
// 씀) — 스톱지정가 주문을 이 함수로 정정하면 0이 올바른 값인지 검증 안 됨(다음
// 단계에서 스톱지정가 지원이 필요해지면 이 가정부터 재확인할 것, 2026-09-01
// 코드리뷰 미해결 질문).
export async function modifyKrOrder({
  token, actNo, orgMktOrrNo, iemCd, corPr, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  if (!(Number.isFinite(corPr) && corPr > 0)) { const e = new Error(`정정가격은 양수여야 함: ${corPr}`); e.confirmedNotSent = true; throw e; }
  const input0 = {
    act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd,
    cor_pr: corPr, sop_cnd_pr: 0, rmt_mkt_cd: 'KRX', sor_mkt_sli_yn: 'N',
  };
  if (allPatDitCd === '2') input0.cor_qty = corQty;

  let body;
  try {
    body = await callNh({ token, uri: '/krstock/order/v1/modify', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '정정');
  return { orderNo, raw: body };
}

// 취소주문(POST /krstock/order/v1/cancel). allPatDitCd: '1'=전체 '2'=일부(corQty 필요).
export async function cancelKrOrder({
  token, actNo, orgMktOrrNo, iemCd, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  const input0 = { act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd };
  if (allPatDitCd === '2') input0.cor_qty = corQty;

  let body;
  try {
    body = await callNh({ token, uri: '/krstock/order/v1/cancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '취소');
  return { orderNo, raw: body };
}

// ============================================================================
// 예약주문(reservedOrder·reservedCancel) — 2026-09-02 오너 지시("주문 항목 다
// 구현")로 신설. 신용매수·신용매도(creditBuy·creditSell)는 오너 확인으로 계속
// 제외(2트랙 구조가 신용거래를 안 씀, 담보·증거금 관리가 현금거래보다 훨씬
// 복잡·위험). 이로써 이 프로젝트의 krstock 주문 커버리지는 8종 중 6종(현금매수·
// 현금매도·정정·취소·예약·예약취소).
//
// ⚠️ 예약주문 응답 식별자는 mkt_orr_no가 아니라 bkg_orr_no(예약주문번호) —
// cashBuy/cashSell/modify/cancel과 다른 필드명(openapi.json 확인). placeCashOrder
// 헬퍼를 재사용하지 않고 별도 함수로 작성한 이유.

// 예약주문(POST /krstock/order/v1/reservedOrder, 매수/매도 겸용). sbyDitCd:
// '1'=매도 '2'=매수(gold의 sbyDitCd와 동일 체계). orr_uit_pr(주문단가)이 항상
// 필수 — 예약주문엔 시장가 개념이 없음(nmnPrTpCd='05' 선택은 가능하지만
// openapi.json 스펙상 orr_uit_pr 자체가 required이므로 이 함수도 항상 요구).
//
// ⚠️ bkgOrrTpCd·bkgOrrEnfTpCd·cfdLonCd는 파라미터로 노출하지 않고 스펙상 안전한
// 값 하나로 고정한다(2026-09-02 코드리뷰 HIGH·MEDIUM 지적):
// - bkgOrrTpCd: '2'·'3'(기간예약)을 고르면 openapi.json상 bkg_orr_sta_dt·
//   bkg_orr_end_dt(최대 30일)가 조건부 필수가 되는데 이 함수는 그 필드를 아예 안
//   받는다 — 받으면 그 값이 요구하는 필수필드가 빠진 요청이 조용히 나감(allPatDitCd/
//   corQty 상호관계 버그와 같은 클래스). '1'(일반예약, 당일 1회성)만 지원.
// - bkgOrrEnfTpCd: '2'(기준가격대비)를 고르면 end_pr_cmp_ftw_amt 등 3개 필드가
//   조건부 필수인데 역시 안 받음 — '1'(일반)만 지원.
// - cfdLonCd: 신용대출코드 — 이 프로젝트가 명시적으로 제외한 신용거래의 진입점이라
//   '00'(일반거래)로 고정, 캐스팅 파라미터 자체를 없애 신용 경로를 원천 차단.
// 기간예약·신용예약이 필요해지면 이 함수를 확장(조건부 필수 필드까지 같이 받도록).
export async function placeKrReservedOrder({
  token, actNo, iemCd, sbyDitCd, quantity, price,
  frsSbaOrrYn = 'N', nmnPrTpCd = '01', rmtMktCd = 'KRX',
  fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  validateSbyDitCd(sbyDitCd);
  validateFixedOption(rmtMktCd, 'KRX', '요청시장코드(rmtMktCd)');
  if (price == null) { const e = new Error('예약주문은 orr_uit_pr(주문단가)이 필수(openapi.json) — 가격 없이 호출 불가'); e.confirmedNotSent = true; throw e; }
  const input0 = {
    act_no: actNo, iem_cd: iemCd, sby_dit_cd: sbyDitCd, frs_sba_orr_yn: frsSbaOrrYn,
    nmn_pr_tp_cd: nmnPrTpCd, cfd_lon_cd: '00', orr_qty: quantity, orr_uit_pr: price,
    bkg_orr_tp_cd: '1', bkg_orr_enf_tp_cd: '1', rmt_mkt_cd: rmtMktCd,
  };
  let body;
  try {
    body = await callNh({ token, uri: '/krstock/order/v1/reservedOrder', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'bkg_orr_no', '예약주문');
  return { orderNo, raw: body };
}

// 예약주문취소(POST /krstock/order/v1/reservedCancel). sbyDitCd는 원 예약주문과
// 동일 값을 그대로 넘겨야 함(openapi.json — "입력값 표시"로 응답에도 그대로
// 반향). bkgOrrTpCd도 위 placeKrReservedOrder와 동일 이유로 '1' 고정(원 예약이
// 기간예약이면 이 함수로 취소 시 bkg_rtn_dt가 조건부 필수인데 못 받음 — 기간예약을
// 걸지 않으므로 이 프로젝트 범위에선 항상 '1').
export async function cancelKrReservedOrder({
  token, actNo, iemCd, sbyDitCd, bkgOrrNo, rmtMktCd = 'KRX', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo: bkgOrrNo, label: '예약주문번호(bkgOrrNo)' });
  validateSbyDitCd(sbyDitCd);
  validateFixedOption(rmtMktCd, 'KRX', '요청시장코드(rmtMktCd)');
  const input0 = {
    act_no: actNo, sby_dit_cd: sbyDitCd, iem_cd: iemCd, bkg_orr_no: bkgOrrNo,
    bkg_orr_tp_cd: '1', rmt_mkt_cd: rmtMktCd,
  };
  let body;
  try {
    body = await callNh({ token, uri: '/krstock/order/v1/reservedCancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'bkg_orr_no', '예약취소');
  return { orderNo, raw: body };
}

// ============================================================================
// 조회(inquiry) 잔여 9종 — 2026-09-02 신설. 전부 읽기 전용(안전장치 불필요),
// openapi.json 필드명 그대로.

// 당일 주문체결 조회(POST /krstock/inquiry/v1/dailyOrderExecution). ostCnsDit:
// '0'=전체(기본) '1'=미체결 '2'=체결. orrMktCd: '00'=전체(기본).
export async function getKrDailyOrderExecution({
  token, actNo, orrDt, ostCnsDit = '0', orrMktCd = '00', itgOrrNo, fetchImpl,
}) {
  const input0 = {
    act_no: actNo, orr_dt: orrDt, ost_cns_dit: ostCnsDit, orr_mkt_cd: orrMktCd,
  };
  if (itgOrrNo != null) input0.itg_orr_no = itgOrrNo;
  return callNh({ token, uri: '/krstock/inquiry/v1/dailyOrderExecution', input0, fetchImpl });
}

// 예약주문내역 조회(POST /krstock/inquiry/v1/reservedInquiry). sbyDitCd: '0'=전체
// (기본). bkgOrrTpCd: '0'=전체(기본).
export async function getKrReservedOrders({
  token, actNo, sbyDitCd = '0', bkgOrrTpCd = '0', bkgOrrRtnDt, iemCd, cfdLonCd, bkgOrrCanDitCd, fetchImpl,
}) {
  const input0 = { act_no: actNo, sby_dit_cd: sbyDitCd, bkg_orr_tp_cd: bkgOrrTpCd };
  if (bkgOrrRtnDt != null) input0.bkg_orr_rtn_dt = bkgOrrRtnDt;
  if (iemCd != null) input0.iem_cd = iemCd;
  if (cfdLonCd != null) input0.cfd_lon_cd = cfdLonCd;
  if (bkgOrrCanDitCd != null) input0.bkg_orr_can_dit_cd = bkgOrrCanDitCd;
  return callNh({ token, uri: '/krstock/inquiry/v1/reservedInquiry', input0, fetchImpl });
}

// 실현손익 조회(POST /krstock/inquiry/v1/realizedPnl). iqrDitCd1: '0'=전체(기본)
// '1'=잔고종목 '2'=당일매매. feeDitCd: '1'=온라인(기본) '2'=영업점.
export async function getKrRealizedPnl({
  token, actNo, iqrDitCd1 = '0', feeDitCd = '1', qutDitCd = 'UNT', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/inquiry/v1/realizedPnl', fetchImpl,
    input0: {
      act_no: actNo, iqr_dit_cd1: iqrDitCd1, fee_dit_cd: feeDitCd, qut_dit_cd: qutDitCd,
    },
  });
}

// 투자계좌자산현황 조회(POST /krstock/inquiry/v1/assetStatus). ealAlyCd:
// '2'=시가평가(기본, getKrBalance의 bncBseCd 기본값 5=현재가기준과 같은 실시간성
// 원칙). aetBse: '1'=순자산(기본).
export async function getKrAssetStatus({
  token, actNo, ealAlyCd = '2', aetBse = '1', qutDitCd = 'UNT', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/inquiry/v1/assetStatus', fetchImpl,
    input0: {
      act_no: actNo, eal_aly_cd: ealAlyCd, aet_bse: aetBse, qut_dit_cd: qutDitCd,
    },
  });
}

// 실현손익일별합산(실현손익추이) 조회(POST /krstock/inquiry/v1/dailyPnl).
// iqrStaDt·iqrEndDt(YYYYMMDD) 둘 다 openapi.json상 필수 — 기본값을 두지 않아
// "오늘" 같은 숨은 기본값이 테스트·재현성을 해치는 걸 피했다(이 프로젝트 원칙).
// ⚠️ 기본값이 없을 뿐 네트워크 호출 전에 막지는 않는다 — 생략하면 JSON.stringify가
// undefined 필드를 조용히 빼먹은 채 필수필드 누락 요청이 그대로 나가고, NH가
// 업무오류로 거부한다(조회 전용이라 위험은 낮지만 사전검증은 아님, 호출측 주의).
export async function getKrDailyPnl({
  token, actNo, iqrStaDt, iqrEndDt, iemCd, fetchImpl,
}) {
  const input0 = { act_no: actNo, iqr_sta_dt: iqrStaDt, iqr_end_dt: iqrEndDt };
  if (iemCd != null) input0.iem_cd = iemCd;
  return callNh({ token, uri: '/krstock/inquiry/v1/dailyPnl', input0, fetchImpl });
}

// 종목별실현손익현황 조회(POST /krstock/inquiry/v1/tradingPnl). iqrStaDt·
// iqrEndDt 둘 다 필수(위와 동일 이유로 기본값 없음).
export async function getKrTradingPnl({
  token, actNo, iqrStaDt, iqrEndDt, fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/inquiry/v1/tradingPnl', fetchImpl,
    input0: { act_no: actNo, iqr_sta_dt: iqrStaDt, iqr_end_dt: iqrEndDt },
  });
}

// 주식통합증거금 현황 조회(POST /krstock/inquiry/v1/integratedMargin). act_no만
// 필요(신용거래 관련 조회지만 잔고 파악용이라 신용주문 제외와 별개로 남겨둠 —
// 신용을 안 써도 값은 0/공란으로 정상 응답될 뿐 위험이 없는 단순 조회).
export async function getKrIntegratedMargin({ token, actNo, fetchImpl }) {
  return callNh({ token, uri: '/krstock/inquiry/v1/integratedMargin', input0: { act_no: actNo }, fetchImpl });
}

// 권리보유 현황 조회(POST /krstock/inquiry/v1/rightsHeld). openapi.json엔 act_no
// 길이가 20으로 명시(다른 krstock 엔드포인트는 전부 11)이지만 2026-09-02 라이브
// 검증 결과 여느 조회와 동일한 /n2/acctinfo의 11자리 acct_no로 정상 응답(rsp_cd
// 00166) — 명세상 길이는 상한일 뿐 실제 포맷 차이는 없는 것으로 확인.
export async function getKrRightsHeld({ token, actNo, staDt, ritTpCd, fetchImpl }) {
  const input0 = { act_no: actNo };
  if (staDt != null) input0.sta_dt = staDt;
  if (ritTpCd != null) input0.rit_tp_cd = ritTpCd;
  return callNh({ token, uri: '/krstock/inquiry/v1/rightsHeld', input0, fetchImpl });
}

// 권리예정 현황 조회(POST /krstock/inquiry/v1/rightsScheduled). act_no만 필요
// (위 rightsHeld와 동일 — 11자리로 라이브 검증 완료, rsp_cd 13578).
export async function getKrRightsScheduled({ token, actNo, fetchImpl }) {
  return callNh({ token, uri: '/krstock/inquiry/v1/rightsScheduled', input0: { act_no: actNo }, fetchImpl });
}

// ============================================================================
// 시세(quote) 잔여 10종 — 2026-09-02 신설. 전부 읽기 전용, marketCd 기본값은
// getKrCurrentPrice와 통일해 'KRX'.

// 체결추이(변동거래량) 조회(POST /krstock/quote/v1/currentExecution).
export async function getKrExecutionTrend({
  token, iemCd, marketCd = 'KRX', arrayCnt = '30', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/quote/v1/currentExecution', fetchImpl,
    input0: { market_cd: marketCd, iem_cd: iemCd, array_cnt: arrayCnt },
  });
}

// 일자별 시세 조회(POST /krstock/quote/v1/currentDaily).
export async function getKrDailyPrice({
  token, iemCd, marketCd = 'KRX', arrayCnt = '30', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/quote/v1/currentDaily', fetchImpl,
    input0: { market_cd: marketCd, iem_cd: iemCd, array_cnt: arrayCnt },
  });
}

// 투자자별 거래현황 조회(POST /krstock/quote/v1/currentInvestor). arrayCnt 필수
// (openapi.json — 다른 시세 엔드포인트는 대부분 선택인데 이것만 required).
export async function getKrInvestorTrend({
  token, iemCd, marketCd = 'KRX', arrayCnt = '30', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/quote/v1/currentInvestor', fetchImpl,
    input0: { market_cd: marketCd, iem_cd: iemCd, array_cnt: arrayCnt },
  });
}

// 기간별(일/주/월/년) 시세 조회(POST /krstock/quote/v1/period). openapi.json엔
// iem_cd 길이가 9로 명시(currentPrice 등 다른 시세 엔드포인트는 6)지만
// 2026-09-02 라이브 검증 결과 6자리 단축코드로도 9자리(우측 0-padding)로도 둘
// 다 rsp_cd 00000 정상 응답 — nhplug.mjs 헤더 주석의 필드 길이 불일치 사례와
// 같은 클래스지만 이 엔드포인트는 명세상 상한일 뿐 실제로는 6자리도 받아준다.
// gubun: '1'=일(기본) '2'=주 '3'=월 '4'=년. arrayCnt 기본값 '30'은
// getKrExecutionTrend 등 나머지 시세 함수와 통일(2026-09-02 코드리뷰 LOW 지적) —
// ⚠️ gubun이 '2'(주)·'3'(월)·'4'(년)일 땐 "30건"이 뜻하는 기간이 훨씬 길어짐(30주
// ≈ 7개월, 30개월 ≈ 2.5년) — 더 긴 히스토리가 필요하면 호출측이 arrayCnt를 명시
// override할 것.
export async function getKrPeriodPrice({
  token, iemCd, marketCd = 'KRX', gubun = '1', arrayCnt = '30', edate, fetchImpl,
}) {
  const input0 = {
    market_cd: marketCd, iem_cd: iemCd, gubun, array_cnt: arrayCnt,
  };
  if (edate != null) input0.edate = edate;
  return callNh({ token, uri: '/krstock/quote/v1/period', input0, fetchImpl });
}

// 시간외 현재가 조회(POST /krstock/quote/v1/afterHoursCurrent).
export async function getKrAfterHoursCurrentPrice({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/krstock/quote/v1/afterHoursCurrent', input0: { iem_cd: iemCd }, fetchImpl });
}

// 시간외 일자별 주가 조회(POST /krstock/quote/v1/currentAfterHoursDaily). date
// (YYYYMMDD) 필수 — 기본값 없음(위 dailyPnl과 동일 원칙). gubun: '1'=정규장(기본)
// '2'=정규장+시간외단일가.
export async function getKrAfterHoursDailyPrice({
  token, iemCd, date, arrayCnt = '30', maxavg = '0', gubun = '1', fetchImpl,
}) {
  return callNh({
    token, uri: '/krstock/quote/v1/currentAfterHoursDaily', fetchImpl,
    input0: {
      iem_cd: iemCd, date, array_cnt: arrayCnt, maxavg, gubun,
    },
  });
}

// 시간외 시간별 체결가 조회(POST /krstock/quote/v1/currentAfterHoursExecution).
export async function getKrAfterHoursExecutionTrend({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/krstock/quote/v1/currentAfterHoursExecution', input0: { iem_cd: iemCd }, fetchImpl });
}

// 시간외 시간별 예상체결가 조회(POST /krstock/quote/v1/afterHoursExpected).
export async function getKrAfterHoursExpectedPrice({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/krstock/quote/v1/afterHoursExpected', input0: { iem_cd: iemCd }, fetchImpl });
}

// ETF/ETN 현재가 조회(POST /krstock/quote/v1/etfCurrent). ⚠️ openapi.json —
// 예시 응답에 명세에 없는 Output_3·Output_4 블록이 포함돼 있음("명세 검증 필요"
// 경고). 이 함수는 callNh의 raw body를 그대로 반환하므로 스키마 불일치의 영향을
// 안 받음(필드 존재 여부는 호출측이 직접 확인).
export async function getKrEtfCurrentPrice({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/krstock/quote/v1/etfCurrent', input0: { iem_cd: iemCd }, fetchImpl });
}

// ETF 구성종목 시세 조회(POST /krstock/quote/v1/etfComponents).
export async function getKrEtfComponents({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/krstock/quote/v1/etfComponents', input0: { iem_cd: iemCd }, fetchImpl });
}
