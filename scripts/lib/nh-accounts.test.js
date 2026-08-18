import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNhAccount, NH_ACCOUNT_MAP, REBALANCE_SCOPE_NH_ACCOUNTS } from './nh-accounts.mjs';

test('resolveNhAccount: 등록된 4계좌 각각 정확히 구분', () => {
  assert.equal(resolveNhAccount('[NH투자증권] 입금안내\n계좌번호 205-01-59***9'), '위탁');
  assert.equal(resolveNhAccount('[NH투자증권] 입금안내\n계좌번호 209-02-89***2'), 'ISA');
  assert.equal(resolveNhAccount('[NH투자증권] 입금안내\n계좌번호 209-02-92***6'), '금현물');
  assert.equal(resolveNhAccount('[NH투자증권] 입금안내\n계좌번호 209-01-92***6'), 'CMA');
});

test('[막아야 함] resolveNhAccount: 접두사(209-02)가 같아도 뒷자리가 다르면 ISA·금현물이 섞이지 않음', () => {
  // 실제 사고 재현 방지 회귀 테스트 — 접두사만 보던 v1 방식이면 둘 다 ISA로 잘못 나옴.
  const isa = resolveNhAccount('계좌번호 209-02-89***2');
  const gold = resolveNhAccount('계좌번호 209-02-92***6');
  assert.equal(isa, 'ISA');
  assert.equal(gold, '금현물');
  assert.notEqual(isa, gold);
});

test('resolveNhAccount: 매핑 안 된 계좌번호는 null(추정 안 함)', () => {
  assert.equal(resolveNhAccount('계좌번호 999-99-00***0'), null);
});

test('resolveNhAccount: 계좌번호 자체가 없으면 null', () => {
  assert.equal(resolveNhAccount('[NH투자증권] 아무 내용'), null);
});

test('REBALANCE_SCOPE_NH_ACCOUNTS: CMA는 제외, 위탁·ISA·금현물만 포함', () => {
  assert.ok(REBALANCE_SCOPE_NH_ACCOUNTS.has('위탁'));
  assert.ok(REBALANCE_SCOPE_NH_ACCOUNTS.has('ISA'));
  assert.ok(REBALANCE_SCOPE_NH_ACCOUNTS.has('금현물'));
  assert.ok(!REBALANCE_SCOPE_NH_ACCOUNTS.has('CMA'));
});

test('NH_ACCOUNT_MAP: 4계좌 전부 서로 다른 계좌명', () => {
  const names = Object.values(NH_ACCOUNT_MAP);
  assert.equal(new Set(names).size, names.length);
});
