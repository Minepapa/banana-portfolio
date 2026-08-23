import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssetSection, buildEventsSection, buildAllocationSection } from './morning-briefing.mjs';

test('buildAssetSection: 첫 실행(직전 총자산 없음)은 비교 없이 총자산만 보고', () => {
  const holdings = [{ invest: 1000, evalAmount: 1200 }];
  const { total, text } = buildAssetSection(holdings, null);
  assert.equal(total, 1200);
  assert.match(text, /총자산: 1,200원/);
  assert.match(text, /첫 실행/);
});

test('buildAssetSection: 직전 총자산 대비 증가분을 부호와 함께 계산', () => {
  const holdings = [{ invest: 1000, evalAmount: 1300 }];
  const { text } = buildAssetSection(holdings, 1200);
  assert.match(text, /직전 대비: \+100원 \(\+8\.33%\)/);
});

test('buildAssetSection: 직전 총자산 대비 감소분은 음수 부호', () => {
  const holdings = [{ invest: 1000, evalAmount: 900 }];
  const { text } = buildAssetSection(holdings, 1000);
  assert.match(text, /직전 대비: -100원 \(-10\.00%\)/);
});

test('buildEventsSection: sinceTimestamp 없으면(첫 실행) 이벤트 생략 — 전체 이력을 간밤으로 오인하지 않음', () => {
  const dividends = [{ date: '2026-08-20', stockName: '삼성전자', afterTaxAmount: 5000, recordedAt: '2026-08-20T07:00:00.000Z' }];
  const text = buildEventsSection(dividends, [], null);
  assert.match(text, /첫 실행/);
});

test('buildEventsSection: recordedAt이 워터마크 이후인 이벤트만 포함(배당+체결)', () => {
  const dividends = [
    { date: '2026-08-20', stockName: '삼성전자', afterTaxAmount: 5000, recordedAt: '2026-08-20T07:00:00.000Z' },
    { date: '2026-08-22', stockName: 'SK하이닉스', afterTaxAmount: 3000, recordedAt: '2026-08-22T07:00:00.000Z' },
  ];
  const executions = [
    { tradeDate: '2026-08-21 09:30:00', tradeType: '매수', stockName: 'LG화학', quantity: 5, recordedAt: '2026-08-21T09:30:05.000Z' },
    { tradeDate: '2026-08-19 10:00:00', tradeType: '매도', stockName: '카카오', quantity: 2, recordedAt: '2026-08-19T10:00:05.000Z' },
  ];
  const text = buildEventsSection(dividends, executions, '2026-08-20T23:00:00.000Z');
  assert.match(text, /SK하이닉스/);
  assert.match(text, /LG화학/);
  assert.doesNotMatch(text, /삼성전자/);
  assert.doesNotMatch(text, /카카오/);
});

test('buildEventsSection: 회귀 방지 — 마지막 실행 당일(같은 날짜) 발생분도 워터마크 이후면 포함된다', () => {
  // 이 케이스가 원래 버그였다: 워터마크를 "날짜만"(YYYY-MM-DD)으로 비교하면 같은 날
  // 실행 이후 생긴 이벤트가 "날짜 > 날짜"가 항상 거짓이라 영원히 빠졌다. 지금은
  // recordedAt(전체 타임스탬프)으로 비교하므로 같은 날이어도 시각이 더 늦으면 포함돼야 한다.
  const dividends = [
    { date: '2026-08-23', stockName: '당일오전배당', afterTaxAmount: 1000, recordedAt: '2026-08-23T00:30:00.000Z' }, // 워터마크 이전(오전)
    { date: '2026-08-23', stockName: '당일오후배당', afterTaxAmount: 2000, recordedAt: '2026-08-23T09:00:00.000Z' }, // 워터마크 이후(오후)
  ];
  const text = buildEventsSection(dividends, [], '2026-08-23T01:00:00.000Z'); // 이날 아침 08:00 KST(=전날 23:00 UTC~그날 새벽)에 실행됐다고 가정
  assert.doesNotMatch(text, /당일오전배당/);
  assert.match(text, /당일오후배당/);
});

test('buildEventsSection: 창 안에 이벤트가 없으면 조용함 명시', () => {
  const text = buildEventsSection([], [], '2026-08-20T00:00:00.000Z');
  assert.equal(text, '간밤 배당·체결 이벤트 없음');
});

test('buildAllocationSection: 목표비중 그대로면 "밴드 내 정상"(2026-08-23 Part 6)', () => {
  const holdings = [
    { account: '위탁', assetClass: '채권', evalAmount: 200000 },
    { account: '위탁', assetClass: '금', evalAmount: 100000 },
    { account: '위탁', assetClass: '달러', evalAmount: 100000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 300000 },
    { account: '위탁', assetClass: '해외주식', evalAmount: 300000 },
  ];
  assert.equal(buildAllocationSection(holdings), '자산배분: 밴드 내 정상');
});

test('buildAllocationSection: 이탈 자산군이 있으면 개수와 이름을 짚는다', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', evalAmount: 1000000 }, // 나머지 0 — 국내주식만 100%, 전부 이탈
  ];
  const text = buildAllocationSection(holdings);
  assert.match(text, /자산배분: \d+개 자산군 이탈 중/);
  assert.match(text, /국내주식/);
});
