// NH PLUG 해외주식(gbstock) 도메인 — 2026-09-02 신설. 인증·공용호출(callNh)·속도
// 제한·성공판정은 scripts/lib/nhplug.mjs가 담당, 이 파일은 gbstock 엔드포인트
// 스키마만 다룬다. 필드명·타입은 openapi-docs/gbstock/openapi.json 정본에서 직접
// 추출(공식 SDK도 해외주식 참고구현이 부실해 openapi.json 우선).
//
// act_no는 /n2/acctinfo의 acct_no를 그대로 쓴다(krstock과 동일 원칙, nhplug.mjs
// 헤더 주석 참고). fcSecTrdNatCd(외화증권거래국가코드) 기본값은 '200'(미국) —
// 이 프로젝트의 해외주식 보유가 전부 미국 시장이라(환전 계좌도 위탁 하나뿐,
// account-resolver.mjs EXCHANGE_ACCOUNT) 기본값으로 삼되 다른 시장(일본·홍콩·
// 상해·심천)도 파라미터로 지정 가능.
//
// ⚠️ krstock과의 구조적 차이(openapi.json 확인): ①호가유형코드가 '01'/'05'가
// 아니라 '00'(지정가)/'03'(시장가) — LOO·LOC·프리마켓·애프터마켓·TWAP·STOP 등
// 예외적인 호가유형은 이 프로젝트 범위 밖(2트랙 구조는 지정가·시장가만 씀,
// krstock과 동일 원칙)이라 이 두 값만 지원. ②신용대출(cfd_lon_cd)이 buy/sell
// 요청 스키마 자체에 없음(krstock의 creditBuy/creditSell처럼 별도 엔드포인트도
// 없음) — gbstock 현금매수/매도는 애초에 신용 개념이 없어 별도 배제 로직 불필요.
// ③예약주문(reservedSubmit)에만 cfd_lon_cd가 선택 필드로 존재 — krstock과 동일
// 이유로 파라미터 자체를 안 받고 '00'(현금) 고정.
import { callNh } from './nhplug.mjs';
import {
  validateOrderInputs, validateIdentity, validateOrgOrderRef, validatePartialQty, rethrowOrderError,
  validateSbyDitCd, extractOrderNo,
} from './nhplug-order-safety.mjs';

// 200=미국(기본) 070=일본 120=홍콩 160=상해 170=심천 — 이 코드체계는 fc_sec_trd_nat_cd
// (외화증권거래국가코드)와 fc_mkt_dit_cd(외화시장구분코드, cancelGbReservedOrder가
// 씀)가 동일하게 공유한다(openapi.json 확인, 2026-09-02 코드리뷰 지적으로 명시 —
// 필드명은 다르지만 값 체계가 같아서 이 상수를 두 필드 기본값으로 함께 재사용).
const FC_SEC_TRD_NAT_CD_DEFAULT = '200';

// ============================================================================
// 조회(inquiry) 8종

// 해외주식 잔고조회(POST /gbstock/inquiry/v1/balance). qutIqrDitCd: '1'=정규장
// (기본) '9'=전체. curCd: 'KRW'=전체(기본, 전 통화 합산) 'USD'/'CNY'/'HKD'/'JPY'
// 단일통화만.
export async function getGbBalance({
  token, actNo, fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, qutIqrDitCd = '1', curCd = 'KRW', xnsDitCd, fetchImpl,
}) {
  const input0 = {
    act_no: actNo, qut_iqr_dit_cd: qutIqrDitCd, fc_sec_trd_nat_cd: fcSecTrdNatCd, cur_cd: curCd,
  };
  if (xnsDitCd != null) input0.xns_dit_cd = xnsDitCd;
  return callNh({ token, uri: '/gbstock/inquiry/v1/balance', input0, fetchImpl });
}

// 매수가능금액/수량·매도가능수량 조회(POST /gbstock/inquiry/v1/buyableAmount,
// 하나의 엔드포인트를 pcsDit로 다목적 사용). pcsDit: '1'=매수가능금액 '2'=매수
// 가능수량(기본) '3'=매도가능수량 '4'=예약매수 '5'=예약매도. wtmCurKndCd: '1'=
// 거래국가통화(기본, USD 등) '2'=원화. ossOrrKndCd: '1'=GTS(미국시장주문, 기본).
// ahiNmnPrTpCd: '00'=지정가(기본, price 필요) '03'=시장가.
export async function getGbBuyableAmount({
  token, actNo, iemCd, pcsDit = '2', fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, price,
  wtmCurKndCd = '1', ossOrrKndCd = '1', ahiNmnPrTpCd = '00', fetchImpl,
}) {
  const input0 = {
    act_no: actNo, pcs_dit: pcsDit, fc_sec_trd_nat_cd: fcSecTrdNatCd, iem_cd: iemCd,
    wtm_cur_knd_cd: wtmCurKndCd, oss_orr_knd_cd: ossOrrKndCd, ahi_nmn_pr_tp_cd: ahiNmnPrTpCd,
  };
  if (price != null) input0.fc_orr_uit_pr = price;
  return callNh({ token, uri: '/gbstock/inquiry/v1/buyableAmount', input0, fetchImpl });
}

// 일별거래내역 조회(POST /gbstock/inquiry/v1/dailyTransaction). actTrdCfcCd:
// '00'=전체(기본). iemMlfCd: '00001'=외화주식(기본, 이 프로젝트가 다루는 유일한
// 종류 — 채권·Warrant·수익증권은 krbond 등 별도 도메인).
export async function getGbDailyTransaction({
  token, actNo, iqrStaDt, iqrEndDt, actTrdCfcCd = '00', iemMlfCd = '00001', iemCd, fetchImpl,
}) {
  const input0 = {
    act_no: actNo, iqr_sta_dt: iqrStaDt, iqr_end_dt: iqrEndDt, act_trd_cfc_cd: actTrdCfcCd, iem_mlf_cd: iemMlfCd,
  };
  if (iemCd != null) input0.iem_cd = iemCd;
  return callNh({ token, uri: '/gbstock/inquiry/v1/dailyTransaction', input0, fetchImpl });
}

// 해외증거금 통화별 조회(POST /gbstock/inquiry/v1/margin). act_no만 필요.
export async function getGbMargin({ token, actNo, fetchImpl }) {
  return callNh({ token, uri: '/gbstock/inquiry/v1/margin', input0: { act_no: actNo }, fetchImpl });
}

// 기간손익 조회(POST /gbstock/inquiry/v1/periodPnl). iqrDit: '1'=거래통화기준
// (기본) '2'=원화기준. staOrrDt·endOrrDt 필수(기본값 없음 — 이 프로젝트 원칙,
// krstock getKrDailyPnl 등과 동일하게 "오늘" 같은 숨은 기본값 안 둠).
export async function getGbPeriodPnl({
  token, actNo, iqrDit = '1', staOrrDt, endOrrDt, iemCd, trdCurCd, fcSecTrdNatCd, fetchImpl,
}) {
  const input0 = {
    act_no: actNo, iqr_dit: iqrDit, sta_orr_dt: staOrrDt, end_orr_dt: endOrrDt,
  };
  if (iemCd != null) input0.iem_cd = iemCd;
  if (trdCurCd != null) input0.trd_cur_cd = trdCurCd;
  if (fcSecTrdNatCd != null) input0.fc_sec_trd_nat_cd = fcSecTrdNatCd;
  return callNh({ token, uri: '/gbstock/inquiry/v1/periodPnl', input0, fetchImpl });
}

// 기간손익 상세 조회(POST /gbstock/inquiry/v1/periodPnlDetail). orrDt 필수
// (특정 하루 단위 상세 — periodPnl과 달리 기간이 아니라 단일 일자).
export async function getGbPeriodPnlDetail({
  token, actNo, iqrDit = '1', orrDt, iemCd, fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, trdCurCd = 'USD', fetchImpl,
}) {
  const input0 = {
    act_no: actNo, iqr_dit: iqrDit, orr_dt: orrDt, fc_sec_trd_nat_cd: fcSecTrdNatCd, trd_cur_cd: trdCurCd,
  };
  if (iemCd != null) input0.iem_cd = iemCd;
  return callNh({ token, uri: '/gbstock/inquiry/v1/periodPnlDetail', input0, fetchImpl });
}

// 예약주문조회(POST /gbstock/inquiry/v1/reservedInquiry). 전부 '전체' 기본값
// (fcMktDitCd='000' bkgOrrCanYn='0' ossOrrKndCd='0' bkgOrrTpCd='0' wtmCurKndCd='0').
export async function getGbReservedOrders({
  token, actNo, bkgOrrDt, fcMktDitCd = '000', iemCd, sbyDitCd = '0',
  bkgOrrCanYn = '0', ossOrrKndCd = '0', bkgOrrTpCd = '0', wtmCurKndCd = '0', fetchImpl,
}) {
  const input0 = {
    fc_mkt_dit_cd: fcMktDitCd, bkg_orr_dt: bkgOrrDt, act_no: actNo, sby_dit_cd: sbyDitCd,
    bkg_orr_can_yn: bkgOrrCanYn, oss_orr_knd_cd: ossOrrKndCd, bkg_orr_tp_cd: bkgOrrTpCd, wtm_cur_knd_cd: wtmCurKndCd,
  };
  if (iemCd != null) input0.iem_cd = iemCd;
  return callNh({ token, uri: '/gbstock/inquiry/v1/reservedInquiry', input0, fetchImpl });
}

// 주문체결내역 조회(POST /gbstock/inquiry/v1/unexecuted) — 이름과 달리 체결·
// 미체결 둘 다 ostCnsDit로 필터하는 통합 조회(krstock의 getKrDailyOrderExecution
// 에 대응, "체결조회" 요구사항을 이 함수가 충족). ostCnsDit: '0'=전체(기본)
// '1'=체결 '2'=미체결. sotDit: '0'=주문번호순(기본).
export async function getGbUnexecuted({
  token, actNo, orrDt, iemCd, ossSbyDitCd = '0', sotDit = '0', orrNo, ostCnsDit = '0', fetchImpl,
}) {
  const input0 = {
    orr_dt: orrDt, act_no: actNo, oss_sby_dit_cd: ossSbyDitCd, sot_dit: sotDit, ost_cns_dit: ostCnsDit,
  };
  if (iemCd != null) input0.iem_cd = iemCd;
  if (orrNo != null) input0.orr_no = orrNo;
  return callNh({ token, uri: '/gbstock/inquiry/v1/unexecuted', input0, fetchImpl });
}

// ============================================================================
// 시세(quote) 4종

// 현재가상세 조회(POST /gbstock/quote/v1/current).
export async function getGbCurrentPrice({ token, iemCd, fetchImpl }) {
  return callNh({ token, uri: '/gbstock/quote/v1/current', input0: { iem_cd: iemCd }, fetchImpl });
}

// 체결추이 조회(POST /gbstock/quote/v1/executionTrend). periodType: '1'=시간별
// (기본) '2'=일별.
export async function getGbExecutionTrend({
  token, iemCd, periodType = '1', reqCnt = 30, fetchImpl,
}) {
  return callNh({
    token, uri: '/gbstock/quote/v1/executionTrend', fetchImpl,
    input0: { period_type: periodType, req_cnt: reqCnt, iem_cd: iemCd },
  });
}

// 기간별시세(개별종목) 조회(POST /gbstock/quote/v1/period). gubun: '3'=일(기본)
// '1'=틱 '2'=분 '4'=주 '5'=월. endDt 필수(기본값 없음 — 호출측이 명시).
export async function getGbPeriodPrice({
  token, iemCd, endDt, count = '30', maxavg = '0', gubun = '3', xtick = '0001',
  todayCls = '0', marketCls = '1', fetchImpl,
}) {
  return callNh({
    token, uri: '/gbstock/quote/v1/period', fetchImpl,
    input0: {
      iem_cd: iemCd, end_dt: endDt, count, maxavg, gubun, xtick, today_cls: todayCls, market_cls: marketCls,
    },
  });
}

// 기간별시세(지수·환율) 조회(POST /gbstock/quote/v1/symbolIndexFxPeriod). 개별
// 종목이 아니라 지수·환율 심볼(예: 원달러환율 등) 전용 — iemCd에 그 심볼 코드를
// 넣는다(종목 티커와 다른 코드 체계, openapi.json엔 구체 예시가 없어 실사용 시
// 심볼 목록 확인 필요). gubun: '1'=일(기본) '2'=주 '3'=월.
export async function getGbSymbolIndexFxPeriod({
  token, iemCd, endDt, arrayCnt = '30', maxavg = '0', gubun = '1', xtick, todayCls = '0', scaleChange, fetchImpl,
}) {
  const input0 = {
    iem_cd: iemCd, end_dt: endDt, array_cnt: arrayCnt, maxavg, gubun, today_cls: todayCls,
  };
  if (xtick != null) input0.xtick = xtick;
  if (scaleChange != null) input0.scale_change = scaleChange;
  return callNh({ token, uri: '/gbstock/quote/v1/symbolIndexFxPeriod', input0, fetchImpl });
}

// ============================================================================
// 주문(order) 6종 — 안전장치는 nhplug-order-safety.mjs 공유(krstock·krgold와
// 동일 계약: confirmedNotSent=true는 "확실히 안 나감", 안 붙으면 "불명").

const ORDER_TYPE_CODE = { 지정가: '00', 시장가: '03' };

// 소수점 2자리 검증(2026-09-02 코드리뷰 MEDIUM 지적) — openapi.json이 fc_orr_uit_pr
// (외화주문단가)을 "소수점 2자리까지"로 명시한 유일한 필드(krstock·krgold는 전부
// 정수 KRW라 이 문제 자체가 없었음). 계산된 가격(예: 목표비중 역산)이 소수점
// 3자리 이상으로 나오면 NH가 반올림하는지 거부하는지 미검증이라, 사전에 막아
// confirmedNotSent=true로 안전하게 처리한다(불명 상태로 실주문에 넘기지 않음).
function validateTwoDecimalPrice(price) {
  if (Math.round(price * 100) !== price * 100) {
    const e = new Error(`외화주문단가(fc_orr_uit_pr)는 소수점 2자리까지만 허용: ${price}`);
    e.confirmedNotSent = true; throw e;
  }
}

async function placeCashOrder(uri, {
  token, actNo, iemCd, quantity, price, fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, wtmCurKndCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  if (price != null) validateTwoDecimalPrice(price);
  const ahiNmnPrTpCd = price != null ? ORDER_TYPE_CODE.지정가 : ORDER_TYPE_CODE.시장가;
  const input0 = {
    act_no: actNo, fc_sec_trd_nat_cd: fcSecTrdNatCd, iem_cd: iemCd, orr_qty: quantity,
    ahi_nmn_pr_tp_cd: ahiNmnPrTpCd, wtm_cur_knd_cd: wtmCurKndCd,
  };
  if (price != null) input0.fc_orr_uit_pr = price;

  let body;
  try {
    body = await callNh({ token, uri, input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'orr_no', '주문');
  return { orderNo, raw: body };
}

// 해외주식 매수주문(POST /gbstock/order/v1/buy). price 생략 시 시장가.
export async function placeGbBuyOrder(args) {
  return placeCashOrder('/gbstock/order/v1/buy', args);
}

// 해외주식 매도주문(POST /gbstock/order/v1/sell). price 생략 시 시장가.
export async function placeGbSellOrder(args) {
  return placeCashOrder('/gbstock/order/v1/sell', args);
}

// 정정주문(POST /gbstock/order/v1/modify). corPr(정정가격)이 필수 — krstock·
// krbond와 파라미터명은 통일했지만 실제 필드는 cor_pr이 아니라 fc_orr_uit_pr
// (openapi.json엔 modify 엔드포인트에 cor_pr 필드 자체가 없음, 2026-09-02
// 코드리뷰 지적 — 다른 도메인과 diff할 때 헷갈리기 쉬워 명시). krstock과 달리
// 이 엔드포인트엔 시장가 정정 개념이 없음(openapi.json에 required로 명시).
export async function modifyGbOrder({
  token, actNo, orgOrrNo, iemCd, corPr, fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo: orgOrrNo, label: '원주문번호(orgOrrNo)' });
  if (!(Number.isFinite(corPr) && corPr > 0)) { const e = new Error(`정정가격은 양수여야 함: ${corPr}`); e.confirmedNotSent = true; throw e; }
  validateTwoDecimalPrice(corPr);
  const input0 = {
    act_no: actNo, fc_sec_trd_nat_cd: fcSecTrdNatCd, iem_cd: iemCd, org_orr_no: orgOrrNo, fc_orr_uit_pr: corPr,
  };
  let body;
  try {
    body = await callNh({ token, uri: '/gbstock/order/v1/modify', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'orr_no', '정정');
  return { orderNo, raw: body };
}

// 취소주문(POST /gbstock/order/v1/cancel). allPatDitCd: '1'=전체(기본) '2'=일부
// (canQty 필요) — krstock의 allPatDitCd/corQty 상호관계 검증과 동일 계약이라
// 공유 검증기(validatePartialQty)를 그대로 재사용(파라미터명만 canQty로 매핑).
export async function cancelGbOrder({
  token, actNo, orgOrrNo, iemCd, canQty, allPatDitCd = '1', fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo: orgOrrNo, label: '원주문번호(orgOrrNo)' });
  validatePartialQty({ allPatDitCd, corQty: canQty });
  const input0 = {
    act_no: actNo, org_orr_no: orgOrrNo, fc_sec_trd_nat_cd: fcSecTrdNatCd, iem_cd: iemCd, all_pat_dit_cd: allPatDitCd,
  };
  if (allPatDitCd === '2') input0.can_qty = canQty;
  let body;
  try {
    body = await callNh({ token, uri: '/gbstock/order/v1/cancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'orr_no', '취소');
  return { orderNo, raw: body };
}

// 예약주문접수(POST /gbstock/order/v1/reservedSubmit). ossSbyDitCd: '1'=매도
// '2'=매수(krstock 예약주문과 동일 체계 — validateSbyDitCd 재사용). ⚠️ bkgOrrTpCd·
// cfdLonCd·orrPdtDitCd·nmnPrTpCd·ossOrrKndCd는 krstock 예약주문과 동일 이유
// (코드리뷰 HIGH 지적 반영 원칙)로 파라미터를 안 받고 안전한 값 하나로 고정 —
// 기간예약(2·3)·신용예약·교체/Stop예약(02·03)·STOP류 호가유형(15·16, 조건부
// 필수 fc_stop_orr_bse_pr 필요)·비-GTS 주문종류(2·3)는 이 함수가 못 받는 조건부
// 필수 필드가 딸려 있다. nmnPrTpCd는 2026-09-02 코드리뷰 HIGH 지적 — 처음엔
// 파라미터로 노출해뒀는데 validateFixedOption을 안 불러서 '15'(STOP) 같은 값이
// fc_stop_orr_bse_pr 없이 그대로 나갈 뻔했다(krstock 예약주문 HIGH 재발 패턴).
export async function placeGbReservedOrder({
  token, actNo, iemCd, sbyDitCd, quantity, price,
  fcSecTrdNatCd = FC_SEC_TRD_NAT_CD_DEFAULT, wtmCurKndCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  validateSbyDitCd(sbyDitCd);
  if (price == null) { const e = new Error('예약주문은 fc_orr_uit_pr(주문단가)이 필수 — 가격 없이 호출 불가'); e.confirmedNotSent = true; throw e; }
  validateTwoDecimalPrice(price);
  const input0 = {
    act_no: actNo, fc_sec_trd_nat_cd: fcSecTrdNatCd, iem_cd: iemCd, oss_sby_dit_cd: sbyDitCd,
    orr_qty: quantity, fc_orr_uit_pr: price, nmn_pr_tp_cd: '00', oss_orr_knd_cd: '1',
    bkg_orr_tp_cd: '1', wtm_cur_knd_cd: wtmCurKndCd, orr_pdt_dit_cd: '00', cfd_lon_cd: '00',
  };
  let body;
  try {
    body = await callNh({ token, uri: '/gbstock/order/v1/reservedSubmit', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'bkg_rtn_orr_no', '예약주문');
  return { orderNo, raw: body };
}

// 예약주문접수취소(POST /gbstock/order/v1/reservedCancel). ⚠️ 응답에 주문식별
// 번호가 없음(Output_0엔 wrk_rlt_cd(작업결과코드)만 있음, openapi.json 확인) —
// krstock·gbstock의 다른 주문함수들과 달리 "성공인데 식별번호 없음" 판정을 못
// 쓴다. 성공 여부는 callNh의 rsp_cd(공통 성공판정, nhplug.mjs isNhSuccess)로만
// 확인한다. openapi.json은 "응답 블록은 데이터가 있을 때만 내려옵니다"라고 경고
// — 성공 rsp_cd인데 Output_0 자체가 없을 수 있으므로 wrkRltCd가 undefined여도
// 그 자체를 실패로 보지 않는다(callNh가 이미 rsp_cd로 성공을 확정한 뒤이므로).
export async function cancelGbReservedOrder({
  token, actNo, fcMktDitCd = FC_SEC_TRD_NAT_CD_DEFAULT, bkgOrrDt, bkgRtnOrrNo, iemCd, fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo: bkgRtnOrrNo, label: '예약접수주문번호(bkgRtnOrrNo)' });
  // bkgOrrDt(예약주문일자)는 openapi.json상 필수인데 사전검증이 없었다(2026-09-02
  // 코드리뷰 MEDIUM 지적 — 10개 신규 주문함수 중 유일하게 필수필드 검증이 빠진
  // 채였음, 생략하면 JSON.stringify가 조용히 빼먹고 필수필드 누락 요청이 나감).
  if (!/^\d{8}$/.test(String(bkgOrrDt ?? ''))) {
    const e = new Error(`예약주문일자(bkgOrrDt)는 YYYYMMDD 8자리 숫자여야 함: ${bkgOrrDt}`);
    e.confirmedNotSent = true; throw e;
  }
  const input0 = {
    act_no: actNo, fc_mkt_dit_cd: fcMktDitCd, bkg_orr_dt: bkgOrrDt, bkg_rtn_orr_no: bkgRtnOrrNo, iem_cd: iemCd, orr_pdt_dit_cd: '00',
  };
  let body;
  try {
    body = await callNh({ token, uri: '/gbstock/order/v1/reservedCancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  return { wrkRltCd: body?.Output_0?.wrk_rlt_cd, raw: body };
}
