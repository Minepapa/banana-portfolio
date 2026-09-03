import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNhAccount, extractNhAccountNo, NH_ACCOUNT_MAP, REBALANCE_SCOPE_NH_ACCOUNTS,
  maskNhActNo, resolveNhAccountLabelFromActNo, resolveNhAccountsByLabel,
} from './nh-accounts.mjs';

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

// 2026-09-03 신설 — 마이그레이션 3단계(예수금 NH 직접조회), 실계좌번호(NH PLUG API
// 응답)를 카카오와 같은 마스킹 형식으로 변환. 라이브 조회로 확인한 실제 3계좌.
test('maskNhActNo: 실계좌번호(11자리) → 카카오와 동일한 마스킹 형식', () => {
  assert.equal(maskNhActNo('20501596019'), '205-01-59***9');
  assert.equal(maskNhActNo('20901920556'), '209-01-92***6');
  assert.equal(maskNhActNo('20902920556'), '209-02-92***6');
});

test('maskNhActNo: 대시가 이미 섞여 있어도(하이픈 제거 후 재조합) 동일 결과', () => {
  assert.equal(maskNhActNo('205-01-596019'), '205-01-59***9');
});

test('[핵심 안전장치] maskNhActNo: 11자리가 아니면 null(추정 안 함)', () => {
  assert.equal(maskNhActNo('123'), null);
  assert.equal(maskNhActNo(''), null);
  assert.equal(maskNhActNo(undefined), null);
  assert.equal(maskNhActNo('123456789012'), null);
});

test('resolveNhAccountLabelFromActNo: 실계좌번호로 바로 계좌명 해석(위탁·CMA·금현물)', () => {
  assert.equal(resolveNhAccountLabelFromActNo('20501596019'), '위탁');
  assert.equal(resolveNhAccountLabelFromActNo('20901920556'), 'CMA');
  assert.equal(resolveNhAccountLabelFromActNo('20902920556'), '금현물');
});

test('resolveNhAccountLabelFromActNo: 매핑에 없는 계좌(예: ISA — NH API 계좌목록에 아예 안 나옴)는 null', () => {
  assert.equal(resolveNhAccountLabelFromActNo('99999999999'), null);
});

// 2026-09-03 신설 — reconcile-nh-cash.mjs·reconcile-nh-executions.mjs 공용 계좌 매핑.
test('resolveNhAccountsByLabel: allowedLabels에 속한 계좌만 골라 맵으로', () => {
  const accounts = [
    { acctNo: '50071002617', acctType: '03' }, // 모의투자 — 매핑 없음(제외)
    { acctNo: '20902920556', acctType: '01' }, // 금현물
    { acctNo: '20901920556', acctType: '01' }, // CMA
    { acctNo: '20501596019', acctType: '01' }, // 위탁
  ];
  const map = resolveNhAccountsByLabel(accounts, new Set(['위탁', '금현물']));
  assert.equal(map.size, 2);
  assert.equal(map.get('위탁'), '20501596019');
  assert.equal(map.get('금현물'), '20902920556');
  assert.equal(map.has('CMA'), false);
});

test('resolveNhAccountsByLabel: 빈 배열/undefined 입력이면 빈 맵', () => {
  assert.equal(resolveNhAccountsByLabel([], new Set(['위탁'])).size, 0);
  assert.equal(resolveNhAccountsByLabel(undefined, new Set(['위탁'])).size, 0);
});

// [핵심 안전장치] 마스킹(가운데 3자리 소실)으로 서로 다른 두 실계좌번호가 같은
// 라벨에 매칭되는 이론상 충돌 — 조용히 마지막 값으로 덮어쓰지 않고 throw해야
// 잘못된 계좌 잔고·체결이 엉뚱한 라벨로 기록되는 사고를 막는다.
test('[핵심 안전장치] resolveNhAccountsByLabel: 같은 라벨에 서로 다른 실계좌번호가 매칭되면 throw(조용히 덮어쓰지 않음)', () => {
  const accounts = [
    { acctNo: '20501596019', acctType: '01' }, // 위탁
    { acctNo: '20501590009', acctType: '01' }, // 마스킹하면 우연히 같은 라벨(가상 시나리오)
  ];
  assert.throws(() => resolveNhAccountsByLabel(accounts, new Set(['위탁'])), /마스킹 충돌/);
});

test('resolveNhAccountsByLabel: 같은 실계좌번호가 두 번 나와도(중복 응답) 충돌 아님', () => {
  const accounts = [
    { acctNo: '20501596019', acctType: '01' },
    { acctNo: '20501596019', acctType: '01' },
  ];
  const map = resolveNhAccountsByLabel(accounts, new Set(['위탁']));
  assert.equal(map.get('위탁'), '20501596019');
});
