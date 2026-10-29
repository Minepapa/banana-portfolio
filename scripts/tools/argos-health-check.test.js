import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDay } from './argos-health-check.mjs';

const T = Date.parse('2026-10-25T12:00:00+09:00');
const M = 60_000;
const home = { lat: 37.5665, lon: 126.978, acc: 10 };
const e = (type, at, payload = {}) => ({ type, occurred_at: at, received_at: at + 5000, payload });

test('겹친 체류와 제자리에서 끝난 체류를 이상 신호로 낸다', () => {
  const r = checkDay([
    e('stay.started', T, { stay_id: 'a', anchor: home }),
    e('stay.started', T + 10 * M, { stay_id: 'b', anchor: home }),
    e('stay.ended', T + 20 * M, { stay_id: 'a' }),
    e('location.point_recorded', T + 21 * M, { ...home }),
  ]);
  assert.ok(r.issues.some((i) => i.startsWith('체류 겹침')));
  assert.ok(r.issues.some((i) => i.startsWith('체류가 제자리에서 끝남')));
});

test('정상적인 하루는 이상 신호가 없고, 빈 시간과 문제 이벤트는 잡는다', () => {
  const ok = [];
  for (let i = 0; i < 8; i += 1) ok.push(e('core.heartbeat', T + i * 15 * M), e('location.point_recorded', T + i * 15 * M, { ...home }));
  assert.deepEqual(checkDay(ok).issues, []);
  const bad = [e('core.heartbeat', T), e('core.heartbeat', T + 120 * M), e('media.deletions_held', T + 5 * M)];
  const r = checkDay(bad);
  assert.ok(r.issues.some((i) => i.startsWith('상태 보고 120분')));
  assert.ok(r.issues.some((i) => i.startsWith('media.deletions_held')));
});
