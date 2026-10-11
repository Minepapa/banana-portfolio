import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachRouteActivities } from './route-activities.mjs';

const stay = (start, end, extra = {}) => ({ start: `2026-10-10T${start}:00.000Z`, end: `2026-10-10T${end}:00.000Z`,
  lat: 1, lon: 2, kind: 'stay', label: '미등록: 가상 주소', ...extra });

test('결제 가맹점이 식사·카페면 정지 체류 라벨을 가게 이름으로 바꾸고 활동을 붙인다', async () => {
  const stays = [stay('02:10', '04:00', { label: '가상 공연장' }), stay('04:00', '04:40', { kind: 'roam', label: '가상동 일대 산책' }),
    stay('04:40', '05:30')];
  const payments = [
    { at: '2026-10-10T04:20:00.000Z', amount: 1100, merchant: '가상과자점' },
    { at: '2026-10-10T05:20:00.000Z', amount: 2200, merchant: '가상식당' },
    { at: '2026-10-10T05:35:00.000Z', amount: 3300, merchant: '가상광역시가상구시' },
  ];
  const keyword = async (merchant) => (merchant === '가상식당' ? { name: '가상식당 본점', category: 'FD6' }
    : merchant === '가상과자점' ? { name: '가상과자점', category: 'CS2' } : null);
  const events = [{ title: '가족 공연 - 가상', start: '2026-10-10T02:30:00.000Z', end: '2026-10-10T03:30:00.000Z' }];
  const result = await attachRouteActivities(stays, { payments, events, keyword });
  assert.deepEqual(result.map((item) => [item.label, item.activity ?? null]), [
    ['가상 공연장', '공연'],
    ['가상동 일대 산책', null],
    ['가상식당 본점', '식사'],
  ]);
});

test('등록 장소는 결제로 라벨을 바꾸지 않고, 지역명 가맹점·분류 없는 결제는 무시한다', async () => {
  const result = await attachRouteActivities([stay('01:00', '02:00', { registered: true, label: '집' })], {
    payments: [{ at: '2026-10-10T01:30:00.000Z', amount: 1, merchant: '가상식당' }],
    keyword: async () => ({ name: '가상식당', category: 'FD6' }),
  });
  assert.equal(result[0].label, '집');
  assert.equal(result[0].activity, undefined);
});
