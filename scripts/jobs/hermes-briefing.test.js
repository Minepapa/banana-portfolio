import { test } from 'node:test';
import assert from 'node:assert/strict';
import { birthdayLines, runBriefing } from './hermes-briefing.mjs';

const ev = { calendar: '개인', title: '<치과>', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false, location: 'A&B' };

test('아침 일정과 생일, 저녁 내일 일정, 일정 없는 저녁 미발송', async () => {
  const sent = [];
  const deps = { fetchEvents: async () => [ev], readPeople: async () => [{ name: '<민>', birthday: '1990-10-10' }, { name: '동생', birthday: '2000-10-14' }], send: async (message) => sent.push(message), now: () => new Date('2026-10-10T01:00:00Z') };
  const morning = await runBriefing({ deps });
  assert.equal(sent[0].agent, 'hermes');
  assert.equal(sent[0].topic, '아침 브리핑');
  assert.match(morning.body, /■ 오늘 일정/);
  assert.match(morning.body, /&lt;치과&gt; \(A&amp;B\)/);
  assert.match(morning.body, /오늘: &lt;민&gt;\(36살\)/);
  assert.match(morning.body, /4일 뒤: 동생/);
  await runBriefing({ mode: 'evening', date: '2026-10-11', deps });
  assert.equal(sent[1].topic, '내일 일정');
  assert.match(sent[1].body, /■ 내일 일정/);
  const skipped = await runBriefing({ mode: 'evening', date: '2026-10-11', deps: { ...deps, fetchEvents: async () => [] } });
  assert.equal(skipped.reason, 'no-events');
  assert.equal(sent.length, 2);
});

test('OAuth 미설정이면 조회와 발송 없이 종료', async () => {
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { isConfigured: () => false, send: () => { throw new Error('sent'); } } });
  assert.equal(result.reason, 'unconfigured');
  assert.deepEqual(birthdayLines('2026-10-10', [{ name: '빈값', birthday: '' }]), []);
});

test('생일 파일 읽기 실패를 표시해 일정 브리핑은 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: {
    fetchEvents: async () => [ev], readPeople: async () => { throw new Error('vault unavailable'); }, send: async (message) => sent.push(message),
  } });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /■ 오늘 일정[\s\S]*■ 생일\n- 생일 정보 조회 실패/);
});

test('실제 날짜만 허용하고 잘못된 생일은 무시, 2월 29일생은 평년 3월 1일', async () => {
  assert.deepEqual(birthdayLines('2027-03-01', [{ name: '윤일', birthday: '2000-02-29' }, { name: '잘못', birthday: '2000-02-30' }, { name: '월 오류', birthday: '2000-13-01' }]), ['- 오늘: 윤일(27살)']);
  await assert.rejects(() => runBriefing({ mode: 'morning', date: '2026-02-30', deps: { fetchEvents: async () => [] } }), /형식 오류/);
});

test('자동 모드는 05~11시·18~23시만 실행한다', async () => {
  const sent = [];
  const deps = { fetchEvents: async () => [ev], readPeople: async () => [], send: async (message) => sent.push(message) };
  for (const hour of [0, 4, 12, 17]) {
    const result = await runBriefing({ deps: { ...deps, now: () => new Date(`2026-10-10T${String((hour + 15) % 24).padStart(2, '0')}:00:00Z`) } });
    assert.equal(result.reason, 'outside-hours');
  }
  assert.equal(sent.length, 0);
  await runBriefing({ deps: { ...deps, now: () => new Date('2026-10-09T20:00:00Z') } }); // 05 KST
  await runBriefing({ deps: { ...deps, now: () => new Date('2026-10-10T09:00:00Z') } }); // 18 KST
  assert.equal(sent.length, 2);
});
