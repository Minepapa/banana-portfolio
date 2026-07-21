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
// TARGET_TERM(목표기간·일수)·TARGET_RET(목표수익률·%)은 drain-eval-queue.mjs buildRow()가
// 매수평가 시점에 LLM 판단으로 적어두는 값 — 회전(로테이션) 판단 재료로 order-candidates.mjs
// buildHoldingsFacts가 읽는다(src/lib/parseSheetData.js r[17]/r[18]과 동일 위치).
export const NOTE_COL = { DATE: 0, NAME: 1, TICKER: 2, MARKET: 3, CONCL: 4, TARGET_TERM: 17, TARGET_RET: 18, STATUS: 14 };

// ── 리스크모니터 (A~H) — risk-monitor.mjs RISK_HEADER와 동일 레이아웃 ──────────
export const RISK_HEADER = ['날짜', '유형', '대상', '신호', '요약', '상세', '근거데이터', '기준선참조'];
export const RISK_COL = {
  DATE: 0, TYPE: 1, TARGET: 2, SIGNAL: 3, SUMMARY: 4, DETAIL: 5, EVIDENCE: 6, BASELINE_REF: 7,
};

// ── 리스크기준선 (A~K) — backfill-baselines가 쓰고 report-facts·risk-facts가 읽음 ─────
export const BASELINE_HEADER = ['종목', '티커', '시장', '기준일', '매출총이익률', '영업이익률', 'ROE', '부채비율', 'EPS', 'PBR', '비고'];
export const BASELINE_COL = {
  NAME: 0, TICKER: 1, MARKET: 2, DATE: 3, GROSS_MARGIN: 4, OP_MARGIN: 5, ROE: 6, DEBT_RATIO: 7, EPS: 8, PBR: 9, NOTE: 10,
};

// ── 주문제안 (A~N) — order-proposals 잡이 쓰고 앱 주문 탭·parse-notifications 매칭이 읽음 ──
export const PROPOSAL_HEADER = [
  '생성일시', '출처', '계좌', '방향', '종목명', '수량', '예상단가', '예상금액',
  '근거체인', '제약체크', '상태', '응답일시', '기각사유', '매칭키',
];
export const PROPOSAL_COL = {
  DATE: 0, SOURCE: 1, ACCT: 2, SIDE: 3, NAME: 4, QTY: 5, PRICE: 6, AMOUNT: 7,
  RATIONALE: 8, CONSTRAINTS: 9, STATUS: 10, RESPONDED: 11, REJECT_REASON: 12, MATCH_KEY: 13,
};
// 상태 전이: 제안 → (승인 → 실행완료) | 기각 | 만료. 승인만 체결 매칭 대상.
export const PROPOSAL_STATUS = {
  PROPOSED: '제안', APPROVED: '승인', REJECTED: '기각', EXECUTED: '실행완료', EXPIRED: '만료',
};
// 출처 신호 종류 — B열 계약값(앱 배지·dedup 키에 사용)
// ROTATION(회전): AI가 크래시·주간 판단 중 "기존 배분형 보유를 매도하고 이 후보로 교체"를
// 제안했을 때 Node가 결정론으로 만드는 매도측 짝 후보(및 그 매수측)의 출처 표기.
export const PROPOSAL_SOURCE = {
  REBALANCE: '리밸런싱', CRASH: '급락O', THESIS: '논리훼손B', EVAL: '평가🟢', ROTATION: '회전',
};

// ── 상태 문자열 (writer가 쓰고 앱·잡이 읽는 계약값) ───────────────────────────
export const EVAL_STATUS = { PENDING: '대기', PROCESSING: '처리중', DONE: '완료', ERROR: '오류' };
export const JOURNAL_STATUS = { HELD: '보유', CLOSED: '청산' };
export const CONFIRM_STATUS = { PENDING: '대기', CONFIRMED: '확인', UNWRITTEN: '미작성' };
export const CASH_SOURCE = { MANUAL: '수동', AUTO: '자동' };

// 컬럼 인덱스 → 시트 열 문자 (0→A). 쓰기 범위 조립용.
export const colLetter = (idx) => String.fromCharCode(65 + idx);
