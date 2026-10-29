import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkPaymentsToRoute, writeSpendingPlaces, summarizeMonthPlaces, spendingPlacesPath } from './spending-places.mjs';

const root = mkdtempSync(join(tmpdir(), 'spending-places-'));
after(() => rmSync(root, { recursive: true, force: true }));

const at = (hhmm, date = '2026-10-28') => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
// daily-note computeRoute가 넘기는 모양: start/end는 표시용 HH:MM, startAt/endAt은 원래 시각.
const routeOn = (date) => [
  { kind: 'stay', label: '집', registered: true, placeName: '집', start: '00:00', end: '07:40', startAt: at('00:00', date), endAt: at('07:40', date) },
  { kind: 'move', label: '이동 · 차량', start: '07:40', end: '08:30', startAt: at('07:40', date), endAt: at('08:30', date) },
  { kind: 'stay', label: '미등록: 연수구 송도동 1-1', registered: false, address: '연수구 송도동 1-1', start: '08:30', end: '09:00', startAt: at('08:30', date), endAt: at('09:00', date) },
  { kind: 'stay', label: '스타벅스 송도점', registered: false, activity: '카페', start: '09:05', end: '09:40', startAt: at('09:05', date), endAt: at('09:40', date) },
  { kind: 'roam', label: '송도동 일대 산책', registered: false, start: '19:00', end: '19:30', startAt: at('19:00', date), endAt: at('19:30', date) },
  // 마지막 체류: 점은 21:00에 끊겼지만 데일리는 24:00까지 집으로 확정했다.
  { kind: 'stay', label: '집', registered: true, placeName: '집', start: '20:00', end: '24:00', startAt: at('20:00', date), endAt: at('21:00', date) },
];
const route = routeOn('2026-10-28');
const pay = (hhmm, amount, merchant = '가게', date = '2026-10-28') => ({ at: at(hhmm, date), amount, merchant, card: '삼성', category: '일반' });

test('결제를 체류·이동·위치 없음으로 나누고 장소 종류를 붙인다', () => {
  const linked = linkPaymentsToRoute(route, [
    pay('07:00', 1000), pay('08:00', 2000), pay('08:45', 3000), pay('09:20', 4000),
    pay('19:10', 5000), pay('23:30', 6000), pay('15:00', 7000), { at: 'bad', amount: 8000 },
  ], { date: '2026-10-28' });
  assert.deepEqual(linked.map(({ where, place, placeKind }) => [where, place, placeKind]), [
    ['stay', '집', 'registered'],
    ['move', '이동 중', null],
    ['stay', '연수구 송도동 1-1', 'area'],
    ['stay', '스타벅스 송도점', 'named'],
    ['stay', '송도동 일대 산책', 'area'],
    ['stay', '집', 'registered'], // 24:00 확정 체류는 자정까지
    ['none', '위치 없음', null],
    ['none', '위치 없음', null],
  ]);
  assert.equal(linked[3].activity, '카페');
});

test('체류 끝 직후 승인은 이동 구간보다 앞 체류에 붙는다(승인 유예)', () => {
  const [linked] = linkPaymentsToRoute(route, [pay('07:45', 1000)], { date: '2026-10-28' });
  assert.equal(linked.place, '집');
  const [late] = linkPaymentsToRoute(route, [pay('08:10', 1000)], { date: '2026-10-28' });
  assert.equal(late.where, 'move');
});

test('일정으로만 활동이 붙은 미등록 체류는 주소로 묶는다', () => {
  const scheduled = [{ kind: 'stay', label: '미등록: 연수구 송도동 1-1', registered: false, address: '연수구 송도동 1-1',
    activity: '공연', start: '10:00', end: '12:00', startAt: at('10:00'), endAt: at('12:00') }];
  const [linked] = linkPaymentsToRoute(scheduled, [pay('11:00', 1000)], { date: '2026-10-28' });
  assert.deepEqual([linked.place, linked.placeKind, linked.activity], ['연수구 송도동 1-1', 'area', '공연']);
});

test('date가 없으면 24:00 확장 없이 원래 끝 시각만 쓴다', () => {
  const [linked] = linkPaymentsToRoute(route, [pay('23:30', 1000)]);
  assert.equal(linked.where, 'none');
});

test('같은 내용이면 다시 쓰지 않고 월 단위로 장소별 합계를 낸다', () => {
  const writes = [];
  const write = (path, text) => { writes.push(path); writeFileSync(path, text); };
  const payments = [pay('07:00', 1000), pay('09:20', 4000), pay('08:00', 500)];
  const first = writeSpendingPlaces({ date: '2026-10-28', route, payments, root, write });
  assert.equal(first, spendingPlacesPath('2026-10-28', root));
  assert.equal(writeSpendingPlaces({ date: '2026-10-28', route, payments, root, write }), null);
  assert.equal(writes.length, 1);
  writeSpendingPlaces({ date: '2026-10-29', route: routeOn('2026-10-29'), payments: [pay('23:00', 2000, '편의점', '2026-10-29')], root, write });
  writeSpendingPlaces({ date: '2026-11-01', route: routeOn('2026-11-01'), payments: [pay('07:00', 99, '가게', '2026-11-01')], root, write });
  const month = summarizeMonthPlaces('2026-10', root);
  assert.equal(month.recordedDays, 2);
  assert.equal(month.firstDay, '2026-10-28');
  assert.deepEqual(month.places.map(({ place, days, count, amount }) => [place, days, count, amount]), [
    ['스타벅스 송도점', 1, 1, 4000],
    ['집', 2, 2, 3000],
  ]);
  assert.equal(month.moveAmount, 500);
  assert.equal(month.noneAmount, 0);
  assert.equal(JSON.parse(readFileSync(first, 'utf8')).schemaVersion, 1);
});

test('파일이 없는 달은 기록 0일', () => {
  assert.deepEqual(summarizeMonthPlaces('2026-09', root), { month: '2026-09', recordedDays: 0, firstDay: null,
    places: [], moveAmount: 0, noneAmount: 0 });
});
