import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildWikiCandidates, sourceMeta } from './wiki-candidates.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

const page = '30_Wiki/34_Topics/현금 흐름';
const item = (source, hash, meta, target = page) => ({ source, hash, status: '계획함', sourceMeta: meta,
  judgment: { wiki: [{ action: 'candidate', page: target, reason: '반복해서 언급됨' }] } });
const meta = (date, kind = 'note', ownerDirect = false) => ({ occurredAt: date, dateBasis: 'occurred',
  observedAt: '2026-10-16', kind, ownerDirect });
const plans = (...items) => [{ date: '2026-10-16', items }];

test('same plan rerun and same source hash do not inflate evidence', () => {
  const a = item('00_Inbox/a.md', 'hash-a', meta('2026-09-01'));
  const result = buildWikiCandidates([...plans(a, a), ...plans(a)]).candidates[0];
  assert.equal(result.sources.length, 1);
  assert.equal(result.counts.notes, 1);
  assert.equal(result.status, 'collecting');
});

test('distinct sources and trusted dates satisfy quantitative gates; observation dates do not', () => {
  const records = [
    item('00_Inbox/a.md', 'a', meta('2026-09-01', 'note', true)),
    item('00_Inbox/b.md', 'b', meta('2026-09-10', 'conversation')),
    item('00_Inbox/c.md', 'c', meta('2026-09-16', 'note')),
  ];
  const result = buildWikiCandidates(plans(...records)).candidates[0];
  assert.deepEqual(result.gates, { threeNotes: true, fourteenDays: true, kindsOrOwner: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.review, 'clio-pending');
  assert.equal(result.counts.spanDays, 15);
  const repeated = buildWikiCandidates(plans(...records, item('00_Inbox/a.md', 'new-hash', meta('2026-10-01')))).candidates[0];
  assert.equal(repeated.counts.notes, 3, '같은 노트의 새 해시는 새 입력 노트가 아니다');
});

test('unknown source date keeps observed date separately and cannot satisfy fourteen days', () => {
  const unknown = sourceMeta('---\norigin: "외부"\n---\n원문', '2026-10-16', parseFrontmatter);
  assert.equal(unknown.occurredAt, null);
  assert.equal(unknown.observedAt, '2026-10-16');
  const records = [item('00_Inbox/a.md', 'a', unknown), item('00_Inbox/b.md', 'b', { ...unknown, observedAt: '2026-11-01' }),
    item('00_Inbox/c.md', 'c', { ...unknown, observedAt: '2026-11-30' })];
  const result = buildWikiCandidates(plans(...records)).candidates[0];
  assert.equal(result.gates.fourteenDays, false);
  assert.deepEqual(result.dates.observed, ['2026-10-16', '2026-11-01', '2026-11-30']);
  assert.equal(result.dates.firstMention, null);
  assert.equal(sourceMeta('---\ncreated: "2026-09-02"\n---\n', '2026-10-16', parseFrontmatter).dateBasis, 'created');
  assert.equal(sourceMeta('---\norigin: "텔레그램 전달"\n---\n', '2026-10-16', parseFrontmatter).ownerDirect, false);
  assert.equal(sourceMeta('---\ntype: "conversation"\norigin: "수집"\n---\n', '2026-10-16', parseFrontmatter).kind, 'unknown');
  assert.equal(sourceMeta('---\norigin: "수집"\n---\n', '2026-10-16', parseFrontmatter, 'literature').kind, 'unknown');
});

test('source metadata accepts only exact dates and explicit origin and author markers', () => {
  const parse = (frontmatter) => sourceMeta(`---\n${frontmatter}\n---\n본문`, '2026-10-16', parseFrontmatter);
  assert.deepEqual([parse('occurred: "2026-09-01 (추정)"').occurredAt,
    parse('created: "2026-09-01T12:00:00Z"').occurredAt,
    parse('occurred: "2026-02-30"').occurredAt], [null, null, null]);
  assert.equal(parse('occurred: "2026-09-01"').occurredAt, '2026-09-01');
  assert.equal(parse('origin: "옵시디언"').ownerDirect, false);
  assert.equal(parse('origin: "옵시디언 오너 직접 추정"').ownerDirect, false);
  assert.equal(parse('origin: "오너 직접"').ownerDirect, false);
  assert.equal(parse('origin: "옵시디언"').kind, 'note');
  assert.equal(parse('type: "note"').kind, 'unknown');
  assert.equal(parse('origin: "텔레그램 📜"').ownerDirect, false);
  assert.equal(parse('origin: "텔레그램 📜"\nauthor: "오너"').ownerDirect, true);
  assert.equal(parse('origin: "텔레그램 📜"\nauthor: "미네"').ownerDirect, false);
  assert.equal(parse('origin: "옵시디언"\nowner: true').ownerDirect, true);
});

test('explicit origins provide distinct input kinds for the D32 gate without owner inference', () => {
  const parse = (frontmatter) => sourceMeta(`---\ntype: inbox\n${frontmatter}\n---\n본문`,
    '2026-10-16', parseFrontmatter);
  const examples = [
    ['origin: "텔레그램 📜"\nauthor: "오너"', 'note', true],
    ['origin: "텔레그램 📜"\nauthor: "미네"', 'note', false],
    ['origin: "옵시디언"', 'note', false],
    ['origin: "media:audio/123"', 'media', false],
    ['origin: "웹클리퍼 기사"', 'literature', false],
    ['origin: "통화 기록"', 'conversation', false],
    ['origin: "외부 수집"', 'unknown', false],
  ];
  for (const [frontmatter, kind, ownerDirect] of examples) {
    assert.equal(parse(frontmatter).kind, kind, frontmatter);
    assert.equal(parse(frontmatter).ownerDirect, ownerDirect, frontmatter);
  }
  const candidate = buildWikiCandidates(plans(
    item('00_Inbox/a.md', 'a', { ...parse('origin: "텔레그램 📜"\nauthor: "미네"'), occurredAt: '2026-09-01' }),
    item('00_Inbox/b.md', 'b', { ...parse('origin: "media:audio/123"'), occurredAt: '2026-09-10' }),
    item('00_Inbox/c.md', 'c', { ...parse('origin: "옵시디언"'), occurredAt: '2026-09-16' }),
  )).candidates[0];
  assert.equal(candidate.counts.ownerDirect, 0);
  assert.equal(candidate.counts.kinds, 2);
  assert.equal(candidate.gates.kindsOrOwner, true);
  assert.equal(candidate.status, 'ready');
});

test('existing Wiki path or alias returns existing; ambiguous alias and similar title hold', () => {
  const catalog = [{ path: '30_Wiki/34_Topics/현금흐름', aliases: ['현금 흐름'] }];
  assert.equal(buildWikiCandidates(plans(item('00_Inbox/a.md', 'a', meta('2026-09-01'))), catalog)
    .candidates[0].status, 'existing');
  const ambiguous = [...catalog, { path: '30_Wiki/34_Topics/캐시플로우', aliases: ['현금 흐름'] }];
  assert.equal(buildWikiCandidates(plans(item('00_Inbox/a.md', 'a', meta('2026-09-01'))), ambiguous)
    .candidates[0].status, 'hold');
  const similar = [{ path: '30_Wiki/34_Topics/현금흐름', aliases: [] }];
  assert.equal(buildWikiCandidates(plans(item('00_Inbox/a.md', 'a', meta('2026-09-01'))), similar)
    .candidates[0].status, 'hold');
  const typo = [{ path: '30_Wiki/34_Topics/현금 흐룸', aliases: [] }];
  assert.equal(buildWikiCandidates(plans(item('00_Inbox/a.md', 'a', meta('2026-09-01'))), typo)
    .candidates[0].status, 'hold');
  const otherFolder = [{ path: '30_Wiki/33_Objects/현금 흐름', aliases: [] }];
  const cross = buildWikiCandidates(plans(item('00_Inbox/a.md', 'a', meta('2026-09-01'))), otherFolder).candidates[0];
  assert.equal(cross.status, 'hold');
  assert.deepEqual(cross.existingPages, []);
});

test('similar Wiki titles in another folder hold, including ambiguous exact and alias matches', () => {
  const entry = item('00_Inbox/a.md', 'a', meta('2026-09-01'));
  const catalog = [
    { path: page, aliases: [] },
    { path: '30_Wiki/34_Topics/별칭 페이지', aliases: ['현금 흐름'] },
    { path: '30_Wiki/33_Objects/현금 흐룸', aliases: [] },
  ];
  const candidate = buildWikiCandidates(plans(entry), catalog).candidates[0];
  assert.deepEqual(candidate.existingPages, ['30_Wiki/34_Topics/별칭 페이지', page]);
  assert.ok(candidate.conflicts.includes('30_Wiki/33_Objects/현금 흐룸'));
  assert.equal(candidate.status, 'hold');
});

test('large disjoint candidate set is matched without all-pairs title comparison', { timeout: 10_000 }, () => {
  const records = Array.from({ length: 1800 }, (_, index) => item(`00_Inbox/${index}.md`, `hash-${index}`,
    meta('2026-09-01'), `30_Wiki/34_Topics/주제${createHash('sha256').update(String(index)).digest('hex').slice(0, 16)}`));
  const start = performance.now();
  const result = buildWikiCandidates(plans(...records));
  assert.equal(result.candidates.length, records.length);
  assert.ok(result.candidates.every((candidate) => candidate.conflicts.length === 0));
  assert.ok(performance.now() - start < 3000, '희소한 제목 집합의 후보 충돌 계산이 과도하게 느리다');
});

test('same person name with different reasons stays on identity review', () => {
  const first = item('00_Inbox/a.md', 'a', meta('2026-09-01'), '30_Wiki/31_People/김민수');
  const second = item('00_Inbox/b.md', 'b', meta('2026-09-16'), '30_Wiki/31_People/김민수');
  const candidate = buildWikiCandidates(plans(first, second)).candidates[0];
  assert.equal(candidate.status, 'hold');
  assert.ok(candidate.conflicts.includes('identity-review'));
});

test('D32 immediate exception is shown only as a review hint', () => {
  const family = item('00_Inbox/a.md', 'a', meta('2026-09-01'), '30_Wiki/31_People/김민수');
  family.judgment.wiki[0].reason = '가족 구성원';
  const candidate = buildWikiCandidates(plans(family)).candidates[0];
  assert.deepEqual(candidate.immediateExceptions, ['family']);
  assert.equal(candidate.immediateExceptionReview, 'clio-pending');
  assert.equal(candidate.status, 'collecting');
  assert.equal(candidate.review, 'clio-pending');
  const asset = item('00_Inbox/b.md', 'b', meta('2026-09-01'), '30_Wiki/34_Topics/리츠');
  assert.deepEqual(buildWikiCandidates(plans(asset)).candidates[0].immediateExceptions, ['asset-class-possible']);
});

test('same normalized candidate key merges spelling, different paths with same name are held', () => {
  const result = buildWikiCandidates(plans(
    item('00_Inbox/a.md', 'a', meta('2026-09-01'), page),
    item('00_Inbox/b.md', 'b', meta('2026-09-02'), '30_Wiki/34_Topics/현금   흐름'),
    item('00_Inbox/c.md', 'c', meta('2026-09-03'), '30_Wiki/33_Objects/현금 흐름')));
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.status === 'hold'));
  assert.equal(result.candidates.find((candidate) => candidate.key.startsWith('30_Wiki/34_Topics/')).counts.notes, 2);
});
