import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNhCashDeposit, resolveNhCashAccountMap } from './reconcile-nh-cash.mjs';

test('extractNhCashDeposit: drn_pbl_amt(출금가능금액)을 우선 사용', () => {
  assert.equal(extractNhCashDeposit({ drn_pbl_amt: '5797267', dca: '5797267' }), 5797267);
});

// [핵심 안전장치] 금현물 응답엔 drn_pbl_amt 필드 자체가 없음(2026-09-03 라이브 확인) —
// 이 경우만 dca로 폴백. 카카오 경로(parseCashAlarm)는 "출금가능금액"을 기준으로
// 기록해왔으므로, drn_pbl_amt가 있을 때 그걸 우선해야 같은 계좌의 최신값 경쟁에서
// 서로 다른 정의의 숫자가 섞이지 않는다(2026-09-03 code-reviewer 지적으로 정정).
test('[핵심 안전장치] extractNhCashDeposit: drn_pbl_amt 없으면(금현물) dca로 폴백', () => {
  assert.equal(extractNhCashDeposit({ dca: '44644' }), 44644);
});

test('extractNhCashDeposit: 콤마 포함 문자열도 파싱', () => {
  assert.equal(extractNhCashDeposit({ drn_pbl_amt: '5,797,267' }), 5797267);
});

// [핵심 안전장치] 0은 유효한 예수금(전액 매수 등 실제로 가능) — 결측과 구분해야 한다.
test('[핵심 안전장치] extractNhCashDeposit: 0이면 그대로 0(추정 아닌 실제값으로 허용, drn_pbl_amt·dca 둘 다)', () => {
  assert.equal(extractNhCashDeposit({ drn_pbl_amt: '0' }), 0);
  assert.equal(extractNhCashDeposit({ drn_pbl_amt: 0 }), 0);
  assert.equal(extractNhCashDeposit({ dca: 0 }), 0);
});

// [핵심 안전장치] 두 필드 다 없으면(구조 변경 등) throw — 0으로 추정하지 않는다.
test('[핵심 안전장치] extractNhCashDeposit: drn_pbl_amt·dca 둘 다 없으면 throw(0으로 추정 안 함)', () => {
  assert.throws(() => extractNhCashDeposit({}));
  assert.throws(() => extractNhCashDeposit(null));
  assert.throws(() => extractNhCashDeposit(undefined));
});

test('[핵심 안전장치] extractNhCashDeposit: 값이 숫자로 안 바뀌면 throw', () => {
  assert.throws(() => extractNhCashDeposit({ drn_pbl_amt: 'N/A' }));
});

test('resolveNhCashAccountMap: 실계좌번호 목록에서 위탁·CMA·금현물만 골라 맵으로', () => {
  const accounts = [
    { acctNo: '50071002617', acctType: '03' }, // 모의투자 — 매핑 없음(제외)
    { acctNo: '20902920556', acctType: '01' }, // 금현물
    { acctNo: '20901920556', acctType: '01' }, // CMA
    { acctNo: '20501596019', acctType: '01' }, // 위탁
  ];
  const map = resolveNhCashAccountMap(accounts);
  assert.equal(map.size, 3);
  assert.equal(map.get('위탁'), '20501596019');
  assert.equal(map.get('CMA'), '20901920556');
  assert.equal(map.get('금현물'), '20902920556');
});

test('resolveNhCashAccountMap: ISA(계좌목록에 없음)·매핑 안 된 계좌는 결과에 안 나옴', () => {
  const accounts = [{ acctNo: '99999999999', acctType: '01' }];
  const map = resolveNhCashAccountMap(accounts);
  assert.equal(map.size, 0);
});

test('resolveNhCashAccountMap: 빈 배열/undefined 입력이면 빈 맵', () => {
  assert.equal(resolveNhCashAccountMap([]).size, 0);
  assert.equal(resolveNhCashAccountMap(undefined).size, 0);
});

// [핵심 안전장치] 마스킹(가운데 3자리 소실)으로 서로 다른 두 실계좌번호가 같은
// 라벨에 매칭되는 이론상 충돌 — 조용히 마지막 값으로 덮어쓰지 않고 throw해야
// 잘못된 계좌 잔고가 엉뚱한 라벨로 기록되는 사고를 막는다(2026-09-03 code-reviewer
// 지적, 응답 순서에 따라 결과가 달라지는 걸 실행으로 재현 확인 후 반영).
test('[핵심 안전장치] resolveNhCashAccountMap: 같은 라벨에 서로 다른 실계좌번호가 매칭되면 throw(조용히 덮어쓰지 않음)', () => {
  const accounts = [
    { acctNo: '20501596019', acctType: '01' }, // 위탁
    { acctNo: '20501590009', acctType: '01' }, // 마스킹하면 우연히 같은 라벨(가상 시나리오)
  ];
  assert.throws(() => resolveNhCashAccountMap(accounts), /마스킹 충돌/);
});

test('resolveNhCashAccountMap: 같은 실계좌번호가 두 번 나와도(중복 응답) 충돌 아님', () => {
  const accounts = [
    { acctNo: '20501596019', acctType: '01' },
    { acctNo: '20501596019', acctType: '01' },
  ];
  const map = resolveNhCashAccountMap(accounts);
  assert.equal(map.get('위탁'), '20501596019');
});
