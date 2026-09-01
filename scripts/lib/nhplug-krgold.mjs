// NH PLUG 국내금현물(krgold) 도메인 — 2026-09-01 신설. 인증·공용호출(callNh)·속도제한·
// 성공판정은 scripts/lib/nhplug.mjs, 주문 안전장치는 scripts/lib/nhplug-order-safety.mjs
// 공유. 필드명·타입은 openapi-docs/krgold/openapi.json 정본 + NH API 가이드 포털
// 실제 예시(https://www.nhplug.com/apiservice, 금현물_주문 카테고리)로 교차검증했다
// (2026-09-01) — 공식 SDK(nhplug-sdk)엔 금현물 참고코드가 전혀 없어(README 한 줄
// "전문 IVOGLDREQ01로 조회"만 언급, 실제 REST 구현·예제 없음) krstock처럼 SDK 코드를
// 베낄 수 없었고, 처음부터 openapi.json 스펙만으로 작성했다. 실제로는 REST 엔드포인트가
// 멀쩡히 있다(IVOGLDREQ01 언급은 SDK 문서가 낡았거나 다른 접근 경로를 가리키는 것으로
// 추정 — 이 파일이 쓰는 /krgold/... REST 경로가 API 가이드 포털의 정본).
//
// 주식(krstock)과의 구조적 차이(둘 다 openapi.json으로 직접 확인):
//   - orr_pr(주문가격)이 매수·매도 둘 다 필수 — 시장가 주문 개념 자체가 없음(주식은
//     price 생략 시 시장가 지원, 금현물은 항상 지정가만).
//   - ivs_uag_yn(투자용도여부: 1.산업용 2.투자용)이 주문마다 필수 — 개인 투자 목적
//     계좌라 기본값 '2'(투자용)로 고정(호출측이 명시적으로 바꿀 수는 있게 열어둠).
//   - 정정(goldModify)에 sop_cnd_pr(정지조건가격) 필드 자체가 없음(주식은 있음) —
//     금현물엔 스톱지정가 주문 개념이 없어서로 추정.
//   - rmt_mkt_cd·sor_mkt_sli_yn·ssl_nmn_pr_dit_cd(SOR·공매도 관련) 필드가 아예 없음 —
//     이 개념들이 전부 KRX 주식시장 구조 전용이라 금현물엔 해당 안 됨.
//   - 모의투자 도메인 자체가 없음(API 가이드 포털에 "모의투자 도메인: 미제공"으로
//     명시) — 이 코드베이스는 어차피 실전 도메인만 쓰므로(nhplug.mjs 헤더 주석) 영향 없음.
//
// act_no는 /n2/acctinfo의 acct_no를 그대로 쓴다(운영 acct_type 01·02만 유효).
// iem_cd: 금 1kg=M04020000, 미니금 100g=M04020100(종목마스터 파일이 없는 유일한
// 자산군이라 이 두 코드는 openapi.json Description에 직접 명시돼 있음, krstock처럼
// .mst 파일에서 조회하는 방식이 아니라 고정된 값 그대로 씀).
import { callNh } from './nhplug.mjs';
import {
  validateOrderInputs, validateIdentity, validateOrgOrderRef, validatePartialQty, rethrowOrderError,
} from './nhplug-order-safety.mjs';

export const GOLD_ITEM_CODE = { 금1kg: 'M04020000', 미니금100g: 'M04020100' };
const VALID_GOLD_ITEM_CODES = new Set(Object.values(GOLD_ITEM_CODE));

// 종목코드 화이트리스트 검증 — 주문 계열 함수 전용(2026-09-02 코드리뷰 MEDIUM 지적).
// krstock은 종목이 수천 개라 화이트리스트가 불가능하지만, 금현물은 정확히 이 두
// 코드뿐이다(종목마스터 파일 자체가 없는 이유이기도 함, 위 파일 헤더 주석 참고) —
// 값을 모를 가능성이 없는데 안 막아둘 이유가 없다. iemCd가 오타로 다른 값이면
// (예: 두 코드를 헷갈려 '미니금 100g' 대신 '금 1kg' 코드로 10개 주문) NH가 그냥
// 받아버릴 수 있어 여기서 먼저 막는다.
function validateGoldItemCode(iemCd) {
  if (!VALID_GOLD_ITEM_CODES.has(iemCd)) {
    const e = new Error(`iemCd는 금현물 종목코드(${[...VALID_GOLD_ITEM_CODES].join('·')}) 중 하나여야 함: ${iemCd}`);
    e.confirmedNotSent = true; throw e;
  }
}

// 예수금및잔고조회(POST /krgold/inquiry/v1/goldDepositAndBalance). act_no만 필요
// (krstock 잔고조회처럼 조회조건 코드가 여러 개 없음 — 금현물은 단순).
export async function getGoldBalance({ token, actNo, fetchImpl }) {
  return callNh({
    token, uri: '/krgold/inquiry/v1/goldDepositAndBalance', fetchImpl,
    input0: { act_no: actNo },
  });
}

// 현재가조회(POST /krgold/quote/v1/goldCurrent). iemCd 길이 9(주문 API의 12와 다름 —
// openapi.json에 그대로 그렇게 돼 있음, 실제 값 자체(M04020000)는 동일하게 씀).
export async function getGoldCurrentPrice({ token, iemCd, fetchImpl }) {
  return callNh({
    token, uri: '/krgold/quote/v1/goldCurrent', fetchImpl,
    input0: { iem_cd: iemCd },
  });
}

// 주문가능수량조회(POST /krgold/inquiry/v1/goldOrderableQuantity). sbyDitCd:
// '1'=매도 '2'=매수(krstock의 ost_dit_cd와 이름·값 둘 다 다름 — 별개 필드).
// price(orr_pr)는 openapi.json에 "선택"으로 명시돼 있다(주문 API의 orr_pr은
// 필수인 것과 다름, 2026-09-02 코드리뷰 질문에 대한 답 — 재확인함) — 특정 가격
// 기준이 아니라 "지금 낼 수 있는 최대 주문가능수량" 자체를 물을 때는 생략 가능.
export async function getGoldOrderableQuantity({ token, actNo, iemCd, sbyDitCd, price, fetchImpl }) {
  if (sbyDitCd !== '1' && sbyDitCd !== '2') {
    throw new Error(`sbyDitCd는 '1'(매도) 또는 '2'(매수)여야 함: ${sbyDitCd}`);
  }
  const input0 = { act_no: actNo, sby_dit_cd: sbyDitCd, iem_cd: iemCd };
  if (price != null) input0.orr_pr = price;
  return callNh({ token, uri: '/krgold/inquiry/v1/goldOrderableQuantity', input0, fetchImpl });
}

// 주문 계열(goldBuy·goldSell·goldModify·goldCancel) 안전장치는 nhplug-order-safety.mjs
// 공유(krstock과 동일 계약 — "확실히 안 나감"·"불명"을 confirmedNotSent로 구분).
const IVS_UAG_YN_DEFAULT = '2'; // 투자용(개인 투자 목적 계좌 — 산업용 '1'은 이 프로젝트 범위 밖)

async function placeGoldOrder(uri, { token, actNo, iemCd, quantity, price, ivsUagYn = IVS_UAG_YN_DEFAULT, fetchImpl }) {
  validateIdentity({ actNo, iemCd });
  validateGoldItemCode(iemCd);
  // 금현물은 orr_pr이 매수·매도 둘 다 필수(시장가 개념 없음, 위 파일 헤더 주석) —
  // validateOrderInputs는 price==null이면 검증을 생략하므로 여기서 별도로 필수 체크.
  if (price == null) { const e = new Error('금현물 주문은 orr_pr(주문가격)이 필수 — 시장가 주문 없음'); e.confirmedNotSent = true; throw e; }
  validateOrderInputs({ quantity, price });
  if (ivsUagYn !== '1' && ivsUagYn !== '2') {
    const e = new Error(`ivsUagYn(투자용도여부)은 '1'(산업용) 또는 '2'(투자용)여야 함: ${ivsUagYn}`); e.confirmedNotSent = true; throw e;
  }
  const input0 = {
    act_no: actNo, iem_cd: iemCd, orr_qty: quantity, orr_pr: price,
    // orr_cnd_dit_cd(주문조건구분코드): 00.없음 01.IOC 02.FOK — krstock cashBuy/Sell과
    // 동일 필드·동일 코드값, 조건 없는 일반 주문.
    orr_cnd_dit_cd: '00',
    ivs_uag_yn: ivsUagYn,
  };

  let body;
  try {
    body = await callNh({ token, uri, input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 금현물 주문 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 체결 여부 불확실, 즉시 확인 필요');
  return { orderNo, raw: body };
}

// 금현물 매수주문(POST /krgold/order/v1/goldBuy). price 필수(금현물은 시장가 없음).
export async function placeGoldBuyOrder(args) {
  return placeGoldOrder('/krgold/order/v1/goldBuy', args);
}

// 금현물 매도주문(POST /krgold/order/v1/goldSell). price 필수.
export async function placeGoldSellOrder(args) {
  return placeGoldOrder('/krgold/order/v1/goldSell', args);
}

// 정정주문(POST /krgold/order/v1/goldModify). allPatDitCd: '1'=전체(전량) '2'=일부
// (잔량, corQty 필요) — krstock과 동일 관례로 용어 통일(2026-09-02 코드리뷰 지적 —
// 예전엔 이 파일이 '1'=잔량(전체)로 krstock과 반대로 적어놔서 헷갈릴 뻔했음,
// 실제 코드 동작은 처음부터 같았음, 주석 문구만 정정). corPr: 정정가격(필수).
// krstock의 modify와 달리 sop_cnd_pr 필드 자체가 없음(위 파일 헤더 주석 — 금현물엔
// 스톱지정가 개념이 없어서로 추정).
export async function modifyGoldOrder({
  token, actNo, orgMktOrrNo, iemCd, corPr, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateGoldItemCode(iemCd);
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  if (!(Number.isFinite(corPr) && corPr > 0)) { const e = new Error(`정정가격은 양수여야 함: ${corPr}`); e.confirmedNotSent = true; throw e; }
  const input0 = { act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd, cor_pr: corPr };
  if (allPatDitCd === '2') input0.cor_qty = corQty;

  let body;
  try {
    body = await callNh({ token, uri: '/krgold/order/v1/goldModify', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 금현물 정정 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 정정 여부 불확실, 즉시 확인 필요');
  return { orderNo, raw: body };
}

// 취소주문(POST /krgold/order/v1/goldCancel). allPatDitCd: '1'=전체(전량) '2'=일부
// (잔량, corQty 필요) — krstock cancel과 필드 구성 동일.
export async function cancelGoldOrder({
  token, actNo, orgMktOrrNo, iemCd, corQty, allPatDitCd = '1', fetchImpl,
}) {
  validateIdentity({ actNo, iemCd });
  validateGoldItemCode(iemCd);
  validateOrgOrderRef({ orgMktOrrNo });
  validatePartialQty({ allPatDitCd, corQty });
  const input0 = { act_no: actNo, org_mkt_orr_no: orgMktOrrNo, all_pat_dit_cd: allPatDitCd, iem_cd: iemCd };
  if (allPatDitCd === '2') input0.cor_qty = corQty;

  let body;
  try {
    body = await callNh({ token, uri: '/krgold/order/v1/goldCancel', input0, fetchImpl });
  } catch (e) {
    rethrowOrderError(e);
  }
  const orderNo = String(body?.Output_0?.mkt_orr_no ?? '').trim();
  if (!orderNo) throw new Error('NH PLUG 금현물 취소 응답에 시장주문번호(mkt_orr_no) 없음 — 실제 취소 여부 불확실, 즉시 확인 필요');
  return { orderNo, raw: body };
}
