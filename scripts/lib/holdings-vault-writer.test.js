import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdingFilename, buildLiveHoldingRecord, parseAppliedDedupKeys, buildCashHoldingRecord, writeHoldingSafely } from './holdings-vault-writer.mjs';
import { parseFrontmatter, buildFrontmatter } from './vault-frontmatter.mjs';
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

test('buildCashHoldingRecord: 파일명·디렉터리가 종목 보유와 같은 관례(계좌-예수금.md, State/Holdings)', () => {
  const r = buildCashHoldingRecord({ account: '위탁', balance: 1234567 });
  assert.equal(r.filename, '위탁-예수금.md');
  assert.equal(r.dir, VAULT_PATHS.state.holdings);
});

test('buildCashHoldingRecord: isCashLike=true·name="예수금" — 기존 isCashLike 소비처(order-candidates 등)와 호환', () => {
  const r = buildCashHoldingRecord({ account: 'ISA', balance: 500000 });
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.name, '예수금');
  assert.equal(fm.isCashLike, true);
  assert.equal(fm.qty, 500000);
  assert.equal(fm.invest, 500000);
  assert.equal(fm.evalAmount, 500000);
  assert.equal(fm.avgPrice, 1);
});

test('buildCashHoldingRecord: 감사 필드(anchorBase·anchorTs·anchorSource·raw·negative) 보존', () => {
  const r = buildCashHoldingRecord({
    account: '위탁', balance: 0, raw: -50000, negative: true,
    anchorBase: 100000, anchorTs: '2026-08-18 09:00:00', anchorSource: '자동',
  });
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.raw, -50000);
  assert.equal(fm.negative, true);
  assert.equal(fm.anchorBase, 100000);
  assert.equal(fm.anchorTs, '2026-08-18 09:00:00');
  assert.equal(fm.anchorSource, '자동');
});

test('buildCashHoldingRecord: appliedDedupKeys 없음(증분 반영 방어 불필요 — 매번 전체 재계산)', () => {
  const r = buildCashHoldingRecord({ account: '위탁', balance: 100 });
  assert.doesNotMatch(r.content, /appliedDedupKeys/);
});

// ── writeHoldingSafely(2026-09-04 신설, 2차 코드리뷰로 정정) ────────────────────
// VAULT_PATHS.state.holdings가 하드코딩이라(다른 이 코드베이스 함수들과 동일 제약)
// 임시 디렉터리로 주입할 수 없다 — 실제 Vault 디렉터리에 이름이 명백히 테스트용인
// 파일을 만들고 try/finally로 반드시 지운다(reconcile-irp.test.js 등 이 파일을
// 직접 못 건드리는 다른 테스트들과 다른 점 — writeHoldingSafely만 이 방식이 필요).
const TEST_ACCOUNT = '__단위테스트계좌__';
const TEST_NAME = '__단위테스트종목__';
function testHoldingPath() {
  return join(VAULT_PATHS.state.holdings, holdingFilename(TEST_ACCOUNT, TEST_NAME));
}
function cleanupTestHolding() {
  try { rmSync(testHoldingPath(), { force: true }); } catch { /* 무시 */ }
  try { rmSync(`${testHoldingPath()}.lock`, { force: true }); } catch { /* 무시 */ }
}

test('[코드리뷰 HIGH 지적/실사고 재현] writeHoldingSafely: 기존 파일이 있어도 identity 필드(ticker 등)를 실제로 갱신함', async () => {
  cleanupTestHolding();
  try {
    // 기존 파일 — ticker가 비어있던 상태를 재현(reconcile-irp.mjs의 ticker 백필
    // 대상이 되는 실제 시나리오와 동일 형태).
    writeFileSync(testHoldingPath(), buildFrontmatter({
      type: 'holding', account: TEST_ACCOUNT, assetClass: 'TDF', name: TEST_NAME,
      ticker: '', market: '', avgPrice: 100, qty: 10, invest: 1000,
      curPrice: 100, evalAmount: 1000, profitAmount: 0, profitPct: 0,
      isCashLike: false, appliedDedupKeys: '[]', updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await writeHoldingSafely({
      account: TEST_ACCOUNT, assetClass: 'TDF', name: TEST_NAME, ticker: '0025N0', market: '',
      avgPrice: 105, qty: 11, invest: 1155, curPrice: 105, evalAmount: 1155, profitAmount: 0, profitPct: 0,
      isCashLike: false, appliedDedupKeys: [],
    });
    const fm = parseFrontmatter(readFileSync(testHoldingPath(), 'utf8'));
    assert.equal(fm.ticker, '0025N0', '기존 파일이 있어도 identity 필드(ticker)가 갱신돼야 함 — 처음엔 이게 안 됐던 회귀');
    assert.equal(fm.qty, 11);
    assert.equal(fm.assetClass, 'TDF');
  } finally {
    cleanupTestHolding();
  }
});

test('writeHoldingSafely: 파일이 없으면 새로 생성', async () => {
  cleanupTestHolding();
  try {
    assert.equal(existsSync(testHoldingPath()), false);
    await writeHoldingSafely({
      account: TEST_ACCOUNT, assetClass: '국내주식', name: TEST_NAME, ticker: '005930', market: 'KRX',
      avgPrice: 50000, qty: 5, invest: 250000, curPrice: 50000, evalAmount: 250000, profitAmount: 0, profitPct: 0,
      isCashLike: false, appliedDedupKeys: ['key1'],
    });
    const fm = parseFrontmatter(readFileSync(testHoldingPath(), 'utf8'));
    assert.equal(fm.qty, 5);
    assert.equal(fm.ticker, '005930');
    assert.deepEqual(parseAppliedDedupKeys(fm), ['key1']);
  } finally {
    cleanupTestHolding();
  }
});

test('writeHoldingSafely: 쓰기 후 락파일이 남지 않음', async () => {
  cleanupTestHolding();
  try {
    await writeHoldingSafely({ account: TEST_ACCOUNT, name: TEST_NAME, avgPrice: 1, qty: 1, invest: 1 });
    assert.equal(existsSync(`${testHoldingPath()}.lock`), false);
  } finally {
    cleanupTestHolding();
  }
});
