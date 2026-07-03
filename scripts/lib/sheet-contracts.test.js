// 시트 레이아웃·상태 문자열 계약 고정 테스트.
// 컬럼 하나 추가/이동하거나 상태 문구를 바꾸면 여기서 먼저 깨진다 —
// writer(HEADER)·reader(컬럼맵) 간 침묵 어긋남(2026-07 사고 클래스) 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_HEADER, JOURNAL_COL, EXEC_COL, NOTE_COL, RISK_COL,
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

test('colLetter: 인덱스 → 시트 열 문자', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(JOURNAL_COL.STATUS), 'K');
  assert.equal(colLetter(JOURNAL_COL.UPDATED), 'P');
});
