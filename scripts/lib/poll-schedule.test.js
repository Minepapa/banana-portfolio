import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  kstClock, isHourlySlot, isHalfHourlySlot, isKrTradingWindow, planIntradaySyncSteps, planSlowValuations,
} from './poll-schedule.mjs';
import { STEPS } from '../jobs/intraday-portfolio-sync.mjs';

// KST 벽시계 → Date(2026-10-29는 목요일)
const kst = (ymd, hm) => new Date(`${ymd}T${hm}:00+09:00`);
const THU = '2026-10-29';
const SAT = '2026-10-31';

test('kstClock: KST 요일·시각(자정은 0시)', () => {
  assert.deepEqual(kstClock(kst(THU, '00:05')), { dow: 4, hour: 0, minute: 5, hhmm: 5 });
  assert.equal(kstClock(kst(SAT, '13:45')).dow, 6);
});

test('isHourlySlot·isHalfHourlySlot: 분 0~9만 시간당 칸, 0~9·30~39가 30분 칸', () => {
  assert.equal(isHourlySlot(kst(THU, '11:05')), true);
  assert.equal(isHourlySlot(kst(THU, '11:15')), false);
  assert.equal(isHalfHourlySlot(kst(THU, '11:35')), true);
  assert.equal(isHalfHourlySlot(kst(THU, '11:45')), false);
});

test('isKrTradingWindow: 평일 08:30~18:00(장후 시간외 포함), 주말 제외', () => {
  assert.equal(isKrTradingWindow(kst(THU, '08:29')), false);
  assert.equal(isKrTradingWindow(kst(THU, '08:30')), true);
  assert.equal(isKrTradingWindow(kst(THU, '15:55')), true);
  assert.equal(isKrTradingWindow(kst(THU, '18:01')), false);
  assert.equal(isKrTradingWindow(kst(SAT, '10:00')), false);
});

test('planIntradaySyncSteps: 계획의 단계 이름이 오케스트레이터 STEPS와 정확히 같다(이름 어긋나면 단계가 영영 안 돎)', () => {
  assert.deepEqual(Object.keys(planIntradaySyncSteps(kst(THU, '11:05'))).sort(), [...STEPS].sort());
});

test('planIntradaySyncSteps: 거래 시간대 시간당 칸이면 증권사 조회 단계 전부', () => {
  const plan = planIntradaySyncSteps(kst(THU, '11:05'));
  assert.ok(Object.values(plan).every(Boolean));
});

test('planIntradaySyncSteps: 거래 시간대 :15 회차는 체결 감지와 로컬 단계만(IRP·NH 예수금 건너뜀)', () => {
  const plan = planIntradaySyncSteps(kst(THU, '11:15'));
  assert.equal(plan['reconcile-nh-executions.mjs'], true);
  assert.equal(plan['reconcile-irp-executions.mjs'], false);
  assert.equal(plan['reconcile-irp.mjs'], false);
  assert.equal(plan['reconcile-nh-cash.mjs'], false);
  assert.equal(plan['update-holdings-from-executions.mjs'], true);
  assert.equal(plan['update-cash-from-ledger.mjs'], true);
  assert.equal(plan['update-fund-holdings-from-purchases.mjs'], true);
});

test('planIntradaySyncSteps: 거래 시간대 :35 회차는 NH 예수금(30분)도 돈다', () => {
  assert.equal(planIntradaySyncSteps(kst(THU, '11:35'))['reconcile-nh-cash.mjs'], true);
});

test('planIntradaySyncSteps: 장외 :15는 체결도 건너뛰지만 미국 장중이면 체결 감지는 돈다', () => {
  assert.equal(planIntradaySyncSteps(kst(THU, '23:15'))['reconcile-nh-executions.mjs'], false);
  assert.equal(planIntradaySyncSteps(kst(THU, '23:15'), { usOpen: true })['reconcile-nh-executions.mjs'], true);
  assert.equal(planIntradaySyncSteps(kst(THU, '23:15'), { usOpen: true })['reconcile-nh-cash.mjs'], false);
});

test('planIntradaySyncSteps: 장외 시간당 칸은 NH 체결·예수금만, IRP는 안 돎', () => {
  const plan = planIntradaySyncSteps(kst(SAT, '10:05'));
  assert.equal(plan['reconcile-nh-executions.mjs'], true);
  assert.equal(plan['reconcile-nh-cash.mjs'], true);
  assert.equal(plan['reconcile-irp.mjs'], false);
  assert.equal(plan['reconcile-irp-executions.mjs'], false);
});

test('planIntradaySyncSteps: 평일 15:55·16:05 회차는 안전망 잡과 겹쳐 전부 건너뜀, 15:45·16:15는 돈다', () => {
  assert.ok(Object.values(planIntradaySyncSteps(kst(THU, '15:55'))).every((v) => !v));
  assert.ok(Object.values(planIntradaySyncSteps(kst(THU, '16:05'))).every((v) => !v));
  assert.equal(planIntradaySyncSteps(kst(THU, '15:45'))['reconcile-nh-executions.mjs'], true);
  assert.equal(planIntradaySyncSteps(kst(THU, '16:15'))['update-holdings-from-executions.mjs'], true);
  assert.equal(planIntradaySyncSteps(kst(SAT, '16:05'))['update-holdings-from-executions.mjs'], true);
});

test('planIntradaySyncSteps: full이면 시각과 무관하게 전부', () => {
  assert.ok(Object.values(planIntradaySyncSteps(kst(SAT, '03:45'), { full: true })).every(Boolean));
});

test('planSlowValuations: 채권은 거래 시간대 시간당 1회, 금·펀드는 시간당 1회', () => {
  assert.deepEqual(planSlowValuations(kst(THU, '11:00')), { bond: true, gold: true, fund: true });
  assert.deepEqual(planSlowValuations(kst(THU, '11:10')), { bond: false, gold: false, fund: false });
  assert.deepEqual(planSlowValuations(kst(SAT, '11:00')), { bond: false, gold: true, fund: true });
  assert.deepEqual(planSlowValuations(kst(THU, '11:10'), { full: true }), { bond: true, gold: true, fund: true });
});

// plist 고정 분과 "시간당 칸(분 0~9)" 전제를 묶는다 — 분을 옮기면 느린 값 조회가 영영 멈출 수 있다.
const plistMinutes = (job) => {
  const xml = readFileSync(new URL(`../launchd/com.banana2.${job}.plist`, import.meta.url), 'utf8');
  return [...xml.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
};

test('plist: 시세·시장감시·동기화가 10분 간격 고정 분이고 서로 다른 분, 시세·동기화는 시간당 칸(0~9)을 하나씩 가진다', () => {
  const prices = plistMinutes('update-holdings-prices');
  const monitor = plistMinutes('intraday-market-move-monitor');
  const sync = plistMinutes('intraday-portfolio-sync');
  for (const mins of [prices, monitor, sync]) {
    assert.equal(mins.length, 6);
    assert.ok(mins.every((m, i) => i === 0 || m - mins[i - 1] === 10));
  }
  assert.equal(new Set([prices[0], monitor[0], sync[0]]).size, 3);
  assert.equal(prices.filter((m) => m < 10).length, 1);
  assert.equal(sync.filter((m) => m < 10).length, 1);
});
