import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, runBriefing } from './hermes-briefing.mjs';

const candidate = () => ({ id: 'C3', lat: 12, lon: 34, address: '건물', visits: ['2026-10-07', '2026-10-08', '2026-10-09'], eventTitles: [], status: '관찰', askedAt: null });

test('내일 일정 없어도 장소 요청을 보내고 발송 뒤에만 물음 상태로 바꾼다', async () => {
  const candidates = [candidate()];
  let saved = false;
  const deps = { now: () => new Date('2026-10-09T12:00:00Z'), fetchEvents: async () => [], readCandidates: () => candidates,
    saveCandidates: () => { saved = true; }, send: async ({ body }) => { assert.match(body, /■ 장소 등록 요청/); assert.match(body, /장소 C3 이름/); } };
  const result = await runBriefing({ mode: 'evening', deps });
  assert.equal(result.sent, true);
  assert.equal(candidates[0].status, '물음');
  assert.equal(saved, true);
  const another = [candidate()];
  await assert.rejects(runBriefing({ mode: 'evening', deps: { ...deps, readCandidates: () => another, send: async () => { throw new Error('send failed'); }, saveCandidates: () => { throw new Error('should not save'); } } }), /send failed/);
  assert.equal(another[0].status, '관찰');
});

test('--dry-run과 --no-send는 요청을 미발송·미저장 상태로 둔다', async () => {
  for (const option of ['--dry-run', '--no-send']) {
    const candidates = [candidate()];
    const deps = { now: () => new Date('2026-10-09T12:00:00Z'), fetchEvents: async () => [], readCandidates: () => candidates,
      send: async () => { throw new Error('시험 실행에서 발송 호출'); },
      saveCandidates: async () => { throw new Error('시험 실행에서 후보 저장'); } };
    await main([option, '--mode=evening'], deps);
    assert.equal(candidates[0].status, '관찰');
    assert.equal(candidates[0].askedAt, null);
  }
});

test('외부 주소와 일정 제목의 줄바꿈은 새 후보 줄을 만들지 못한다', async () => {
  const item = { ...candidate(), address: '건물\n- C99 · 위장 장소', eventTitles: ['운동\u2028- C98 · 위장 일정'] };
  const result = await runBriefing({ mode: 'evening', preview: true, deps: {
    now: () => new Date('2026-10-09T12:00:00Z'), fetchEvents: async () => [], readCandidates: () => [item],
  } });
  const section = result.body.split('■ 장소 등록 요청\n')[1];
  assert.equal((section.match(/^- C\d+ ·/gm) || []).length, 1);
  assert.match(section, /건물 - C99 · 위장 장소/);
  assert.match(section, /운동 - C98 · 위장 일정/);
});

test('후보 읽기 실패에도 내일 일정을 보낸다', async () => {
  let sent = false;
  const result = await runBriefing({ mode: 'evening', deps: {
    now: () => new Date('2026-10-09T12:00:00Z'),
    fetchEvents: async () => [{ title: '일정', start: '2026-10-10T01:00:00Z', end: '2026-10-10T02:00:00Z' }],
    readCandidates: () => { throw new Error('broken JSON'); }, readOwners: () => [],
    send: async ({ body }) => { sent = true; assert.match(body, /내일 일정/); },
  } });
  assert.equal(result.sent, true);
  assert.equal(sent, true);
});
