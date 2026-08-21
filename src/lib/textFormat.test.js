import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNum, toDateStr, stripEmoji,
  gradeColor, GRADE_COLORS, stripGrade, stripPeriod,
  breakUnits, breakSentences, relTime,
} from './textFormat.js';

// ── parseNum ────────────────────────────────────────────────────────────────
test('parseNum: 일반 숫자', () => {
  assert.equal(parseNum(12345), 12345);
  assert.equal(parseNum('12345'), 12345);
});

test('parseNum: 콤마 포함 문자열', () => {
  assert.equal(parseNum('1,234,567'), 1234567);
  assert.equal(parseNum('10,000.5'), 10000.5);
});

test('parseNum: 빈 값·null·undefined → 0', () => {
  assert.equal(parseNum(null), 0);
  assert.equal(parseNum(undefined), 0);
  assert.equal(parseNum(''), 0);
});

test('parseNum: 비숫자 문자열 → 0', () => {
  assert.equal(parseNum('abc'), 0);
  assert.equal(parseNum('N/A'), 0);
});

test('parseNum: 음수', () => {
  assert.equal(parseNum('-500'), -500);
  assert.equal(parseNum('-1,234.5'), -1234.5);
});

// ── toDateStr ───────────────────────────────────────────────────────────────
test('toDateStr: 구글 시트 시리얼 → YYYY-MM-DD', () => {
  const serial = 25569 + Math.floor(new Date('2026-06-15').getTime() / 86400000);
  assert.equal(toDateStr(String(serial)), '2026-06-15');
});

test('toDateStr: 이미 날짜 문자열이면 앞 10자만', () => {
  assert.equal(toDateStr('2026-06-15'), '2026-06-15');
  assert.equal(toDateStr('2026-06-15 14:30'), '2026-06-15');
});

test('toDateStr: 빈 값 → 빈 문자열', () => {
  assert.equal(toDateStr(''), '');
  assert.equal(toDateStr(null), '');
  assert.equal(toDateStr(undefined), '');
});

test('toDateStr: 소수점 시리얼도 처리', () => {
  const serial = 25569 + new Date('2026-06-15').getTime() / 86400000;
  const result = toDateStr(String(serial + 0.25));
  assert.equal(result, '2026-06-15');
});

// ── relTime ─────────────────────────────────────────────────────────────────
// 2026-08-21 실사고 회귀 재현 — "e.getTime is not a function"(로그인 후 흰 화면).
// Firestore mirror.updatedAt은 Date 객체가 아니라 ISO 문자열로 저장된다.
test('relTime: ISO 문자열 입력도 처리(Date 객체로 안 감싸도 터지지 않음)', () => {
  const isoString = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.equal(relTime(isoString), '5분 전');
});

test('relTime: Date 객체 입력도 그대로 처리', () => {
  const d = new Date(Date.now() - 2 * 3600 * 1000);
  assert.equal(relTime(d), '2시간 전');
});

test('relTime: 빈 값 → 빈 문자열', () => {
  assert.equal(relTime(null), '');
  assert.equal(relTime(undefined), '');
  assert.equal(relTime(''), '');
});

test('relTime: 파싱 불가능한 값 → 빈 문자열(예외 던지지 않음)', () => {
  assert.equal(relTime('이상한값'), '');
});

test('relTime: 60초 미만은 "방금 전"', () => {
  assert.equal(relTime(new Date(Date.now() - 30 * 1000).toISOString()), '방금 전');
});

test('relTime: 하루 이상은 "N일 전"', () => {
  assert.equal(relTime(new Date(Date.now() - 3 * 86400 * 1000).toISOString()), '3일 전');
});

// ── stripEmoji ──────────────────────────────────────────────────────────────
test('stripEmoji: 이모지 제거 후 텍스트 보존', () => {
  assert.equal(stripEmoji('⚡ 주의 ⚠️'), '주의');
});

test('stripEmoji: 이모지 없으면 그대로', () => {
  assert.equal(stripEmoji('plain text'), 'plain text');
});

test('stripEmoji: 빈 문자열', () => {
  assert.equal(stripEmoji(''), '');
});

// ── gradeColor ──────────────────────────────────────────────────────────────
test('gradeColor: 등급 이모지 → 색상', () => {
  assert.equal(gradeColor('🟢 유효'), GRADE_COLORS['🟢']);
  assert.equal(gradeColor('🟡 관망'), GRADE_COLORS['🟡']);
  assert.equal(gradeColor('🔴 부적합'), GRADE_COLORS['🔴']);
  assert.equal(gradeColor('⚪ 판단보류'), GRADE_COLORS['⚪']);
});

test('gradeColor: 이모지 없으면 기본 회색', () => {
  assert.equal(gradeColor('텍스트만'), '#6B7280');
  assert.equal(gradeColor(null), '#6B7280');
});

// ── stripGrade ──────────────────────────────────────────────────────────────
test('stripGrade: 등급 이모지 제거', () => {
  assert.equal(stripGrade('🟢 유효'), '유효');
  assert.equal(stripGrade('🔴 부적합'), '부적합');
});

test('stripGrade: 이모지 없으면 trim만', () => {
  assert.equal(stripGrade('  plain  '), 'plain');
});

// ── stripPeriod ─────────────────────────────────────────────────────────────
test('stripPeriod: 연도·분기 괄호 제거', () => {
  assert.equal(stripPeriod('매출총이익률 (2025 3분기)'), '매출총이익률');
  assert.equal(stripPeriod('ROE [2025 연간]'), 'ROE');
});

test('stripPeriod: 파라미터 괄호는 보존', () => {
  assert.equal(stripPeriod('RSI(14)'), 'RSI(14)');
});

test('stripPeriod: TTM 제거', () => {
  assert.equal(stripPeriod('EPS, TTM'), 'EPS');
});

// ── breakUnits ──────────────────────────────────────────────────────────────
test('breakUnits: 줄표(—)로 분리', () => {
  const result = breakUnits('이유 — 근거');
  assert.deepEqual(result, ['이유', '근거']);
});

test('breakUnits: 화살표(→)로 분리', () => {
  const result = breakUnits('단계1 → 단계2');
  assert.deepEqual(result, ['단계1', '단계2']);
});

test('breakUnits: 문장 종결 뒤 분리', () => {
  const result = breakUnits('첫 문장. 둘째 문장.');
  assert.deepEqual(result, ['첫 문장.', '둘째 문장.']);
});

// ── breakSentences ──────────────────────────────────────────────────────────
test('breakSentences: 문장 종결만 분리 (줄표·화살표 무시)', () => {
  const result = breakSentences('A — B. C입니다.');
  assert.deepEqual(result, ['A — B.', 'C입니다.']);
});

test('breakSentences: 빈 입력', () => {
  assert.deepEqual(breakSentences(''), []);
  assert.deepEqual(breakSentences(null), []);
});
