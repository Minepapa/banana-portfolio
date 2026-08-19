import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNhAccount, extractNhAccountNo, NH_ACCOUNT_MAP, REBALANCE_SCOPE_NH_ACCOUNTS } from './nh-accounts.mjs';

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

// 실사고 회귀 테스트(2026-08-19) — NH 분배금 입금 안내는 "계좌번호" 키워드 없이
// "{11자리 마스킹} {이름}님 계좌로" 형태로 온다(오너 제보로 발견, 실제 원문 그대로).
test('extractNhAccountNo: NH 분배금 입금 안내 형식("계좌번호" 키워드 없음, 대시 없음)도 인식', () => {
  const body = '[NH투자증권] 분배금 입금 안내\n2090289***2 정*호 님 계좌로 분배금 입금 안내 드립니다.\n\n1. 종목명 : 미래에셋 TIGER 미국배당다우존스타겟데일리커버드콜증권상장지';
  assert.equal(extractNhAccountNo(body), '209-02-89***2');
});

test('resolveNhAccount: 분배금 형식 원문으로도 정확히 금현물로 해석됨', () => {
  const body = '[NH투자증권] 분배금 입금 안내\n2090292***6 홍*동 님 계좌로 분배금 입금 안내 드립니다.';
  assert.equal(resolveNhAccount(body), '금현물');
});

test('extractNhAccountNo: 기존 "계좌번호" 키워드 형식이 분배금 형식보다 우선 매칭(둘 다 있어도 안전)', () => {
  const body = '계좌번호 205-01-59***9 안내\n2090292***6 홍*동 님 계좌로';
  assert.equal(extractNhAccountNo(body), '205-01-59***9');
});
