import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';
import { ORB_DAYS, ambiguousPending, buildOrbDaily, orbOf } from './mine-orb-daily.mjs';

const mine = '["[[01_Home/201 미네]]"]';
const fm = (extra, category = mine) => `---\ncategory: ${category}\n${extra}\n---\n본문\n`;

test('orbOf: 미네 노트이고 감정 필드가 있어야 구슬, 감정 칸은 대표 감정 → 모름 → 감정 없음', () => {
  const base = { category: ['[[01_Home/201 미네]]'], occurred: '2026-10-30T23:30:00+09:00' };
  assert.deepEqual(orbOf({ ...base, emotions: ['기쁨'], primaryEmotion: '기쁨', coreMemoryCandidate: true }),
    { date: '2026-10-30', emotion: '기쁨', candidate: true, core: false, owner: false });
  assert.equal(orbOf({ ...base, emotions: [], primaryEmotion: null, emotionEvidence: '모름: 오너 판단(검수 시트)' }).emotion, '모름');
  assert.equal(orbOf({ ...base, emotions: [], primaryEmotion: null, emotionEvidence: '모름: 오너 판단(검수 시트)' }).owner, true);
  assert.equal(orbOf({ ...base, emotions: [], primaryEmotion: null }).emotion, '감정 없음');
  assert.equal(orbOf({ ...base }), null, '감정 필드 없음 = 아직 판단 전');
  assert.equal(orbOf({ ...base, category: ['[[01_Home/202 휘영]]'], emotions: [] }), null);
  assert.equal(orbOf({ ...base, occurred: '', emotions: [] }), null);
});

test('ambiguousPending: 검수 시트와 같은 정의 — 오너 줄·지금 Claude 판 줄만, 마지막이 두 답 있는 애매함', () => {
  const claude = (rel, status, extra = {}) => ({ rel, status, engine: 'claude', promptVersion: 'athena-fields/1.0', ...(status === 'ambiguous' ? { answers: [{}, {}] } : {}), ...extra });
  const rows = [claude('a', 'ambiguous'), claude('b', 'ambiguous'), { rel: 'b', engine: 'owner', status: 'applied' },
    claude('c', 'ambiguous'), claude('d', 'applied'), claude('e', 'ambiguous', { promptVersion: 'athena-fields/0.9' }),
    claude('f', 'ambiguous'), claude('f', 'retry', { promptVersion: 'athena-fields/2.0' }), { rel: 'g', engine: 'claude', promptVersion: 'athena-fields/1.0', status: 'ambiguous' }];
  assert.equal(ambiguousPending(rows), 3, 'a·c·f(다른 판의 retry는 무시), e는 옛 판, g는 두 답 없음');
  assert.equal(ambiguousPending(rows, new Set(['c'])), 2);
});

test('buildOrbDaily: 통화·순간 노트를 occurred 날짜로 30일 묶고, 숫자만 담는다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orb-daily-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); };
  put(`${VAULT_REL.mediaConversations}/2026/a.md`, fm('occurred: "2026-10-30T19:00:00+09:00"\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"'));
  put(`${VAULT_REL.mediaConversations}/2026/b.md`, fm('occurred: "2026-10-30T20:00:00+09:00"\nemotions: []\nprimaryEmotion: null\nemotionEvidence: "오너 판단(검수 시트)"'));
  put(`${VAULT_REL.mediaConversations}/2026/c.md`, fm('occurred: "2026-10-29T20:00:00+09:00"'));
  put(`${VAULT_REL.mediaConversations}/2020/old.md`, fm('occurred: "2020-01-01T09:00:00+09:00"\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"\ncoreMemory: true'));
  put(`${VAULT_REL.mediaMoments}/2026/m.md`, fm('occurred: "2026-10-31T09:00:00+09:00"\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"\ncoreMemoryCandidate: true'));
  const judgmentsPath = join(root, 'j.jsonl');
  const row = (rel) => JSON.stringify({ rel, status: 'ambiguous', engine: 'claude', promptVersion: 'athena-fields/1.0', answers: [{}, {}] });
  writeFileSync(judgmentsPath, `${row(`${VAULT_REL.mediaConversations}/2026/b.md`)}\n${row('x.md')}\n{"rel":"cut`);
  const feed = buildOrbDaily(root, { now: new Date('2026-10-31T03:00:00Z'), judgmentsPath });
  assert.equal(feed.schemaVersion, 1);
  assert.deepEqual([feed.totals.orbs, feed.totals.coreCandidates, feed.totals.coreMemories, feed.totals.ambiguousPending], [4, 1, 1, 1],
    '후보·확정 핵심 기억은 따로, 오너가 정한 b는 애매함 대기에서 빠짐');
  assert.equal(buildOrbDaily(`${root}/`, { now: new Date('2026-10-31T03:00:00Z'), judgmentsPath }).totals.ambiguousPending, 1, '끝 슬래시 root도 같은 경로');
  assert.deepEqual([feed.totals.byEmotion.기쁨, feed.totals.byEmotion.슬픔, feed.totals.byEmotion['감정 없음']], [2, 1, 1]);
  assert.equal(feed.days.length, ORB_DAYS);
  assert.deepEqual([feed.days[0].date, feed.days.at(-1).date], ['2026-10-02', '2026-10-31']);
  const day30 = feed.days.find((day) => day.date === '2026-10-30');
  assert.deepEqual([day30.orbs, day30.byEmotion.슬픔, day30.byEmotion['감정 없음']], [2, 1, 1]);
  assert.deepEqual([feed.days.at(-1).orbs, feed.days.at(-1).coreCandidates, feed.days.at(-1).coreMemories], [1, 1, 0]);
  assert.doesNotMatch(JSON.stringify(feed), /\.md|20_Records|본문/, '경로·파일 이름·본문은 넣지 않는다');
  assert.equal(buildOrbDaily(root, { now: new Date('2026-10-31T03:00:00Z'), judgmentsPath: join(root, 'none.jsonl') }).totals.ambiguousPending, 0);
});
