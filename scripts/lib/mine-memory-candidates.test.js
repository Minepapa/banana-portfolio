import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATE_LIMIT, hasOrb, rankCandidates, scoreMoment } from './mine-memory-candidates.mjs';

function moment(id, date, overrides = {}) {
  return { id, date, title: '평범한 하루', album: '', calendar: '', fields: {}, memo: '', photoMemo: '',
    mineVideoNames: [], mediaCount: 1, ...overrides };
}

test('사건 이름·오너 메모·사진 메모·미네 영상·녹음 연결은 근거와 점수를 남긴다', () => {
  const item = moment('a', '2020-01-02', { title: '첫 생일', album: '여행', calendar: '공연',
    memo: '웃으며 케이크를 불었다', photoMemo: '[[사진 이야기]]', mineVideoNames: ['clip.mp4'] });
  const result = scoreMoment(item, { busyDates: new Set(['2020-01-02']),
    relatedDates: new Map([['2020-01-02', ['미네 통화.md']]]) });
  assert.deepEqual(result.reasons.map((reason) => reason.signal), [
    '제목', '앨범', '캘린더 일정', '오너 메모', '사진 메모', '그 해 사진·영상 많은 날',
    '미네 이름표 영상', '같은 날 녹음·통화·노트',
  ]);
  assert.equal(result.score, result.reasons.reduce((sum, reason) => sum + reason.weight, 0));
  assert.equal(hasOrb({ emotionEvidence: '기쁨' }), true);
  assert.equal(hasOrb({}), false);
});

test('연도별 상위 10% 날짜를 더하고 점수·매체수·날짜 순으로 목표 규모까지만 고른다', () => {
  const items = Array.from({ length: CANDIDATE_LIMIT + 100 }, (_, index) => moment(String(index).padStart(3, '0'),
    `2020-${String(1 + Math.floor(index / 28)).padStart(2, '0')}-${String(1 + index % 28).padStart(2, '0')}`,
    { title: '생일', mediaCount: index === 0 ? 20 : 1 }));
  const ranked = rankCandidates(items);
  assert.equal(ranked.length, CANDIDATE_LIMIT);
  assert.equal(ranked[0].id, '000');
  assert.ok(ranked[0].reasons.some((reason) => reason.signal === '그 해 사진·영상 많은 날'));
  assert.deepEqual(rankCandidates([moment('b', '2020-01-01'), moment('a', '2020-01-01')])
    .map((item) => item.id), ['a', 'b']);
});
