import { test } from 'node:test';
import assert from 'node:assert/strict';
import { birthdayLines, main, runBriefing } from './hermes-briefing.mjs';

const ev = { calendar: '개인', title: '<치과>', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false, location: 'A&B' };

test('아침 일정과 생일, 저녁 내일 일정, 일정 없는 저녁 미발송', async () => {
  const sent = [];
  const deps = { fetchEvents: async () => [ev], readOwners: async () => { throw new Error('unavailable'); }, readPeople: async () => [{ name: '<민>', birthday: '1990-10-10' }, { name: '동생', birthday: '2000-10-14' }], send: async (message) => sent.push(message), now: () => new Date('2026-10-10T01:00:00Z') };
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

test('OAuth 미설정이어도 생일과 일정 연결 경고를 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { isConfigured: () => false, readPeople: async () => [{ name: '민', birthday: '1990-10-10' }], send: async (message) => sent.push(message) } });
  assert.equal(result.alert, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /- 캘린더 연결 확인 필요\(google-oauth-setup\)/);
  assert.match(sent[0].body, /오늘: 민\(36살\)/);
  assert.deepEqual(birthdayLines('2026-10-10', [{ name: '빈값', birthday: '' }]), []);
});

test('일정 조회 권한 실패여도 저녁 연결 경고를 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'evening', date: '2026-10-11', deps: { fetchEvents: async () => { throw new Error('권한 범위 부족'); }, send: async (message) => sent.push(message) } });
  assert.equal(result.alert, true);
  assert.match(sent[0].body, /- 캘린더 연결 확인 필요\(google-oauth-setup\)/);
});

test('브리핑 CLI는 일정 권한 실패 경보를 종료 코드 1로 표시한다', async () => {
  const original = process.exitCode;
  try {
    process.exitCode = 0;
    await main(['--mode=morning', '--date=2026-10-10'], { fetchEvents: async () => { throw new Error('권한 범위 부족'); }, readPeople: async () => [], send: async () => {} });
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = original; }
});

test('생일 파일 읽기 실패를 표시해 일정 브리핑은 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: {
    fetchEvents: async () => [ev], readOwners: async () => { throw new Error('unavailable'); }, readPeople: async () => { throw new Error('vault unavailable'); }, send: async (message) => sent.push(message),
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

test('소유자별 아침·저녁 일정, 빈 아침과 대응표 실패 폴백', async () => {
  const sent = [];
  const deps = {
    fetchEvents: async () => [
      { ...ev, calendarId: 'b@example.com', iCalUID: 'shared' },
      { ...ev, calendarId: 'a@example.com', iCalUID: 'shared' },
      { ...ev, calendarId: 'c@example.com', iCalUID: 'mine', title: '미네 일정' },
    ],
    readOwners: async () => [
      { calendarId: 'a@example.com', owner: '나' },
      { calendarId: 'b@example.com', owner: '휘영' },
      { calendarId: 'c@example.com', owner: '미네' },
    ],
    readPeople: async () => [],
    send: async (message) => sent.push(message),
  };
  const morning = await runBriefing({ mode: 'morning', date: '2026-10-10', deps });
  assert.match(morning.body, /■ 나 — 오늘 일정\n- 10:00–11:00 &lt;치과&gt; \(A&amp;B\) \(나·휘영 함께\)/);
  assert.doesNotMatch(morning.body, /■ 휘영 — 오늘 일정/);
  assert.match(morning.body, /■ 미네 — 오늘 일정/);
  const evening = await runBriefing({ mode: 'evening', date: '2026-10-11', deps });
  assert.match(evening.body, /■ 나 — 내일 일정/);
  const empty = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { ...deps, fetchEvents: async () => [] } });
  assert.match(empty.body, /■ 오늘 일정\n- 일정 없음/);
  const fallback = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { ...deps, readOwners: async () => { throw new Error('unavailable'); } } });
  assert.match(fallback.body, /■ 오늘 일정\n- 10:00–11:00/);
  assert.equal(sent.length, 4);
});
