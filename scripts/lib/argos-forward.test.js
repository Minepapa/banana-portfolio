import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstTimestamp, locationPointsFromEvents, spendingRecordsFromEvents } from './argos-forward.mjs';

// 좌표·문구는 가상 값이다(공개 저장소).
const posted = Date.parse('2040-02-03T21:38:05+09:00');
const location = (payload, extra = {}) => ({ type: 'location.point_recorded', id: 'l1', payload, ...extra });
const notification = (payload, extra = {}) => ({ type: 'notification.received', id: 'n1', payload, ...extra });

test('KST 문자열 시각: 수집 잡이 읽는 "YYYY-MM-DD HH:MM:SS"', () => {
  assert.equal(kstTimestamp(posted), '2040-02-03 21:38:05');
  assert.equal(kstTimestamp(Date.parse('2040-02-03T15:30:00Z')), '2040-02-04 00:30:00');
});

test('위치: OwnTracks 모양으로, 잘못된 값·다른 종류·시계 의심은 뺀다', () => {
  const points = locationPointsFromEvents([
    location({ lat: 10.5, lon: 20.5, acc: 12, batt: 80, tid: 'ar', tst: 2_213_000_000, mode: 'x', stay_id: 's' }),
    location({ lat: 10.5, lon: 20.5, tst: 2_213_000_001 }),
    location({ lat: 'x', lon: 20.5, tst: 2_213_000_002 }),
    location({ lat: 10.5, lon: 20.5, tst: 2_213_000_003 }, { clock_suspect: true }),
    notification({ category: '소비', body: '1,000원', postedAt: posted }),
  ]);
  assert.deepEqual(points, [
    { _type: 'location', tst: 2_213_000_000, lat: 10.5, lon: 20.5, acc: 12, batt: 80, tid: 'ar' },
    { _type: 'location', tst: 2_213_000_001, lat: 10.5, lon: 20.5 },
  ]);
});

test('소비: 소비 분류 알림만, 알림 앱 원문 모양으로, id는 argos: 접두사', () => {
  const records = spendingRecordsFromEvents([
    notification({ category: '소비', source: 'kakao', packageName: 'com.example', appLabel: '가상앱',
      sender: '가상카드', body: '승인 1,000원', postedAt: posted, rawExtras: {} }),
    notification({ category: '투자', body: '체결 1주', postedAt: posted }),
    notification({ category: '소비', body: '   ', postedAt: posted }),
    notification({ category: '소비', body: '승인', postedAt: 0 }),
    notification({ category: '소비', body: '승인', postedAt: posted }, { clock_suspect: true }),
  ]);
  assert.deepEqual(records, [{ id: 'argos:n1', ts: '2040-02-03 21:38:05', source: 'kakao', packageName: 'com.example',
    appLabel: '가상앱', sender: '가상카드', body: '승인 1,000원', postedAt: posted }]);
});
