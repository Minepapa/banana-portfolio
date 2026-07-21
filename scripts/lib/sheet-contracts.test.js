// 시트 레이아웃·상태 문자열 계약 고정 테스트.
// 컬럼 하나 추가/이동하거나 상태 문구를 바꾸면 여기서 먼저 깨진다 —
// writer(HEADER)·reader(컬럼맵) 간 침묵 어긋남(2026-07 사고 클래스) 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_HEADER, JOURNAL_COL, EXEC_COL, NOTE_COL, RISK_HEADER, RISK_COL,
  BASELINE_HEADER, BASELINE_COL,
  PROPOSAL_HEADER, PROPOSAL_COL, PROPOSAL_STATUS, PROPOSAL_SOURCE,
  EVAL_STATUS, JOURNAL_STATUS, CONFIRM_STATUS, CASH_SOURCE, colLetter,
} from './sheet-contracts.mjs';
import { CHEOL_COLS } from '../../src/lib/constants.js';

test('포지션저널: HEADER 길이·핵심 컬럼 라벨이 컬럼맵 인덱스와 정합', () => {
  assert.equal(JOURNAL_HEADER.length, 16);                       // A~P
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.NAME], '종목명');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.ENTRY], '진입일');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.STATUS], '상태');      // K열 — behavior-signals·parseSheetData가 r[10]으로 읽음
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.EXITDATE], '청산일');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.RESULT], '청산결과');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.LESSON], '교훈');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.CONFIRM], '확인여부');
  assert.equal(JOURNAL_HEADER[JOURNAL_COL.UPDATED], '갱신시각');
});

test('체결내역: EXEC_COL이 앱 CHEOL_COLS(A~M) 레이아웃과 정합', () => {
  assert.equal(CHEOL_COLS.length, 13);                           // A~M
  assert.equal(CHEOL_COLS[EXEC_COL.DATE].label, '날짜');
  assert.equal(CHEOL_COLS[EXEC_COL.SIDE].label, '매수/매도');
  assert.equal(CHEOL_COLS[EXEC_COL.ACCT].label, '계좌');
  assert.equal(CHEOL_COLS[EXEC_COL.ASSET].label, '자산군');
  assert.equal(CHEOL_COLS[EXEC_COL.NAME].label, '종목명');
  assert.equal(CHEOL_COLS[EXEC_COL.PRICE].label, '체결가');
  assert.equal(CHEOL_COLS[EXEC_COL.QTY].label, '수량');
  assert.equal(CHEOL_COLS[EXEC_COL.AMOUNT].label, '체결금액');
});

test('상태 문자열 계약값 고정 (writer↔reader 공유 리터럴)', () => {
  // drain-eval-queue가 쓰고 앱 EvalQueueModal·parseSheetData가 읽는 값
  assert.deepEqual(Object.values(EVAL_STATUS).sort(), ['대기', '오류', '완료', '처리중'].sort());
  // journal-sync가 쓰고 앱 PositionJournalTab·behavior-signals가 읽는 값
  assert.deepEqual(Object.values(JOURNAL_STATUS).sort(), ['보유', '청산'].sort());
  assert.deepEqual(Object.values(CONFIRM_STATUS).sort(), ['대기', '미작성', '확인'].sort());
  // parse-notifications·cash-base·usePortfolioEdits가 공유하는 예수금 소스
  assert.deepEqual(Object.values(CASH_SOURCE).sort(), ['수동', '자동'].sort());
});

test('NOTE_COL·RISK_COL 핵심 인덱스 고정', () => {
  assert.equal(NOTE_COL.NAME, 1);    // 종목투자노트 B열 종목명
  assert.equal(NOTE_COL.CONCL, 4);   // E열 결론
  assert.equal(NOTE_COL.STATUS, 14); // O열 매수여부
  assert.equal(RISK_COL.TYPE, 1);    // 리스크모니터 B열 유형(B/D/O)
  assert.equal(RISK_COL.SIGNAL, 3);  // D열 신호(🟢🟡🔴)
});

test('리스크기준선: HEADER 길이·라벨이 컬럼맵과 정합 (A~K), report-facts.mjs 인덱스와 일치', () => {
  assert.equal(BASELINE_HEADER.length, 11);
  assert.equal(BASELINE_HEADER[BASELINE_COL.NAME], '종목');
  assert.equal(BASELINE_COL.DATE, 3);        // report-facts.mjs baselines.date = r[3]
  assert.equal(BASELINE_COL.OP_MARGIN, 5);   // report-facts.mjs opMargin = r[5]
  assert.equal(BASELINE_COL.ROE, 6);
  assert.equal(BASELINE_COL.PBR, 9);
});

test('리스크모니터: HEADER 길이·라벨이 컬럼맵과 정합 (A~H)', () => {
  assert.equal(RISK_HEADER.length, 8);
  assert.equal(RISK_HEADER[RISK_COL.DATE], '날짜');
  assert.equal(RISK_HEADER[RISK_COL.TARGET], '대상');
  assert.equal(RISK_HEADER[RISK_COL.SUMMARY], '요약');
  assert.equal(RISK_HEADER[RISK_COL.DETAIL], '상세');
  assert.equal(RISK_HEADER[RISK_COL.EVIDENCE], '근거데이터');
  assert.equal(RISK_HEADER[RISK_COL.BASELINE_REF], '기준선참조');
});

test('주문제안: HEADER 길이·컬럼 라벨이 컬럼맵 인덱스와 정합 (A~N)', () => {
  assert.equal(PROPOSAL_HEADER.length, 14);                        // A~N
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.DATE], '생성일시');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.SOURCE], '출처');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.ACCT], '계좌');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.SIDE], '방향');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.NAME], '종목명');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.QTY], '수량');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.AMOUNT], '예상금액');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.RATIONALE], '근거체인');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.CONSTRAINTS], '제약체크');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.STATUS], '상태');      // K열 — 앱 승인/기각·매칭이 갱신
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.REJECT_REASON], '기각사유');
  assert.equal(PROPOSAL_HEADER[PROPOSAL_COL.MATCH_KEY], '매칭키');
  assert.equal(colLetter(PROPOSAL_COL.STATUS), 'K');
  assert.equal(colLetter(PROPOSAL_COL.MATCH_KEY), 'N');
});

test('주문제안 상태·출처 계약값 고정 (잡이 쓰고 앱·매칭이 읽음)', () => {
  assert.deepEqual(Object.values(PROPOSAL_STATUS).sort(),
    ['기각', '만료', '승인', '실행완료', '제안'].sort());
  assert.deepEqual(Object.values(PROPOSAL_SOURCE).sort(),
    ['급락O', '논리훼손B', '리밸런싱', '평가🟢', '회전'].sort());
});

test('colLetter: 인덱스 → 시트 열 문자', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(JOURNAL_COL.STATUS), 'K');
  assert.equal(colLetter(JOURNAL_COL.UPDATED), 'P');
});
