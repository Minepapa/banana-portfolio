import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { insertDuplicateOf, markDuplicateExecutions, planDuplicateMarks } from './mark-duplicate-executions.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';

test('dry-run is read-only; apply marks only later file once and keeps body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duplicate-executions-'));
  const base = { type: 'execution', tradeType: '매수', account: 'ISA', stockName: '테스트',
    stockCode: '123', quantity: 30, price: 4015, holdingsApplied: true };
  const firstName = '2026-08-06-9_28_37-매수-테스트-r81.md';
  const lastName = '2026-08-06-092837-매수-테스트.md';
  writeFileSync(join(dir, firstName), buildFrontmatter({ ...base,
    tradeDate: '2026-08-06 9:28:37', source: 'KAKAO', recordedAt: '2026-08-13T02:00:00Z' }) + '# old body\n');
  writeFileSync(join(dir, lastName), buildFrontmatter({ ...base,
    tradeDate: '2026-08-06 09:28:37', source: 'NH_API', currency: 'KRW', recordedAt: '2026-08-17T07:00:00Z' }) + '# later body\n');
  const before = Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
  const dry = markDuplicateExecutions(dir, { log: () => {} });
  assert.equal(dry.actions.length, 1);
  assert.deepEqual(Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')])), before);

  markDuplicateExecutions(dir, { apply: true, log: () => {} });
  assert.equal(readFileSync(join(dir, firstName), 'utf8'), before[firstName]);
  const after = readFileSync(join(dir, lastName), 'utf8');
  const { duplicateOf, ...unchangedFields } = parseFrontmatter(after);
  assert.equal(duplicateOf, firstName.slice(0, -3));
  assert.deepEqual(unchangedFields, parseFrontmatter(before[lastName]));
  assert.ok(after.endsWith('# later body\n'));
  assert.equal(after, insertDuplicateOf(before[lastName], firstName.slice(0, -3)));
  markDuplicateExecutions(dir, { apply: true, log: () => {} });
  assert.equal(readFileSync(join(dir, lastName), 'utf8'), after);
});

test('missing recordedAt is reported and never written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duplicate-executions-'));
  const base = { type: 'execution', tradeType: '매도', stockName: '테스트', quantity: 1,
    price: 100, tradeDate: '2026-09-03 00:00:00' };
  writeFileSync(join(dir, 'a.md'), buildFrontmatter({ ...base, source: 'KAKAO' }));
  writeFileSync(join(dir, 'b.md'), buildFrontmatter({ ...base, source: 'NH_API', recordedAt: '2026-09-03T04:00:00Z' }));
  const result = markDuplicateExecutions(dir, { apply: true, log: () => {} });
  assert.equal(result.actions.length, 0);
  assert.equal(result.skipped[0].reason, 'recordedAt 없음 또는 시각 동률');
  assert.equal(parseFrontmatter(readFileSync(join(dir, 'b.md'), 'utf8')).duplicateOf, undefined);
});

test('같은 출처는 비교하지 않고 한 행의 상대 후보가 둘이면 묶음 전체를 보류한다', () => {
  const base = { type: 'execution', tradeDate: '2026-09-03 00:00:00', tradeType: '매수',
    stockCode: 'AAPL', stockName: '애플', quantity: 1, price: 100, account: '위탁' };
  const rows = [
    { ...base, name: 'k1.md', filepath: '/k1', source: 'KAKAO', orderNo: '', recordedAt: '2026-09-03T01:00:00Z' },
    { ...base, name: 'k2.md', filepath: '/k2', source: 'KAKAO', orderNo: '', recordedAt: '2026-09-03T02:00:00Z' },
    { ...base, name: 'n1.md', filepath: '/n1', source: 'NH_API', orderNo: '1', recordedAt: '2026-09-03T03:00:00Z' },
  ];
  const result = planDuplicateMarks(rows);
  assert.equal(result.actions.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(new Set(result.skipped[0].names), new Set(['k1.md', 'k2.md', 'n1.md']));
  assert.equal(planDuplicateMarks(rows.slice(0, 2)).actions.length, 0);
});
