// NH PLUG 장내채권(krbond) 도메인 — 2026-09-02 신설. 오너 지시로 "현재 보유중인
// 장내채권 관련 최소 기능만" 범위 — 잔고·현재가·매수·매도·정정·취소 6개 함수만
// 구현(대용매도·대용잔고, 수익률곡선·공정가치·소액채권 등 채권 애널리틱스 계열
// 15개 조회/시세 엔드포인트는 범위 밖, 필요해지면 추가). 필드명·타입은
// openapi-docs/krbond/openapi.json 정본에서 직접 추출.
//
// act_no는 /n2/acctinfo의 acct_no를 그대로 쓴다(krstock·krgold와 동일 원칙).
// iem_cd는 KRX 채권 고유코드(예: 국고채 "C03502GB6") — krstock처럼 종목마스터
// 파일에서 조회해야 하는데 이 프로젝트는 아직 채권마스터 파서가 없다(krstock
// 헤더 주석의 "종목마스터(.mst) CP949 파서" 다음 단계 항목과 동일 미착수 상태) —
// 보유 종목의 iem_cd는 getBondBalance 실응답으로 확인할 것.
import { callNh } from './nhplug.mjs';
import {
  validateOrderInputs, validateIdentity, validateOrgOrderRef, validatePartialQty, rethrowOrderError,
  extractOrderNo,
} from './nhplug-order-safety.mjs';

// 채권 잔고조회(POST /krbond/inquiry/v1/bondBalance). iqrDit: '1'=종목별조회
// (기본, 보유 종목 단위 요약) '0'=매수일별조회(같은 종목이라도 매수일이 다르면
// 별도 행 — 세금 계산 시 필요).
export async function getBondBalance({
  token, actNo, iqrDt, iqrDit = '1', fetchImpl,
}) {
  return callNh({
    token, uri: '/krbond/inquiry/v1/bondBalance', fetchImpl,
    input0: { act_no: actNo, iqr_dt: iqrDt, iqr_dit: iqrDit },
  });
}

// 현재가조회(POST /krbond/quote/v1/bondCurrent). market: '0'=일반채권(기본,
// 이 프로젝트가 보유한 "삼척블루파워12" 같은 일반 회사채) '1'=소액채권(국민주택
// 채권 등 특수 상품, 해당 없으면 안 씀).
export async function getBondCurrentPrice({ token, iemCd, market = '0', fetchImpl }) {
  return callNh({
    token, uri: '/krbond/quote/v1/bondCurrent', fetchImpl,
    input0: { iem_cd: iemCd, market },
  });
}

// 채권매수주문(POST /krbond/order/v1/bondBuy). orrPr(주문가격) 항상 필수 —
// 금현물과 마찬가지로 채권도 시장가 개념이 없음(krstock과 다름).
export async function placeBondBuyOrder({
  token, actNo, iemCd, quantity, price, samMktEndSmoSbyYn, fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  if (price == null) { const e = new Error('채권 주문은 orr_pr(주문가격)이 필수 — 시장가 주문 없음'); e.confirmedNotSent = true; throw e; }
  const input0 = {
    act_no: actNo, iem_cd: iemCd, orr_qty: quantity, orr_pr: price,
  };
  if (samMktEndSmoSbyYn != null) input0.sam_mkt_end_smo_sby_yn = samMktEndSmoSbyYn;
  let body;
  try {
    body = await callNh({ token, uri: '/krbond/order/v1/bondBuy', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '채권 매수주문');
  return { orderNo, raw: body };
}

// 채권매도주문(POST /krbond/order/v1/bondSell). bynDt(매수일자)·synTtnDitCd(종합
// 과세구분코드: '1'=종합과세 '2'=분리과세)는 세금 계산에 직결되는 값이라 기본값을
// 두지 않는다(호출측이 실제 보유 내역 기준으로 명시 — getBondBalance의 iqrDit='0'
// 매수일별조회로 정확한 매수일을 먼저 확인할 것).
export async function placeBondSellOrder({
  token, actNo, iemCd, quantity, price, bynDt, synTtnDitCd, samMktEndSmoSbyYn, fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrderInputs({ quantity, price });
  if (price == null) { const e = new Error('채권 주문은 orr_pr(주문가격)이 필수 — 시장가 주문 없음'); e.confirmedNotSent = true; throw e; }
  if (!bynDt) { const e = new Error('채권 매도주문은 byn_dt(매수일자)가 필수 — 세금(보유기간) 계산에 직결'); e.confirmedNotSent = true; throw e; }
  if (synTtnDitCd !== '1' && synTtnDitCd !== '2') {
    const e = new Error(`synTtnDitCd는 '1'(종합과세) 또는 '2'(분리과세)여야 함: ${synTtnDitCd}`);
    e.confirmedNotSent = true; throw e;
  }
  const input0 = {
    act_no: actNo, iem_cd: iemCd, orr_qty: quantity, orr_pr: price, byn_dt: bynDt, syn_ttn_dit_cd: synTtnDitCd,
  };
  if (samMktEndSmoSbyYn != null) input0.sam_mkt_end_smo_sby_yn = samMktEndSmoSbyYn;
  let body;
  try {
    body = await callNh({ token, uri: '/krbond/order/v1/bondSell', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '채권 매도주문');
  return { orderNo, raw: body };
}

// 정정주문(POST /krbond/order/v1/bondModify). allPatDitCd: '1'=잔량(전체, 기본)
// '2'=일부(corQty 필요) — krstock과 동일 계약(공유 검증기 재사용).
export async function modifyBondOrder({
  token, actNo, orgMktOrrNo, iemCd, corPr, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  if (!(Number.isFinite(corPr) && corPr > 0)) { const e = new Error(`정정가격은 양수여야 함: ${corPr}`); e.confirmedNotSent = true; throw e; }
  const input0 = {
    act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd, cor_pr: corPr,
  };
  if (allPatDitCd === '2') input0.cor_qty = corQty;
  let body;
  try {
    body = await callNh({ token, uri: '/krbond/order/v1/bondModify', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '채권 정정');
  return { orderNo, raw: body };
}

// 취소주문(POST /krbond/order/v1/bondCancel). allPatDitCd: '1'=잔량(전체, 기본)
// '2'=일부(corQty 필요).
export async function cancelBondOrder({
  token, actNo, orgMktOrrNo, iemCd, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  const input0 = {
    act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd,
  };
  if (allPatDitCd === '2') input0.cor_qty = corQty;
  let body;
  try {
    body = await callNh({ token, uri: '/krbond/order/v1/bondCancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = extractOrderNo(body, 'mkt_orr_no', '채권 취소');
  return { orderNo, raw: body };
}
