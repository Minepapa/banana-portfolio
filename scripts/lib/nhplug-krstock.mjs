// NH PLUG 국내주식(krstock) 도메인 — 2026-09-01 신설. 인증·공용호출(callNh)·속도제한·
// 성공판정은 scripts/lib/nhplug.mjs가 담당, 이 파일은 krstock 엔드포인트 스키마만 다룬다.
// 필드명·타입은 openapi-docs/krstock/openapi.json 정본에서 직접 추출(공식 SDK
// nhplug-sdk엔 정정·취소 참고구현이 아예 없어 SDK가 아니라 openapi.json으로 검증).
//
// act_no는 /n2/acctinfo의 acct_no를 그대로 쓴다(운영 acct_type 01·02만 유효 — 이
// 코드베이스는 항상 실전 도메인만 호출하므로 03 계좌는 애초에 안 옴, nhplug.mjs
// 헤더 주석 참고).
import { callNh } from './nhplug.mjs';

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

// ⚠️ 주문 계열(cashBuy·cashSell·modify·cancel) 안전장치 — kis.mjs placeKrOrder와 동일
// 철학(2026-08-09 코드리뷰로 확정된 원칙, 이 프로젝트 전역 규칙):
//   - 네트워크 호출 전 입력검증 실패 → confirmedNotSent=true(절대 안 나감, 안전하게 롤백 가능)
//   - NH가 명시적으로 업무거부(callNh의 err.businessRejection=true) → confirmedNotSent=true
//   - 응답은 성공인데 mkt_orr_no가 없음 → confirmedNotSent 절대 안 붙임(가장 위험한
//     "불명" 상태 — 실제로는 접수됐을 수 있음, 호출측이 즉시 수동 확인해야 함)
//   - 네트워크 예외(fetch 자체가 throw)·JSON 아닌 응답·429 유량초과·HTTP 4xx/5xx →
//     confirmedNotSent 안 붙임(불명 — nhplug.mjs callNh의 err.businessRejection 계약 참고)
//
// ⚠️ 2026-09-01 코드리뷰 HIGH 지적으로 재작성 — 예전엔 `if (e.code)`로 승격 여부를
// 판단했는데, callNh가 429(유량초과, err.code='RATE_LIMIT')에도 err.code를 붙이고
// 있어서 유량초과로 실패한 주문이 "확실히 안 나감"으로 잘못 승격될 수 있었다(실측
// 재현됨 — 게이트웨이 단 429는 주문이 브로커까지 도달했는지 전혀 말해주지 않는다).
// 지금은 callNh가 명시적 업무거부에만 세우는 `err.businessRejection`만 본다.
const ORDER_TYPE_CODE = { 지정가: '01', 시장가: '05' };

function validateOrderInputs({ quantity, price }) {
  if (!(Number.isInteger(quantity) && quantity > 0)) {
    const e = new Error(`주문수량은 양의 정수여야 함: ${quantity}`); e.confirmedNotSent = true; throw e;
  }
  if (price != null && !(price > 0)) {
    const e = new Error(`주문단가는 양수여야 함: ${price}`); e.confirmedNotSent = true; throw e;
  }
}

// 계좌·종목 식별자 검증(2026-09-01 코드리뷰 HIGH 지적 — 예전엔 quantity/price만
// 검증해서 actNo·iemCd가 undefined여도 그대로 네트워크에 나갔다. JSON.stringify가
// undefined 필드를 조용히 생략하기 때문에 "계좌·종목 없는 주문"이 겉보기엔 정상
// 요청처럼 브로커에 전송될 수 있었다 — 실측 재현: quantity/price만 채우고 actNo·
// iemCd를 빼면 Input_0에 그 두 필드가 아예 없는 채로 나감).
function validateIdentity({ actNo, iemCd }) {
  if (!String(actNo ?? '').trim()) { const e = new Error('계좌번호(actNo) 필수'); e.confirmedNotSent = true; throw e; }
  if (!String(iemCd ?? '').trim()) { const e = new Error('종목코드(iemCd) 필수'); e.confirmedNotSent = true; throw e; }
}

// 정정/취소 대상 원주문번호 검증 — modify·cancel 전용(주문 자체가 없던 place와 달리
// "어느 주문을 건드릴지"가 반드시 있어야 함, 이것도 위와 같은 이유로 예전엔 검증이
// 아예 없었다).
function validateOrgOrderRef({ orgMktOrrNo }) {
  if (!(Number.isInteger(orgMktOrrNo) && orgMktOrrNo > 0)) {
    const e = new Error(`원주문번호(orgMktOrrNo)는 양의 정수여야 함: ${orgMktOrrNo}`); e.confirmedNotSent = true; throw e;
  }
}

// allPatDitCd('1'=전체·'2'=일부)와 corQty의 상호관계 검증(2026-09-01 코드리뷰 HIGH
// 지적 — 예전엔 `if (allPatDitCd === '2') input0.cor_qty = corQty;`만 있어서
// ①corQty를 줬는데 allPatDitCd를 '2'로 안 바꾸면 corQty가 조용히 버려지고 "전체"로
// 처리되고(부분취소 의도가 전량취소로 실행됨) ②allPatDitCd='2'인데 corQty를 깜빡하면
// NH에 cor_qty 없이 나가는 두 가지 실수가 전부 조용히 통과됐다. 둘 다 돈이 움직이는
// 실수라 네트워크 호출 전에 막는다.
function validatePartialQty({ allPatDitCd, corQty }) {
  if (allPatDitCd === '2') {
    if (!(Number.isInteger(corQty) && corQty > 0)) {
      const e = new Error(`일부(allPatDitCd='2') 처리는 corQty(정정/취소 수량)가 양의 정수여야 함: ${corQty}`);
      e.confirmedNotSent = true; throw e;
    }
  } else if (corQty != null) {
    const e = new Error(`corQty를 지정했지만 allPatDitCd가 '2'(일부)가 아님 — 이대로면 corQty가 무시되고 전체(1)로 처리됨. allPatDitCd:'2'를 함께 지정할 것`);
    e.confirmedNotSent = true; throw e;
  }
}

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
    if (e.businessRejection) e.confirmedNotSent = true; // NH가 명시적으로 거부한 경우만 승격
    throw e;
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 주문 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 체결 여부 불확실, 즉시 확인 필요');
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
  if (!(corPr > 0)) { const e = new Error(`정정가격은 양수여야 함: ${corPr}`); e.confirmedNotSent = true; throw e; }
  const input0 = {
    act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd,
    cor_pr: corPr, sop_cnd_pr: 0, rmt_mkt_cd: 'KRX', sor_mkt_sli_yn: 'N',
  };
  if (allPatDitCd === '2') input0.cor_qty = corQty;

  let body;
  try {
    body = await callNh({ token, uri: '/krstock/order/v1/modify', input0, fetchImpl });
  } catch (e) {
    if (e.businessRejection) e.confirmedNotSent = true;
    throw e;
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 정정 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 정정 여부 불확실, 즉시 확인 필요');
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
    if (e.businessRejection) e.confirmedNotSent = true;
    throw e;
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 취소 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 취소 여부 불확실, 즉시 확인 필요');
  return { orderNo, raw: body };
}
