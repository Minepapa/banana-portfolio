import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnprocessedExecutions, pickUnprocessedDividends, pickAccountlessAppliedExecutions, matchesLegacyExecution, findMatchingLegacyExecution } from './update-holdings-from-executions.mjs';

const f = (parsed) => ({ filepath: '/x', content: '', parsed });

test('pickUnprocessedExecutions: legacy(Phase 7 마이그레이션) 제외 — 이미 스냅샷에 반영됨', () => {
  const files = [f({ legacy: true, tradeDate: '2026-01-01' }), f({ tradeDate: '2026-01-02' })];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.tradeDate, '2026-01-02');
});

test('pickUnprocessedExecutions: holdingsApplied 이미 true인 것 제외 — 재처리 방지', () => {
  const files = [f({ holdingsApplied: true, tradeDate: '2026-01-01' }), f({ tradeDate: '2026-01-02' })];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
});

test('pickUnprocessedExecutions: tradeDate 오름차순 정렬(가중평균 순서가 중요)', () => {
  const files = [f({ tradeDate: '2026-03-01' }), f({ tradeDate: '2026-01-01' }), f({ tradeDate: '2026-02-01' })];
  const r = pickUnprocessedExecutions(files);
  assert.deepEqual(r.map((x) => x.parsed.tradeDate), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('pickUnprocessedDividends: legacy(Phase 7 마이그레이션) 제외 — account:null로 영구 고정된 스냅샷', () => {
  const files = [f({ legacy: true, account: null, date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: account 이미 확정된 것 제외 — 재처리 방지(holdingsApplied 대신 account 유무로 판정)', () => {
  const files = [f({ account: 'ISA', date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: date 오름차순 정렬', () => {
  const files = [f({ account: null, date: '2026-03-01' }), f({ account: null, date: '2026-01-01' }), f({ account: null, date: '2026-02-01' })];
  const r = pickUnprocessedDividends(files);
  assert.deepEqual(r.map((x) => x.parsed.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('[막아야 함/실사고] pickAccountlessAppliedExecutions: holdingsApplied:true·account:null(계좌 영구기록 시작 전 처리분) 골라냄', () => {
  const files = [
    f({ holdingsApplied: true, account: null, tradeDate: '2026-06-01' }), // 백필 대상(실측 84건 중 60건이 이 상태였음)
    f({ holdingsApplied: true, account: '위탁', tradeDate: '2026-06-02' }), // 이미 채워짐 — 제외
    f({ holdingsApplied: false, account: null, tradeDate: '2026-06-03' }), // 아직 미처리 — pickUnprocessedExecutions 몫, 여기 대상 아님
  ];
  const r = pickAccountlessAppliedExecutions(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.tradeDate, '2026-06-01');
});

test('pickAccountlessAppliedExecutions: legacy는 제외(account:null이 영구 고정 스냅샷)', () => {
  const files = [f({ legacy: true, holdingsApplied: true, account: null })];
  assert.equal(pickAccountlessAppliedExecutions(files).length, 0);
});

const exec = (overrides = {}) => ({ tradeDate: '2026-06-19 10:15:04', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350, ...overrides });

test('[막아야 함/실사고] matchesLegacyExecution: 날짜(일단위)·구분·종목명·수량 일치하면 중복(2026-08-18 발견 — 알람 시트 잔존 옛 행이 마이그레이션 스냅샷을 재적용해 12개 보유종목 오염시킨 실사고)', () => {
  const legacy = [{ tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350 }];
  assert.equal(matchesLegacyExecution(exec(), legacy), true);
});

test('[막아야 함/실사고2] matchesLegacyExecution: 단가가 달라도 중복(2026-08-18 재발견 — 해외주식은 legacy가 원화환산가·live가 USD원문가라 단가가 절대 같아질 수 없음, 이 조건 때문에 마이크로소프트·알파벳·엔비디아 중복 7건이 탐지를 피해 실제 앱 잔고와 다르게 재적용됐던 실사고)', () => {
  const legacy = [{ tradeDate: '2026-05-12', tradeType: '매수', stockName: '마이크로소프트', quantity: 2, price: 585919 }];
  const liveUsd = { tradeDate: '2026-05-12 13:20:58', tradeType: '매수', stockName: '마이크로소프트', quantity: 2, price: 410.565 };
  assert.equal(matchesLegacyExecution(liveUsd, legacy), true);
});

test('matchesLegacyExecution: 시각까지 있는 legacy tradeDate라도 날짜(앞 10자)만 비교', () => {
  const legacy = [{ tradeDate: '2026-06-19 00:00:00', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350 }];
  assert.equal(matchesLegacyExecution(exec(), legacy), true);
});

test('matchesLegacyExecution: 수량이 다르면 중복 아님(진짜 다른 체결)', () => {
  const legacy = [{ tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 3, price: 205350 }];
  assert.equal(matchesLegacyExecution(exec(), legacy), false);
});

test('matchesLegacyExecution: legacy 없으면 false', () => {
  assert.equal(matchesLegacyExecution(exec(), []), false);
});

// 실사고 회귀 테스트(2026-08-19, 오너 지시 "체결도 매핑 가능하면 매핑해봐") — 전량청산돼
// 보유 파일이 없는 종목(삼성바이오로직스·현대차 매도 등)은 이름매칭 대조 대상 자체가
// 없어 영구히 계좌귀속불가였는데, legacy 스냅샷엔 이미 그 계좌가 남아있었다.
test('[막아야 함/실사고3] findMatchingLegacyExecution: 매치되면 그 legacy 레코드(account 포함) 자체를 반환', () => {
  const legacy = [{ tradeDate: '2026-07-13', tradeType: '매도', stockName: '삼성바이오로직스', quantity: 1, account: '위탁' }];
  const r = findMatchingLegacyExecution({ tradeDate: '2026-07-13 12:27:53', tradeType: '매도', stockName: '삼성바이오로직스', quantity: 1 }, legacy);
  assert.equal(r?.account, '위탁');
});

test('findMatchingLegacyExecution: 매치 없으면 null', () => {
  assert.equal(findMatchingLegacyExecution(exec(), []), null);
});

// 코드리뷰 지적(2026-08-19) — 같은 날·구분·종목명·수량인데 계좌가 다른 legacy 후보가
// 둘 이상이면(이론상 가능) 어느 쪽인지 추정하지 않는다. dedup 판정(레코드 자체 반환)은
// 유지하되 account만 null로 낮춘다.
test('[막아야 함] findMatchingLegacyExecution: 후보가 여럿인데 계좌가 갈리면 추정하지 않고 account:null(레코드는 반환 — dedup 판정은 유지)', () => {
  const legacy = [
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA' },
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: '위탁' },
  ];
  const r = findMatchingLegacyExecution(exec(), legacy);
  assert.notEqual(r, null);
  assert.equal(r.account, null);
});

test('findMatchingLegacyExecution: 후보가 여럿이어도 계좌가 전부 같으면 그 계좌 그대로', () => {
  const legacy = [
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA' },
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA' },
  ];
  const r = findMatchingLegacyExecution(exec(), legacy);
  assert.equal(r.account, 'ISA');
});
