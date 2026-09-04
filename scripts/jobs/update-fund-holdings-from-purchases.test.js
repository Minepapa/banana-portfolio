import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnappliedFundPurchases, latestPreviouslyAppliedDate } from './update-fund-holdings-from-purchases.mjs';

function writePurchase(dir, filename, frontmatter) {
  const lines = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`), '---', ''];
  writeFileSync(join(dir, filename), lines.join('\n'));
}

test('readUnappliedFundPurchases: 존재하지 않는 디렉터리면 빈 배열', () => {
  assert.deepEqual(readUnappliedFundPurchases('/no/such/dir'), []);
});

test('[실사고 재현] readUnappliedFundPurchases: holdingsApplied 없는 실제 2026-09-01 매수 기록 형태를 정확히 읽음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-purchases-test-'));
  try {
    writePurchase(dir, '2026-09-01-VIP한국형가치투자증권자투자신탁(주식)-C-Pe-200000.md', {
      type: 'fund-purchase', date: '2026-09-01', fundName: 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe',
      amount: 200000, nav: 2027.92, units: 98623.21985088168, account: '연금저축',
    });
    const targets = readUnappliedFundPurchases(dir);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].parsed.amount, 200000);
    assert.equal(targets[0].parsed.units, 98623.21985088168);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readUnappliedFundPurchases: holdingsApplied:true인 건 제외(멱등)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-purchases-test-'));
  try {
    writePurchase(dir, '2026-08-01-X-100000.md', { type: 'fund-purchase', date: '2026-08-01', fundName: 'X', amount: 100000, nav: 1000, units: 100, account: '연금저축', holdingsApplied: true });
    writePurchase(dir, '2026-09-01-X-100000.md', { type: 'fund-purchase', date: '2026-09-01', fundName: 'X', amount: 100000, nav: 1000, units: 100, account: '연금저축' });
    const targets = readUnappliedFundPurchases(dir);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].parsed.date, '2026-09-01');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readUnappliedFundPurchases: date 오름차순 정렬(누적 순서 중요)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-purchases-test-'));
  try {
    writePurchase(dir, '2026-09-01-X-100.md', { type: 'fund-purchase', date: '2026-09-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축' });
    writePurchase(dir, '2026-07-01-X-100.md', { type: 'fund-purchase', date: '2026-07-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축' });
    writePurchase(dir, '2026-08-01-X-100.md', { type: 'fund-purchase', date: '2026-08-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축' });
    const targets = readUnappliedFundPurchases(dir);
    assert.deepEqual(targets.map((t) => t.parsed.date), ['2026-07-01', '2026-08-01', '2026-09-01']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[코드리뷰 HIGH 지적 방지] latestPreviouslyAppliedDate: holdingsApplied:true인 것 중 가장 최근 date(과거 실행분 포함)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-purchases-test-'));
  try {
    writePurchase(dir, '2026-07-01-X-100.md', { type: 'fund-purchase', date: '2026-07-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축', holdingsApplied: true });
    writePurchase(dir, '2026-09-01-X-100.md', { type: 'fund-purchase', date: '2026-09-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축', holdingsApplied: true });
    writePurchase(dir, '2026-10-01-X-100.md', { type: 'fund-purchase', date: '2026-10-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축' }); // 아직 미반영
    assert.equal(latestPreviouslyAppliedDate(dir), '2026-09-01');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('latestPreviouslyAppliedDate: 반영 이력 없거나 디렉터리 없으면 null', () => {
  assert.equal(latestPreviouslyAppliedDate('/no/such/dir'), null);
  const dir = mkdtempSync(join(tmpdir(), 'fund-purchases-test-'));
  try {
    writePurchase(dir, '2026-09-01-X-100.md', { type: 'fund-purchase', date: '2026-09-01', fundName: 'X', amount: 100, nav: 1000, units: 1, account: '연금저축' });
    assert.equal(latestPreviouslyAppliedDate(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
