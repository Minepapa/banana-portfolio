import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayCollection, formatCollectionLine, judgeCollection } from './spending-collection.mjs';

const root = mkdtempSync(join(tmpdir(), 'spending-collection-'));
after(() => rmSync(root, { recursive: true, force: true }));
const spendingDir = join(root, '95_Etna', 'Spending');
const eventsDir = join(root, '95_Etna', 'Events', '2040');
mkdirSync(join(spendingDir, '2040'), { recursive: true });
mkdirSync(eventsDir, { recursive: true });

const body = (day, clock) => `삼성1234승인 정*호\n2,000원 일시불\n${day.slice(5).replace('-', '/')} ${clock} 테스트가게\n누적10,000원`;
const kst = (day, clock) => Date.parse(`${day}T${clock}:00+09:00`);
const payment = (id, day, clock) => ({ type: 'notification.received', id, payload: { category: '소비', postedAt: kst(day, clock),
  sender: '삼성카드', packageName: 'com.kakao.talk', appLabel: '카카오톡', source: 'kakao', body: body(day, clock) } });
const heartbeat = { type: 'core.heartbeat', id: 'h', payload: {} };
const writeEvents = (day, events) => writeFileSync(join(eventsDir, `${day}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n'));
const writeAlerts = (day, records) => writeFileSync(join(spendingDir, '2040', `${day}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n'));
const alert = (id, day, clock) => ({ id, ts: `${day} ${clock}:00`, source: 'kakao', packageName: 'com.kakao.talk',
  appLabel: '카카오톡', sender: '삼성카드', body: body(day, clock), postedAt: kst(day, clock) });

test('판정: 아르고스가 더 많으면 확인 필요, 0건은 수집 흔적이 있으면 결제 없음', () => {
  assert.deepEqual(judgeCollection({ alertCount: 1, argosCount: 2, alertSource: true, argosAlive: true }), { status: 'check', reason: 'argos-more' });
  assert.deepEqual(judgeCollection({ alertCount: 2, argosCount: 1, alertSource: true, argosAlive: true }), { status: 'ok', reason: null });
  assert.deepEqual(judgeCollection({ alertCount: 0, argosCount: 0, alertSource: false, argosAlive: true }), { status: 'quiet', reason: null });
  assert.deepEqual(judgeCollection({ alertCount: 0, argosCount: 0, alertSource: true, argosAlive: false }), { status: 'quiet', reason: null });
  assert.deepEqual(judgeCollection({ alertCount: 0, argosCount: 0, alertSource: false, argosAlive: false }), { status: 'check', reason: 'no-source' });
});

test('하루 점검: 알림 앱이 놓친 아르고스 결제를 세고, 자정 직전 결제는 다음 날 파일에서도 찾는다', () => {
  writeAlerts('2040-02-03', [alert('a1', '2040-02-03', '12:00')]);
  // 23:59 결제 알림이 다음 날 받은 파일에 있다.
  writeEvents('2040-02-03', [heartbeat, payment('e1', '2040-02-03', '12:00')]);
  writeEvents('2040-02-04', [heartbeat, payment('e2', '2040-02-03', '23:59'), payment('e3', '2040-02-04', '08:00')]);
  const result = dayCollection('2040-02-03', { root, spendingDir });
  assert.deepEqual({ ...result }, { date: '2040-02-03', alertCount: 1, argosCount: 2, alertSource: true, argosAlive: true,
    status: 'check', reason: 'argos-more' });
  assert.equal(formatCollectionLine(result), '- 02-03 지출 수집 확인 필요: 아르고스 결제 2건, 지출 기록 1건');
});

test('하루 점검: 결제 없던 날은 결제 없음, 흔적이 없는 날은 확인 필요', () => {
  writeEvents('2040-02-05', [heartbeat]);
  const quiet = dayCollection('2040-02-05', { root, spendingDir });
  assert.equal(quiet.status, 'quiet');
  assert.equal(formatCollectionLine(quiet), null);
  const none = dayCollection('2040-02-07', { root, spendingDir });
  assert.equal(none.reason, 'no-source');
  assert.equal(formatCollectionLine(none), '- 02-07 지출 수집 확인 필요: 알림 앱·아르고스 모두 그날 기록 없음');
});
