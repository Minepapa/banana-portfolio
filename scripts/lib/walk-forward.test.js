import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWalkForwardWindows } from './walk-forward.mjs';

const d = (s) => new Date(s);

test('splitWalkForwardWindows: 11년 구간, 5년 in-sample + 1년 out-sample → 6개 윈도우(1년씩 이동)', () => {
  const windows = splitWalkForwardWindows({
    startDate: d('2015-01-01T00:00:00.000Z'), endDate: d('2026-01-01T00:00:00.000Z'),
    inSampleYears: 5, outSampleYears: 1,
  });
  assert.equal(windows.length, 6);
  assert.deepEqual(
    [windows[0].inSampleStart, windows[0].inSampleEnd, windows[0].outSampleStart, windows[0].outSampleEnd],
    [d('2015-01-01T00:00:00.000Z'), d('2020-01-01T00:00:00.000Z'), d('2020-01-01T00:00:00.000Z'), d('2021-01-01T00:00:00.000Z')],
  );
  assert.deepEqual(
    [windows[5].inSampleStart, windows[5].inSampleEnd, windows[5].outSampleStart, windows[5].outSampleEnd],
    [d('2020-01-01T00:00:00.000Z'), d('2025-01-01T00:00:00.000Z'), d('2025-01-01T00:00:00.000Z'), d('2026-01-01T00:00:00.000Z')],
  );
});

test('splitWalkForwardWindows: out-sample 구간이 endDate를 넘는 마지막 미완성 윈도우는 버림(추정 안 함)', () => {
  // 6.5년 구간(5+1=6년 윈도우 하나는 딱 맞지만, 그 다음 윈도우는 out-sample이 끝을 넘음)
  const windows = splitWalkForwardWindows({
    startDate: d('2015-01-01T00:00:00.000Z'), endDate: d('2021-06-01T00:00:00.000Z'),
    inSampleYears: 5, outSampleYears: 1,
  });
  assert.equal(windows.length, 1);
});

test('splitWalkForwardWindows: stepYears 기본값은 outSampleYears(윈도우끼리 안 겹침)', () => {
  const windows = splitWalkForwardWindows({
    startDate: d('2015-01-01T00:00:00.000Z'), endDate: d('2028-01-01T00:00:00.000Z'),
    inSampleYears: 3, outSampleYears: 2,
  });
  // out-sample 구간끼리 연속(겹침 없음) 확인
  for (let i = 1; i < windows.length; i++) {
    assert.deepEqual(windows[i].outSampleStart, windows[i - 1].outSampleEnd);
  }
});

test('splitWalkForwardWindows: stepYears를 outSampleYears보다 작게 주면 윈도우가 겹친다', () => {
  const windows = splitWalkForwardWindows({
    startDate: d('2015-01-01T00:00:00.000Z'), endDate: d('2020-01-01T00:00:00.000Z'),
    inSampleYears: 3, outSampleYears: 1, stepYears: 1,
  });
  assert.ok(windows.length >= 2);
  // stepYears(1) < 처음 윈도우의 in-sample 길이(3) — 두 번째 윈도우의 in-sample이 첫
  // 윈도우의 in-sample 구간과 겹침
  assert.ok(windows[1].inSampleStart < windows[0].inSampleEnd);
});

test('splitWalkForwardWindows: endDate가 startDate보다 이전이거나 같으면 빈 배열', () => {
  assert.deepEqual(splitWalkForwardWindows({ startDate: d('2020-01-01'), endDate: d('2020-01-01'), inSampleYears: 1, outSampleYears: 1 }), []);
  assert.deepEqual(splitWalkForwardWindows({ startDate: d('2020-01-01'), endDate: d('2019-01-01'), inSampleYears: 1, outSampleYears: 1 }), []);
});

test('splitWalkForwardWindows: inSampleYears·outSampleYears·stepYears가 0 이하면 빈 배열', () => {
  const base = { startDate: d('2015-01-01'), endDate: d('2026-01-01') };
  assert.deepEqual(splitWalkForwardWindows({ ...base, inSampleYears: 0, outSampleYears: 1 }), []);
  assert.deepEqual(splitWalkForwardWindows({ ...base, inSampleYears: 5, outSampleYears: 0 }), []);
  assert.deepEqual(splitWalkForwardWindows({ ...base, inSampleYears: 5, outSampleYears: 1, stepYears: -1 }), []);
});

test('splitWalkForwardWindows: 전체 구간이 첫 윈도우보다 짧으면 빈 배열', () => {
  const windows = splitWalkForwardWindows({
    startDate: d('2015-01-01'), endDate: d('2016-01-01'), inSampleYears: 5, outSampleYears: 1,
  });
  assert.deepEqual(windows, []);
});
