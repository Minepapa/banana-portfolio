// 시트 레이아웃·상태 문자열 계약의 단일 정본 (테스트: sheet-contracts.test.js)
//
// 왜: 포지션저널·체결내역 컬럼 위치가 writer(sync-position-journal HEADER)·reader
// (behavior-signals J/T맵·parseSheetData)에 3~4곳 독립 하드코딩돼 있었다. 열 하나
// 추가하면 손으로 전부 찾아 고쳐야 하고, 하나라도 놓치면 상태를 청산일로 읽는 식의
// 조용한 어긋남이 생긴다(2026-07 사고들과 동일한 "침묵 계약 파괴" 클래스).
// scripts 쪽 소비자는 여기서 import하고, src(브라우저) 쪽 parseSheetData는 import가
// 안 되므로 parseSheetData.test.js의 컬럼 고정 테스트가 같은 계약을 핀으로 잡는다.

// ── 포지션저널 (A~P) ─────────────────────────────────────────────────────────
export const JOURNAL_HEADER = [
  '종목명', '티커', '시장', '계좌', '유형', '전제', '목표', '이탈조건',
  '예상보유', '진입일', '상태', '청산일', '청산결과', '교훈', '확인여부', '갱신시각',
];
export const JOURNAL_COL = {
  NAME: 0, TICKER: 1, MARKET: 2, ACCT: 3, KIND: 4, THESIS: 5, TARGET: 6, EXIT: 7,
  HOLD: 8, ENTRY: 9, STATUS: 10, EXITDATE: 11, RESULT: 12, LESSON: 13, CONFIRM: 14, UPDATED: 15,
};

// ── 체결내역 (A~M) — src/lib/constants.js CHEOL_COLS와 동일 레이아웃 ─────────────
export const EXEC_COL = {
  DATE: 0, SIDE: 1, ACCT: 2, CODE: 3, ASSET: 4, NAME: 5, PRICE: 6, QTY: 7,
  AMOUNT: 8, CURRENT: 9, PNL: 10, EVAL: 11, RETPCT: 12,
};

// ── 종목투자노트 (A~U, 사용 필드만) ──────────────────────────────────────────
export const NOTE_COL = { DATE: 0, NAME: 1, TICKER: 2, MARKET: 3, CONCL: 4, STATUS: 14 };

// ── 리스크모니터 (A~H, 사용 필드만) ──────────────────────────────────────────
export const RISK_COL = { DATE: 0, TYPE: 1, TARGET: 2, SIGNAL: 3 };

// ── 상태 문자열 (writer가 쓰고 앱·잡이 읽는 계약값) ───────────────────────────
export const EVAL_STATUS = { PENDING: '대기', PROCESSING: '처리중', DONE: '완료', ERROR: '오류' };
export const JOURNAL_STATUS = { HELD: '보유', CLOSED: '청산' };
export const CONFIRM_STATUS = { PENDING: '대기', CONFIRMED: '확인', UNWRITTEN: '미작성' };
export const CASH_SOURCE = { MANUAL: '수동', AUTO: '자동' };

// 컬럼 인덱스 → 시트 열 문자 (0→A). 쓰기 범위 조립용.
export const colLetter = (idx) => String.fromCharCode(65 + idx);
