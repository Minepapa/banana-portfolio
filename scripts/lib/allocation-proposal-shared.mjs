// 자산분배 제안 공유 로직 — 2026-09-06 신설. `rebalance-proposal.mjs`(분기 리밸런싱)와
// `new-cash-allocation.mjs`(신규 현금 배분)가 "제안 항목 배열 → 캡 소진까지 축소하며
// 드롭 → 실보유 조회해 가격 산정"을 각자 독립적으로 구현하고 있던 걸 통합한다(두 파일
// 전체를 직접 읽어 확인 — 두 검증 함수의 골격이 사실상 동일: 도메인 검증 → key별 예산
// 소진 여부 → 초과분은 드롭이 아니라 캡까지 축소). "자산분배 트랙 핵심 로직 설계"
// 계획(2026-09-06, 오너 지시 "가장 중요한 로직") §1.
//
// ⚠️ 기존 두 잡의 공개 함수(validateRebalanceActions·validateAllocations·
// resolveRebalanceInstrumentPricing·resolveInstrumentPricing)는 시그니처·반환 모양을
// 그대로 유지한 채 내부만 이 모듈을 호출하는 얇은 래퍼로 바뀐다 — 기존
// rebalance-proposal.test.js·new-cash-allocation.test.js가 무수정으로 계속 통과해야
// "행동 변화 없는 리팩터"라는 증거가 된다.
import { normalizeAccount } from './rebalance-gap.mjs';

// 분할매수 하드 캡(2026-08-23 오너 확정) — 두 파일에 각자 있던 동일 상수를 여기 하나로.
export const CAP_FRACTION = 0.5;

// 순수함수 — "제안 항목 배열 → 도메인검증(콜백) → 캡 소진까지 축소" 공통 뼈대.
// validateItem(rawItem) => { ok:true, key, amountWon, normalized } | { ok:false, reason }
//   - key: 이 항목이 소진하는 캡 예산 버킷(자산군명 등 — 의미는 호출부가 정한다,
//     이 함수는 key의 뜻을 모른다. new-cash-allocation처럼 버킷이 하나뿐이면 고정
//     문자열 하나를 key로 써도 된다). capBudget에 없는 key가 오면 호출부 프로그래밍
//     오류로 보고 즉시 드롭(캡 소진과 다른 사유 문구 — 코드리뷰 지적, 2026-09-06).
//   - normalized: 검증부가 이미 trim·파싱까지 끝낸 도메인 필드(assetClass·side·
//     account·instrumentName 등, amountWon 제외 — amountWon은 캡 축소 대상이라
//     이 함수가 별도로 다룬다).
// capBudget: { [key]: number } — 호출부가 이미 CAP_FRACTION을 적용해 계산한 초기
// 예산. 이 함수 내부에서만 복사본을 갱신하고 호출부가 넘긴 객체는 mutate하지 않는다
// (순수함수 — 코드리뷰 지적, 2026-09-06: "순수함수"라 적어놓고 인자를 mutate하면
// 다음 읽는 사람이 재사용해도 되는 줄 알고 실수하기 쉬움).
// capLabel: 드롭 사유 문구에 넣을 사람이 읽는 캡 설명(예: "갭의 50%", "가용잔고의 50%")
// — 생략하면 "분할매수 캡"만 표기(단일 버킷이라 굳이 라벨이 필요 없는 호출부용).
// 반환: { kept: 정규화된 항목(amountWon 포함) 배열, dropped: [{a, reason}] } — 드롭
// 항목 키는 기존 두 잡의 관례(`a`, LLM raw action/allocation)를 그대로 따라 호출부·
// 기존 테스트가 `dropped[0].a.xxx`로 원본 필드를 참조할 수 있게 한다.
export function applyCappedAllocation(items, { validateItem, capBudget, capLabel }) {
  const budget = { ...capBudget };
  const capDesc = capLabel ? `분할매수 캡(${capLabel})` : '분할매수 캡';
  const kept = [];
  const dropped = [];
  for (const raw of items ?? []) {
    const v = validateItem(raw);
    if (!v.ok) { dropped.push({ a: raw, reason: v.reason }); continue; }
    // Object.hasOwn(2026-09-06 코드리뷰 지적) — `in`은 Object.prototype 체인까지 봐서
    // key가 "constructor"·"toString" 같은 상속 프로퍼티명이면 미정의 키인데도 통과한다.
    if (!Object.hasOwn(budget, v.key)) { dropped.push({ a: raw, reason: `캡 예산 미정의 키(호출부 버그): ${v.key}` }); continue; }
    // NaN 방어(2026-09-06 코드리뷰 지적) — 예산이 비수치면 이 하드 캡 자체가 조용히
    // 무력화된다(NaN<=0은 false, amountWon>NaN도 false라 무제한 통과). 실제 돈이 걸린
    // 마지막 방어선이라 여기서 명시적으로 막는다.
    const remaining = Number.isFinite(budget[v.key]) ? budget[v.key] : 0;
    if (remaining <= 0) { dropped.push({ a: raw, reason: `${capDesc} 이미 소진: ${v.key}` }); continue; }
    let amountWon = v.amountWon;
    if (amountWon > remaining) amountWon = remaining; // 초과분은 드롭이 아니라 캡까지 축소
    budget[v.key] = remaining - amountWon;
    kept.push({ ...v.normalized, amountWon });
  }
  return { kept, dropped };
}

function priceFromMatch(match, instrumentName, amountWon) {
  if (!match || !Number.isFinite(match.curPrice) || match.curPrice <= 0) {
    return { assetKey: instrumentName, ticker: '', quantity: null, proposedPrice: null };
  }
  const quantity = Math.floor(amountWon / match.curPrice);
  return { assetKey: match.ticker || match.name, ticker: match.ticker || '', quantity: quantity > 0 ? quantity : null, proposedPrice: match.curPrice };
}

// 순수함수 — holdings에서 (account, assetClass, instrumentName) 정확히 일치하는
// 실보유를 찾아 quantity·proposedPrice를 산출한다. 세 축 전부 필수(생략 불가) —
// account는 normalizeAccount를 거쳐 비교한다(금현물→위탁 등). 없거나 가격이 무효
// (curPrice 결측·0 이하)면 quantity/proposedPrice는 null — order-gate.
// checkPriceDeviation이 null을 "적용 대상 아님"으로 이미 안전하게 처리하므로, 신규
// 종목 제안(금액만 있고 아직 수량을 못 정하는 경우)도 이 값 그대로 안전하다.
export function resolveAllocationPricing(holdings, { account, assetClass, instrumentName, amountWon }) {
  const target = normalizeAccount(account);
  const match = holdings.find((h) => normalizeAccount(h.account) === target && h.assetClass === assetClass && h.name === instrumentName);
  return priceFromMatch(match, instrumentName, amountWon);
}

// 순수함수 — candidates에서 이름만 정확히 일치하는 걸 찾아 가격 정보를 붙인다(계좌·
// 자산군 축은 안 본다). new-cash-allocation.mjs처럼 호출부가 이미 계좌+자산군으로
// 걸러진 candidates 배열만 넘기고 이름으로만 재확인하는 경우 전용 — 이름을 별도
// 함수로 둔 이유(코드리뷰 지적, 2026-09-06): `resolveAllocationPricing`에 account를
// optional로 두면 "일부러 생략"과 "실수로 안 넘김"을 구분 못 해, 미래 호출부가 실수로
// account를 빠뜨려도 에러 없이 다른 계좌 보유와 조용히 매칭될 위험이 있었다.
export function resolveAllocationPricingByName(candidates, { instrumentName, amountWon }) {
  const match = candidates.find((h) => h.name === instrumentName);
  return priceFromMatch(match, instrumentName, amountWon);
}
