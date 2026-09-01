// NH PLUG 주문 계열(현금/신용 매수·매도·정정·취소, 국내주식·금현물 등 모든 자산군
// 공통) 안전장치 — 2026-09-01 신설, krstock 코드리뷰(HIGH 4건) 반영 과정에서 만든
// 검증 로직을 krgold의 두 번째 소비자가 생기면서 공유 모듈로 뺐다(원래는
// nhplug-krstock.mjs에만 있었음 — 자산군마다 이 안전장치를 복붙하면 한쪽만 고치는
// 회귀 위험이 생겨서, 두 번째 자산군이 생기는 이 시점에 분리).
//
// kis.mjs placeKrOrder와 동일 철학(2026-08-09 코드리뷰로 확정된 원칙, 이 프로젝트
// 전역 규칙) — "확실히 안 나감"과 "불명"을 confirmedNotSent로 구분한다:
//   - 네트워크 호출 전 입력검증 실패 → confirmedNotSent=true(절대 안 나감, 안전하게 롤백 가능)
//   - NH가 명시적으로 업무거부(callNh의 err.businessRejection=true) → confirmedNotSent=true
//   - 응답은 성공인데 mkt_orr_no가 없음 → confirmedNotSent 절대 안 붙임(가장 위험한
//     "불명" 상태 — 실제로는 접수됐을 수 있음, 호출측이 즉시 수동 확인해야 함)
//   - 네트워크 예외(fetch 자체가 throw)·JSON 아닌 응답·429 유량초과·HTTP 4xx/5xx →
//     confirmedNotSent 안 붙임(불명 — nhplug.mjs callNh의 err.businessRejection 계약 참고)

// 주문수량·가격 검증 — price가 없으면(시장가 등 가격 없는 주문) 그 부분은 건너뜀.
// ⚠️ price는 `Number.isFinite`로 먼저 타입을 확정한 뒤에만 `> 0`을 본다(2026-09-02
// 코드리뷰 LOW 지적) — `price > 0`만 쓰면 느슨한 비교라 `'212000' > 0`·`true > 0`
// 같은 문자열·불리언도 통과해버린다(이 프로젝트가 구글시트 숫자 파싱에서 이미 겪은
// "숫자처럼 보이는 문자열이 조용히 통과" 클래스의 함정, feedback-sheets-numeric-
// parsing 메모리 참고). 통과한 문자열 값은 그대로 JSON.stringify돼 브로커에
// `"orr_pr": "212000"`처럼 따옴표 붙은 채로 나갈 수 있다.
export function validateOrderInputs({ quantity, price }) {
  if (!(Number.isInteger(quantity) && quantity > 0)) {
    const e = new Error(`주문수량은 양의 정수여야 함: ${quantity}`); e.confirmedNotSent = true; throw e;
  }
  if (price != null && !(Number.isFinite(price) && price > 0)) {
    const e = new Error(`주문단가는 양수여야 함: ${price}`); e.confirmedNotSent = true; throw e;
  }
}

// 계좌·종목 식별자 검증(2026-09-01 코드리뷰 HIGH 지적 — 예전엔 quantity/price만
// 검증해서 actNo·iemCd가 undefined여도 그대로 네트워크에 나갔다. JSON.stringify가
// undefined 필드를 조용히 생략하기 때문에 "계좌·종목 없는 주문"이 겉보기엔 정상
// 요청처럼 브로커에 전송될 수 있었다 — 실측 재현: quantity/price만 채우고 actNo·
// iemCd를 빼면 Input_0에 그 두 필드가 아예 없는 채로 나감).
export function validateIdentity({ actNo, iemCd }) {
  if (!String(actNo ?? '').trim()) { const e = new Error('계좌번호(actNo) 필수'); e.confirmedNotSent = true; throw e; }
  if (!String(iemCd ?? '').trim()) { const e = new Error('종목코드(iemCd) 필수'); e.confirmedNotSent = true; throw e; }
}

// 정정/취소 대상 원주문번호 검증 — modify·cancel 전용(주문 자체가 없던 place와 달리
// "어느 주문을 건드릴지"가 반드시 있어야 함, 이것도 위와 같은 이유로 예전엔 검증이
// 아예 없었다).
export function validateOrgOrderRef({ orgMktOrrNo }) {
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
export function validatePartialQty({ allPatDitCd, corQty }) {
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

// callNh 예외를 confirmedNotSent로 승격할지 판단하는 공용 catch 헬퍼 — NH가 명시적으로
// 업무거부(err.businessRejection===true)한 경우만 승격한다. 자산군별 주문함수마다
// `catch (e) { if (e.businessRejection) e.confirmedNotSent = true; throw e; }`를
// 반복하지 않게 함수로 뺌(2026-09-01, krgold가 두 번째 소비자가 되며 분리).
// @returns {never} — 항상 throw한다(정상 반환 경로 없음). 호출부(각 도메인 파일의
// `catch (e) { rethrowOrderError(e); }`) 뒤에 오는 `let body` 변수가 "이 함수 호출
// 뒤엔 반드시 throw됐거나 try가 성공한 것"이라는 걸 정적분석 도구가 알 수 있게
// 명시(2026-09-02 코드리뷰 LOW 지적 — 현재 ESLint는 통과하지만, 더 엄격한 검사기가
// 붙으면 body가 미할당 상태로 쓰였다고 오탐할 수 있음).
export function rethrowOrderError(e) {
  if (e.businessRejection) e.confirmedNotSent = true;
  throw e;
}
