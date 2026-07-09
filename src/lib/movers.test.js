import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyChange } from './movers.js';

const acct = (total_eval, holdings) => ({ total_eval, holdings });

test('computeDailyChange: 스냅샷 없거나 총평가 0이면 null (localStorage 폴백 유도)', () => {
  assert.equal(computeDailyChange({}, null), null);
  assert.equal(computeDailyChange({}, { totalEval: 0, byHolding: {} }), null);
});

test('computeDailyChange: 계좌 전체 델타는 총평가 기준(거래 포함)', () => {
  const accounts = {
    ISA: acct(1000, []), 위탁: acct(2000, []), 연금저축: acct(0, []), IRP: acct(0, []),
  };
  const snap = { date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 2800, byHolding: {} };
  const r = computeDailyChange(accounts, snap);
  assert.equal(r.totalDelta, 200);           // 3000 − 2800
  assert.equal(Math.round(r.totalPct * 10000) / 10000, 0.0714);
  assert.equal(r.baselineDate, '2026-07-10');
  assert.equal(r.baselineTs, '2026-07-10 08:00');
});

test('computeDailyChange: 종목 무버는 단가 변동만(수량 무관), 등락률(%) abs 내림차순', () => {
  const accounts = {
    ISA: acct(0, []),
    위탁: acct(0, [
      { name: '삼성전자', eval: 11000, qty: 40, type: '국내주식' },   // 단가 275 → 스냅 250 = +25/주 ×40 = +1000
      { name: 'SK하이닉스', eval: 5100, qty: 5, type: '국내주식' },    // 단가 1020 → 스냅 1000 = +20 ×5 = +100
    ]),
    연금저축: acct(0, []), IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: {
      '위탁|삼성전자': { e: 10000, q: 40 },
      '위탁|SK하이닉스': { e: 5000, q: 5 },
    },
  };
  const r = computeDailyChange(accounts, snap);
  assert.equal(r.movers.length, 2);
  assert.equal(r.movers[0].name, '삼성전자');   // abs(+1000) > abs(+100)
  assert.equal(r.movers[0].wonDelta, 1000);
  assert.equal(r.movers[0].account, '위탁');
  assert.equal(r.movers[1].name, 'SK하이닉스');
  assert.equal(r.movers[1].wonDelta, 100);
});

test('computeDailyChange: 정렬 기준은 원화금액이 아니라 등락률 — 금액 작아도 %가 크면 상위', () => {
  const accounts = {
    ISA: acct(0, []),
    위탁: acct(0, [
      { name: '고액저변동', eval: 1010000, qty: 10000, type: '국내주식' },   // 단가 101 vs 100 = +1%, 원화 +10,000
      { name: '소액고변동', eval: 200, qty: 10, type: '국내주식' },          // 단가 20 vs 10 = +100%, 원화 +100
    ]),
    연금저축: acct(0, []), IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: {
      '위탁|고액저변동': { e: 1000000, q: 10000 },
      '위탁|소액고변동': { e: 100, q: 10 },
    },
  };
  const r = computeDailyChange(accounts, snap);
  // 원화 기준이면 고액저변동(10,000)이 1등이지만, %기준이므로 소액고변동(100%)이 1등이어야 함.
  assert.equal(r.movers[0].name, '소액고변동');
  assert.equal(Math.round(r.movers[0].pct * 100) / 100, 1);
  assert.equal(r.movers[1].name, '고액저변동');
});

test('computeDailyChange: 거래로 수량 바뀌어도 단가델타는 순수가격, traded 표기', () => {
  const accounts = {
    ISA: acct(0, []),
    // 스냅 40주@250 → 이후 20주 매도, 남은 20주. 현재 단가 275(가격만 오름).
    위탁: acct(0, [{ name: '삼성전자', eval: 5500, qty: 20, type: '국내주식' }]),
    연금저축: acct(0, []), IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: { '위탁|삼성전자': { e: 10000, q: 40 } },   // 스냅 단가 250
  };
  const r = computeDailyChange(accounts, snap);
  // 단가 275 − 250 = 25, ×현재수량 20 = +500 (매도분 −거래는 무버에 안 섞임)
  assert.equal(r.movers[0].wonDelta, 500);
  assert.equal(r.movers[0].traded, true);
  assert.equal(Math.round(r.movers[0].pct * 100) / 100, 0.1);
});

test('computeDailyChange: 중복명은 계좌|종목명 키로 구분', () => {
  const accounts = {
    ISA: acct(0, []),
    위탁: acct(0, [{ name: 'TIGER 미국배당다우존스', eval: 3100, qty: 200, type: '배당주' }]),
    연금저축: acct(0, [{ name: 'TIGER 미국배당다우존스', eval: 4400, qty: 280, type: '배당주' }]),
    IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: {
      '위탁|TIGER 미국배당다우존스': { e: 3000, q: 200 },   // 15.0 → 15.5
      '연금저축|TIGER 미국배당다우존스': { e: 4200, q: 280 }, // 15.0 → 15.714
    },
  };
  const r = computeDailyChange(accounts, snap);
  assert.equal(r.movers.length, 2);
  const wit = r.movers.find(m => m.account === '위탁');
  const pen = r.movers.find(m => m.account === '연금저축');
  assert.equal(wit.wonDelta, 100);   // (15.5−15.0)×200
  assert.equal(pen.wonDelta, 200);   // (4400/280 − 15.0)×280 = 4400−4200
});

test('computeDailyChange: 현금성(예수금·외화 RP·MMF)·기준없는 종목은 무버 제외', () => {
  const accounts = {
    ISA: acct(0, []),
    위탁: acct(0, [
      { name: '예수금', eval: 1000000, qty: 0, type: '현금성' },
      { name: '외화 RP', eval: 2800000, qty: 1869, type: '달러' },
      { name: '신규종목', eval: 500, qty: 10, type: '국내주식' },   // 스냅에 없음 → skip
    ]),
    연금저축: acct(0, [{ name: '삼성신종종류형 MMF 제4호', eval: 120000, qty: 0, type: '채권' }]),
    IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: { '위탁|외화 RP': { e: 2700000, q: 1869 } },   // 있어도 현금성이라 제외
  };
  const r = computeDailyChange(accounts, snap);
  assert.equal(r.movers.length, 0);
});

test('computeDailyChange: 변동 0%(단가 무변동) 종목은 무버에서 제외(기준선 직후 all-zero 방지)', () => {
  const accounts = {
    ISA: acct(0, []),
    위탁: acct(0, [
      { name: '무변동', eval: 10000, qty: 10, type: '국내주식' },   // 단가 동일 → 0
      { name: '오름', eval: 11000, qty: 10, type: '국내주식' },     // +1000
    ]),
    연금저축: acct(0, []), IRP: acct(0, []),
  };
  const snap = {
    date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999,
    byHolding: { '위탁|무변동': { e: 10000, q: 10 }, '위탁|오름': { e: 10000, q: 10 } },
  };
  const r = computeDailyChange(accounts, snap);
  assert.equal(r.movers.length, 1);
  assert.equal(r.movers[0].name, '오름');
});

test('computeDailyChange: topN 상한', () => {
  const holdings = [];
  const byHolding = {};
  for (let i = 0; i < 8; i++) {
    holdings.push({ name: `종목${i}`, eval: 1000 + i * 100, qty: 10, type: '국내주식' });
    byHolding[`위탁|종목${i}`] = { e: 1000, q: 10 };
  }
  const accounts = { ISA: acct(0, []), 위탁: acct(0, holdings), 연금저축: acct(0, []), IRP: acct(0, []) };
  const snap = { date: '2026-07-10', ts: '2026-07-10 08:00', totalEval: 999999, byHolding };
  const r = computeDailyChange(accounts, snap, { topN: 3 });
  assert.equal(r.movers.length, 3);
});
