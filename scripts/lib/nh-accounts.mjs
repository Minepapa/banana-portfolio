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

// body(카카오 알림 원문)에서 마스킹된 전체 계좌번호를 찾는다. 알림 종류마다 형식이
// 달라 두 가지를 지원:
//   ①"계좌번호 209-02-89***2"(체결·입출금 안내류, 대시 있음)
//   ②"2090289***2 정*호 님 계좌로 분배금 입금 안내"(NH 분배금 입금 안내, 대시 없이
//     11자리 붙어서 옴, "이름 님 계좌로" 바로 앞) — 2026-08-19 실제 알림으로 확인
//     (오너 제보: "분배금 알림도 계좌정보 포함돼 있다"). 이전엔 이 형식을 못 잡아서
//     NH 분배금 알림의 acctRaw가 항상 빈 문자열이었고(update-holdings-from-executions.mjs
//     주석에 "실측상 항상 비어있다"로 잘못 고착돼 있었음), 종목 정식명(카카오 알림)과
//     보유파일의 축약명이 달라 이름매칭 폴백도 실패해 계좌귀속이 안 됐다(실사고).
//   ②는 NH 계좌번호 관행상 3-2-6 자릿수 구조(예: 209-02-89***2)가 그대로 붙어서 오므로
//   ①과 같은 대시 위치로 재구성해 반환 — 호출부(resolveNhAccount·NH_ACCOUNT_MAP)가
//   형식 하나만 알면 되게 한다.
// 매핑에 없는 계좌번호(예: 등록 안 된 새 NH 계좌)는 account:null — 추정하지 않는다.
// acctNo(마스킹된 원문, 대시 재구성됨)는 매핑 여부와 무관하게 항상 반환 — 감사·디버깅용
// 원본 보존(다른 파서들의 acctRaw 필드와 동일 관례).
export function extractNhAccountNo(body) {
  const b = String(body ?? '');
  const withKeyword = b.match(/계좌번호\s*([\d]{3}-[\d]{2}-[\d*]+)/);
  if (withKeyword) return withKeyword[1];
  const dividendStyle = b.match(/(\d{3})(\d{2})(\d[\d*]{5})\s+\S+\s*님\s*계좌로/);
  if (dividendStyle) return `${dividendStyle[1]}-${dividendStyle[2]}-${dividendStyle[3]}`;
  return null;
}

export function resolveNhAccount(body) {
  const acctNo = extractNhAccountNo(body);
  if (!acctNo) return null;
  return NH_ACCOUNT_MAP[acctNo] ?? null;
}

// NH PLUG API(/n2/acctinfo 등)가 반환하는 마스킹 안 된 실계좌번호(11자리, 예:
// "20501596019") → 카카오 알림과 동일한 마스킹 형식("205-01-59***9")으로 변환.
// 2026-09-03 신설(마이그레이션 3단계, 예수금 NH 직접조회) — 실계좌번호를 새로
// 하드코딩한 별도 매핑표를 안 만들고, 이미 있는 NH_ACCOUNT_MAP(마스킹 형식→계좌명)을
// 그대로 재사용하기 위한 변환기. 라이브 조회로 3-2-6자리(뒤 2자리 보임+3자리
// 마스킹+1자리 보임) 구조를 확인(위탁 20501596019·CMA 20901920556·금현물
// 20902920556 — 전부 NH_ACCOUNT_MAP의 마스킹 패턴과 정확히 일치). 순수함수.
export function maskNhActNo(actNo) {
  const digits = String(actNo ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return null;
  const seg3 = digits.slice(5, 11);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${seg3.slice(0, 2)}***${seg3.slice(5)}`;
}

// maskNhActNo+NH_ACCOUNT_MAP 조합 — API가 반환한 실계좌번호를 바로 계좌명으로.
export function resolveNhAccountLabelFromActNo(actNo) {
  const masked = maskNhActNo(actNo);
  if (!masked) return null;
  return NH_ACCOUNT_MAP[masked] ?? null;
}
