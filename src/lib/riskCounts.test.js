import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRiskCounts } from './riskCounts.js';

// RiskTab.jsx의 dedup+집계 로직을 리팩터 전에 고정하는 테스트(동작 불변 확인용).
// riskMonitor는 최신순 정렬된 파싱 객체 배열: { date, type, target, signal }.

const row = (date, type, target, signal) => ({ date, type, target, signal });

test('computeRiskCounts: O타입은 종목당 최신 1건만(최신순 입력 가정)', () => {
  const rows = [
    row('2026-07-19', 'O', '삼성전자', '🔴'),
    row('2026-07-18', 'O', '삼성전자', '🔴'), // 같은 종목 과거 — 드롭
  ];
  const { latest } = computeRiskCounts(rows);
  assert.equal(latest.filter(r => r.type === 'O' && r.target === '삼성전자').length, 1);
  assert.equal(latest[0].date, '2026-07-19');
});

test('computeRiskCounts: O타입 🟢(해소된 기회)는 숨김', () => {
  const rows = [row('2026-07-19', 'O', '테슬라', '🟢')];
  const { latest, counts } = computeRiskCounts(rows);
  assert.equal(latest.length, 0);
  assert.equal(counts.opp, 0);
});

test('computeRiskCounts: D타입은 가장 최근 날짜의 신호만(과거 D 누적분 제거)', () => {
  const rows = [
    row('2026-07-19', 'D', '국내주식', '🟡'),
    row('2026-07-17', 'D', '환율', '🔴'), // 더 과거 날짜 — 드롭
  ];
  const { latest } = computeRiskCounts(rows);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].target, '국내주식');
});

test('computeRiskCounts: B/기타 타입은 (유형+대상) 최신 1건만', () => {
  const rows = [
    row('2026-07-19', 'B', '마이크로소프트', '🟢'),
    row('2026-07-06', 'B', '마이크로소프트', '🟡'), // 같은 유형+대상 과거 — 드롭
  ];
  const { latest } = computeRiskCounts(rows);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].date, '2026-07-19');
});

test('computeRiskCounts: counts는 opp를 경보/주의와 분리 집계', () => {
  const rows = [
    row('2026-07-19', 'B', '현대차', '🔴'),
    row('2026-07-19', 'D', '환율', '🟡'),
    row('2026-07-19', 'O', 'SK하이닉스', '🔴'),
  ];
  const { counts } = computeRiskCounts(rows);
  assert.deepEqual(counts, { red: 1, amber: 1, green: 0, opp: 1 });
});

test('computeRiskCounts: 정렬은 카테고리(경보>기회>주의>정상) 우선, 그다음 심각도', () => {
  const rows = [
    row('2026-07-19', 'B', '종목A', '🟡'),  // 주의
    row('2026-07-19', 'O', '종목B', '🔴'),  // 기회
    row('2026-07-19', 'B', '종목C', '🔴'),  // 경보
  ];
  const { latest } = computeRiskCounts(rows);
  assert.deepEqual(latest.map(r => r.target), ['종목C', '종목B', '종목A']);
});

test('computeRiskCounts: lastUpdated는 행 순서와 무관하게 최대 날짜', () => {
  const rows = [
    row('2026-07-10', 'B', '종목A', '🟢'),
    row('2026-07-19', 'B', '종목B', '🟢'),
  ];
  const { lastUpdated } = computeRiskCounts(rows);
  assert.equal(lastUpdated, '2026-07-19');
});

test('computeRiskCounts: 빈 배열은 안전하게 빈 결과', () => {
  const { latest, counts, lastUpdated } = computeRiskCounts([]);
  assert.deepEqual(latest, []);
  assert.deepEqual(counts, { red: 0, amber: 0, green: 0, opp: 0 });
  assert.equal(lastUpdated, '—');
});
