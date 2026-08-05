// 체결 이벤트 → 계좌 귀속 판정 — 순수 함수(구현계획서 Phase 8, "보유종목 업데이터"의
// 선행 문제). Facts/Ledger/Executions의 카카오 파싱 체결은 account: null로 기록된다
// (notification-parsers.mjs의 증권사별 정규식 어디에도 계좌번호를 캡처하지 않음 — 배당
// 알림과 달리 체결 알림 원문 자체에 계좌번호가 없는 걸 오너가 직접 확인, 2026-08-05).
//
// 증권사→계좌 매핑은 삼성증권(연금저축)·한국투자증권(IRP)은 1:1이라 확정적으로 풀리지만,
// NH투자증권은 ISA·위탁 둘 다 NH라 증권사만으로는 못 푼다. **추정하지 않는다**(ADR 0003
// 폴백 금지 원칙과 동일) — 대신 그 종목명이 State/Holdings에 이미 ISA 또는 위탁 어느
// 한쪽에만 있으면 그걸로 판정하고(실데이터 근거), 양쪽에 다 있거나 어느 쪽에도 없으면
// (신규 종목 첫 매수 등) null을 반환해 호출부가 자동 적용을 건너뛰고 사람에게 맡기게 한다.

// 증권사가 유일한 계좌로 확정되는 경우(체결 알림 자체로 100% 확정 가능).
const UNIQUE_BROKER_ACCOUNT = {
  '삼성증권': '연금저축',
  '한국투자증권': 'IRP',
};

// NH투자증권처럼 증권사만으로 못 푸는 경우, 후보 계좌 목록(이 순서 자체엔 의미 없음 —
// holdings 조회로 좁힐 뿐 우선순위가 아님).
const AMBIGUOUS_BROKER_CANDIDATES = {
  'NH투자증권': ['ISA', '위탁'],
  'NH투자증권 해외': ['ISA', '위탁'],
};

// holdings: State/Holdings에서 읽은 프론트매터 배열({ account, name, ticker, ... }).
// stockCode: 체결의 종목코드(있으면). 반환: 계좌명(string) 또는 null(못 풀림 — 호출부가
// 건너뛰고 플래그).
export function resolveExecutionAccount({ broker, stockName, stockCode }, holdings = []) {
  if (UNIQUE_BROKER_ACCOUNT[broker]) return UNIQUE_BROKER_ACCOUNT[broker];

  const candidates = AMBIGUOUS_BROKER_CANDIDATES[broker];
  if (!candidates) return null; // 알 수 없는 증권사 — 안전하게 미해결 처리

  const nameTrim = String(stockName ?? '').trim();
  const codeTrim = String(stockCode ?? '').trim();
  // 종목명만으로 판정하면 "ISA엔 이 이름의 종목이 있지만, 실은 위탁이 사려는 건 같은
  // 이름의 다른 상품"인 경우 잘못 확정될 위험이 있다(코드리뷰 지적, 2026-08-05) — 체결에
  // stockCode가 있고 보유기록에 ticker가 있으면 그 둘도 반드시 일치해야 후보로 인정한다.
  // 둘 중 하나라도 비어있으면(예: 마이그레이션된 보유는 ticker가 빈 문자열) 종목명만으로
  // 판정하던 기존 동작으로 안전하게 폴백한다 — 정보가 없는데 억지로 더 엄격하게 굴면
  // 오히려 정상 케이스까지 미해결(null) 처리돼버린다.
  const holdingAccounts = new Set(
    holdings
      .filter((h) => {
        if (String(h.name ?? '').trim() !== nameTrim || !candidates.includes(h.account)) return false;
        const hTicker = String(h.ticker ?? '').trim();
        if (codeTrim && hTicker) return hTicker === codeTrim;
        return true;
      })
      .map((h) => h.account),
  );
  if (holdingAccounts.size === 1) return [...holdingAccounts][0];
  return null; // 양쪽 다 있거나(겹치는 종목) 어느 쪽에도 없음(신규 종목) — 추정 금지
}
