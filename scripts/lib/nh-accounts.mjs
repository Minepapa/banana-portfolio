// NH투자증권 계좌번호(마스킹된 전체 번호) → 계좌명 매핑 — 순수 데이터/함수.
//
// ⚠️ 2026-08-17/18 실데이터 검증으로 발견 — 기존 v1 방식(앞 6자리 접두사만 매칭,
// 예: "209-02"→ISA)은 **같은 접두사를 공유하는 서로 다른 계좌**를 구분 못 한다.
// 실제로 ISA(209-02-89***2)와 금현물(209-02-92***6)이 똑같이 "209-02"로 시작해서,
// 접두사만 보면 금현물 알림 3건이 ISA로 잘못 들어갈 뻔했다(실제 백로그로 확인).
// 그래서 마스킹된 전체 계좌번호(카카오 알림에 그대로 찍히는 형태, 예: "209-02-89***2")
// 로 매칭한다 — 접두사가 겹쳐도 뒤 가려진 부분 앞뒤 숫자가 다르면 구분된다.
//
// 계좌번호가 바뀌거나(재발급 등) 새 NH 계좌가 생기면 여기만 갱신하면 된다.
export const NH_ACCOUNT_MAP = {
  '205-01-59***9': '위탁',
  '209-02-89***2': 'ISA',
  '209-02-92***6': '금현물',
  '209-01-92***6': 'CMA',
};

// 리밸런싱 목표비중 계산(rebalance-gap.mjs)의 분모에 포함되는 NH 계좌 — CMA는
// 순수 경유지(오너 확인, 2026-08-18)라 제외. 금현물은 "금" 자산군으로 자산배분에
// 포함되지만, 그 현금은 위탁에 합산 취급(오너 확인)이라 별도 자산군 계좌로 세지
// 않는다 — cash-ledger.mjs의 합산 로직에서 처리.
export const REBALANCE_SCOPE_NH_ACCOUNTS = new Set(['위탁', 'ISA', '금현물']);

// body(카카오 알림 원문)에서 "계좌번호 209-02-89***2" 형태를 찾아 { account, acctNo }로
// 변환. 매핑에 없는 계좌번호(예: 등록 안 된 새 NH 계좌)는 account:null — 추정하지
// 않는다. acctNo(마스킹된 원문)는 매핑 여부와 무관하게 항상 반환 — 감사·디버깅용
// 원본 보존(다른 파서들의 acctRaw 필드와 동일 관례).
export function extractNhAccountNo(body) {
  const m = String(body ?? '').match(/계좌번호\s*([\d]{3}-[\d]{2}-[\d*]+)/);
  return m ? m[1] : null;
}

export function resolveNhAccount(body) {
  const acctNo = extractNhAccountNo(body);
  if (!acctNo) return null;
  return NH_ACCOUNT_MAP[acctNo] ?? null;
}
