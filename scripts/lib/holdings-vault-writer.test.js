import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdingFilename, buildLiveHoldingRecord, parseAppliedDedupKeys } from './holdings-vault-writer.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';

test('holdingFilename: 계좌-종목명 고정 형태(로트 구분 없음 — 항상 하나로 수렴)', () => {
  assert.equal(holdingFilename('위탁', '삼성전자'), '위탁-삼성전자.md');
});

test('buildLiveHoldingRecord: legacy 필드 없음(마이그레이션 레코드와 구분)', () => {
  const holding = { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', avgPrice: 50450, qty: 40, invest: 2018000 };
  const r = buildLiveHoldingRecord(holding);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.legacy, undefined);
  assert.equal(fm.qty, 40);
  assert.equal(r.dir, VAULT_PATHS.state.holdings);
  assert.equal(r.filename, '위탁-삼성전자.md');
});

test('buildLiveHoldingRecord → parseAppliedDedupKeys: 왕복 보장(idempotency 마커, 코드리뷰 지적 2026-08-05)', () => {
  const holding = { account: '위탁', name: '삼성전자', avgPrice: 1, qty: 1, invest: 1, appliedDedupKeys: ['k1', 'k2'] };
  const r = buildLiveHoldingRecord(holding);
  const fm = parseFrontmatter(r.content);
  assert.deepEqual(parseAppliedDedupKeys(fm), ['k1', 'k2']);
});

test('parseAppliedDedupKeys: 필드 없으면(마이그레이션 레코드) 빈 배열', () => {
  assert.deepEqual(parseAppliedDedupKeys({}), []);
});

test('parseAppliedDedupKeys: 깨진 JSON이어도 죽지 않고 빈 배열', () => {
  assert.deepEqual(parseAppliedDedupKeys({ appliedDedupKeys: '{broken' }), []);
});
