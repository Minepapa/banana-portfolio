// 체결 이벤트 → 계좌 귀속 판정 — 순수 함수(구현계획서 Phase 8, "보유종목 업데이터"의
// 선행 문제). Facts/Ledger/Executions의 카카오 파싱 체결은 account: null로 기록된다.
//
// ⚠️ 2026-08-13 수정 — "체결 알림 원문 자체엔 계좌번호가 없다"(2026-08-05 확인)는
// 가정이 틀렸음이 드러났다. 오너가 실제 알림 원문을 다시 붙여준 걸 보니 한국투자증권
// 체결안내엔 "*계좌번호:43****82-29" 형태로 계좌번호가 있었다 — 2026-08-05 시점엔
// 한국투자증권 계좌가 IRP 하나뿐이라 찾아볼 이유가 없었을 뿐이다. 그런데 이제
// 한국투자증권이 **퀀트 트랙 전용 계좌도 같이 호스팅**하게 되면서(2트랙 구조 확정),
// 증권사명만으로 "한국투자증권=IRP"라고 확정하던 기존 로직이 더 이상 안전하지 않다 —
// 퀀트 계좌 체결이 v1의 살아있는 카카오 파이프라인에 잡히면 그대로 IRP로 오귀속될
// 위험이 실제로 있었다(NH의 ISA/위탁 문제와 같은 클래스가 여기서도 재발). 계좌번호를
// notification-parsers.mjs가 캡처해주므로, 있으면 증권사명보다 **우선** 사용한다.
//
// 증권사→계좌 매핑은 삼성증권(연금저축)은 여전히 1:1 확정. NH투자증권은 ISA·위탁 둘 다
// NH라 증권사만으로는 못 푼다. **추정하지 않는다**(ADR 0003 폴백 금지 원칙과 동일) —
// 대신 그 종목명이 State/Holdings에 이미 ISA 또는 위탁 어느 한쪽에만 있으면 그걸로
// 판정하고(실데이터 근거), 양쪽에 다 있거나 어느 쪽에도 없으면(신규 종목 첫 매수 등)
// null을 반환해 호출부가 자동 적용을 건너뛰고 사람에게 맡기게 한다.

// 퀀트 트랙 전용 계좌번호 — parse-notifications-to-vault.mjs가 이 계좌의 카카오 체결
// 자체를 Facts/Ledger에 아예 안 쓰게 걸러내는 데도 쓴다(단일 진실 소스, 2026-08-13).
export const QUANT_ACCOUNT_NO = '46****07-01';

// 퀀트 트랙 계좌 라벨 — watch-order-fill.mjs가 Facts/Ledger 체결 기록에 직접 붙이고,
// update-holdings-from-executions.mjs가 이 라벨이면 State/Holdings 반영을 건너뛰는 데
// 쓴다(단일 진실 소스로 여기 하나만 정의 — 문자열 리터럴 중복 방지).
export const QUANT_TRACK_LABEL = '퀀트';

// 계좌번호로 확정되는 경우 — 증권사명보다 우선. 퀀트 계좌는 의도적으로 null: KIS API가
// 정본이라(Phase 9 확정) State/Holdings에 절대 반영하면 안 되고, 카카오로 잡힌 건
// 순수 중복이므로 "귀속 불가"와 동일하게 취급해 호출부가 자동 적용을 건너뛰게 한다.
const KNOWN_ACCOUNT_NUMBERS = {
  '43****82-29': 'IRP',
  [QUANT_ACCOUNT_NO]: null, // 퀀트 트랙 전용 계좌 — State/Holdings 반영 대상 아님
};

// 증권사가 유일한 계좌로 확정되는 경우(체결 알림 자체로 100% 확정 가능. 한국투자증권은
// 위 계좌번호 매핑에 없는 새 계좌가 나타날 수 있어 더 이상 여기 안 둔다 — 모르는
// 계좌번호를 만나면 추정하지 않고 null로 떨어지는 쪽이 안전).
const UNIQUE_BROKER_ACCOUNT = {
  '삼성증권': '연금저축',
};

// NH투자증권처럼 증권사만으로 못 푸는 경우, 후보 계좌 목록(이 순서 자체엔 의미 없음 —
// holdings 조회로 좁힐 뿐 우선순위가 아님).
//
// ⚠️ 버그 수정(2026-08-18, 예수금앵커 설계 중 발견) — 금현물(NH 실물 금 계좌) 매수도
// parseGoldBuy가 broker: 'NH투자증권'으로 채워 같은 체결 파서(parseExecution)와 똑같이
// 이 자리로 들어오는데, 금현물이 후보 목록에 아예 없어서 실제 금 매수가 생기면 "ISA
// 아니면 위탁"에서만 종목명을 찾다가 영원히 계좌귀속불가로 떨어질 뻔했다(2026-08-18
// 기준 아직 실제 금현물 매수 기록이 없어 잠재 버그로만 존재 — 실데이터 확인함). CMA는
// 추가하지 않는다 — CMA는 순수 현금 경유지라(오너 확정) 증권을 보유할 수 없어 후보에
// 넣을 이유가 없다.
const AMBIGUOUS_BROKER_CANDIDATES = {
  'NH투자증권': ['ISA', '위탁', '금현물'],
  'NH투자증권 해외': ['ISA', '위탁'],
};

// holdings: State/Holdings에서 읽은 프론트매터 배열({ account, name, ticker, ... }).
// stockCode: 체결의 종목코드(있으면). acctNo: 알림 원문에서 캡처된 계좌번호(있으면).
// 반환: 계좌명(string) 또는 null(못 풀림 또는 의도적 제외 — 호출부가 건너뛰고 플래그).
export function resolveExecutionAccount({ broker, stockName, stockCode, acctNo }, holdings = []) {
  if (acctNo && Object.prototype.hasOwnProperty.call(KNOWN_ACCOUNT_NUMBERS, acctNo)) {
    return KNOWN_ACCOUNT_NUMBERS[acctNo];
  }
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
