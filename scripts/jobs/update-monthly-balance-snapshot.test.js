import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyBalanceSnapshot, computeDailySnapshot } from './update-monthly-balance-snapshot.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const holdings = [
  { evalAmount: 10000000, invest: 8000000 },
  { evalAmount: 5000000, invest: 5000000 }, // 예수금류(isCashLike) 등 — buildHomeMirror는 구분 없이 전부 합산
];

test('computeMonthlyBalanceSnapshot: 파일명은 오늘 날짜(KST)의 연-월', () => {
  const { filename } = computeMonthlyBalanceSnapshot(holdings, '2026-09-01');
  assert.equal(filename, '2026-09.md');
});

test('computeMonthlyBalanceSnapshot: total은 buildHomeMirror와 동일하게 evalAmount 전체 합산(홈 화면과 항상 일치)', () => {
  const r = computeMonthlyBalanceSnapshot(holdings, '2026-09-15');
  assert.equal(r.total, 15000000);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.total, 15000000);
  assert.equal(fm.year, 2026);
  assert.equal(fm.month, 9);
  assert.equal(fm.ym, 202609);
});

test('computeMonthlyBalanceSnapshot: legacy 필드 없음(마이그레이션 스냅샷과 구분 — 이건 라이브 값)', () => {
  const r = computeMonthlyBalanceSnapshot(holdings, '2026-09-01');
  assert.doesNotMatch(r.content, /legacy/);
});

test('computeMonthlyBalanceSnapshot: MonthlyBalances 폴더를 가리킨다', () => {
  const r = computeMonthlyBalanceSnapshot(holdings, '2026-09-01');
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.monthlyBalances);
});

test('computeMonthlyBalanceSnapshot: 같은 달 안에서는 매번 같은 파일명(멱등 — 매일 덮어쓰기)', () => {
  const a = computeMonthlyBalanceSnapshot(holdings, '2026-09-01');
  const b = computeMonthlyBalanceSnapshot(holdings, '2026-09-30');
  assert.equal(a.filename, b.filename);
});

test('computeMonthlyBalanceSnapshot: 보유가 비어있어도(추정 안 하고) 0으로 정직하게', () => {
  const r = computeMonthlyBalanceSnapshot([], '2026-09-01');
  assert.equal(r.total, 0);
});

// 2026-09-04 신설 — TWR·Sharpe·MDD 재계산용 일별 불변 이력(v1 이관분은 오너 지시로
// 삭제, 오늘부터 라이브 값만 쌓는다).
test('computeDailySnapshot: 파일명은 그날 날짜 그대로(연-월-일, -r{N} 없음)', () => {
  const { filename } = computeDailySnapshot(holdings, '2026-09-05');
  assert.equal(filename, '2026-09-05.md');
});

test('computeDailySnapshot: total은 MonthlyBalances와 같은 계산(buildHomeMirror 재사용, 재계산 로직 중복 없음)', () => {
  const daily = computeDailySnapshot(holdings, '2026-09-05');
  const monthly = computeMonthlyBalanceSnapshot(holdings, '2026-09-05');
  assert.equal(daily.total, monthly.total);
  assert.equal(daily.total, 15000000);
  const fm = parseFrontmatter(daily.content);
  assert.equal(fm.date, '2026-09-05');
  assert.equal(fm.total, 15000000);
});

test('computeDailySnapshot: legacy 필드 없음(v1 이관분과 구분 — 이건 라이브 값)', () => {
  const r = computeDailySnapshot(holdings, '2026-09-05');
  assert.doesNotMatch(r.content, /legacy/);
});

test('computeDailySnapshot: DailySnapshots 폴더를 가리킨다', () => {
  const r = computeDailySnapshot(holdings, '2026-09-05');
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.dailySnapshots);
});

test('computeDailySnapshot: 날짜가 다르면 파일명도 달라진다(월별잔고와 달리 매일 새 파일 — 불변 원장)', () => {
  const a = computeDailySnapshot(holdings, '2026-09-05');
  const b = computeDailySnapshot(holdings, '2026-09-06');
  assert.notEqual(a.filename, b.filename);
});

test('computeDailySnapshot: 보유가 비어있어도 0으로 정직하게', () => {
  const r = computeDailySnapshot([], '2026-09-05');
  assert.equal(r.total, 0);
});
