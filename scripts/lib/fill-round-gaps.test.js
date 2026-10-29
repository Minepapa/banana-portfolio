import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFillRoundGaps, fillRoundGapMessage, FILL_ROUND_SETTLE_MS } from './fill-round-gaps.mjs';
import { renderAgentMessage } from './pantheon-send.mjs';
import { parseExecution } from './notification-parsers.mjs';
import { buildExecutionRecord } from './ledger-vault-writer.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

const RECORDED = '2026-10-27T04:48:39.000Z';
const AFTER = Date.parse(RECORDED) + FILL_ROUND_SETTLE_MS + 1;
// 2026-10-27 13:40 실사고 — 아르고스가 받은 12건(차수:수량, 도착 순서). 6차 2주·13차 1주 알림이 오지 않았다.
const RECEIVED = [[5, 2], [9, 2], [2, 1], [3, 1], [8, 3], [10, 3], [14, 9], [7, 1], [11, 2], [1, 1], [12, 1], [4, 1]];
const execution = ([fillRound, quantity], i) => ({
  tradeDate: `2026-10-27 13:40:${String(27 + i).padStart(2, '0')}`, tradeType: '매도', stockName: 'TIGER 미국배당다우존스',
  quantity, price: 14825, broker: '삼성증권', account: '연금저축', source: 'KAKAO', fillRound, recordedAt: RECORDED,
  filepath: `/x/${i}.md`,
});

test('[실사고] 10-27 분할체결에서 빠진 6차·13차를 찾는다(순서가 뒤섞여 도착해도)', () => {
  const [gap] = findFillRoundGaps(RECEIVED.map(execution), { now: AFTER });
  assert.deepEqual(gap.missing, [6, 13]);
  assert.equal(gap.maxRound, 14);
  assert.equal(gap.receivedQuantity, 27);
  assert.equal(gap.anchor.fillRound, 14);
  assert.equal(gap.notified, false);
});

test('아직 알림이 오는 중일 수 있는 최근 묶음은 기다린다', () => {
  assert.deepEqual(findFillRoundGaps(RECEIVED.map(execution), { now: Date.parse(RECORDED) + 1000 }), []);
});

test('빈칸이 없거나 차수가 없는 기록은 묻지 않는다', () => {
  const full = [1, 2, 3].map((n, i) => execution([n, 1], i));
  assert.deepEqual(findFillRoundGaps(full, { now: AFTER }), []);
  assert.deepEqual(findFillRoundGaps(RECEIVED.map(execution).map(({ fillRound, ...rest }) => rest), { now: AFTER }), []);
});

test('같은 빈칸은 다시 묻지 않고, 빈칸 목록이 바뀌면 다시 묻는다', () => {
  const records = RECEIVED.map(execution);
  records[6] = { ...records[6], fillRoundGapNotified: '6,13' };
  assert.equal(findFillRoundGaps(records, { now: AFTER })[0].notified, true);
  const filled = [...records, execution([6, 2], 20)];
  const [gap] = findFillRoundGaps(filled, { now: AFTER });
  assert.deepEqual(gap.missing, [13]);
  assert.equal(gap.notified, false);
});

test('종목·계좌·구분·날짜가 다르면 따로 묶는다', () => {
  const other = { ...execution([3, 1], 0), stockName: '다른 종목' };
  const gaps = findFillRoundGaps([execution([1, 1], 0), other], { now: AFTER });
  assert.deepEqual(gaps.map((g) => [g.stockName, g.missing]), [['다른 종목', [1, 2]]]);
});

test('같은 차수가 다른 이벤트로 두 번 오면 묻고, 같은 이벤트의 중복 파일은 한 번만 센다', () => {
  const records = RECEIVED.map((r, i) => ({ ...execution(r, i), sourceEventId: `e${i}` }));
  const all = [...records, { ...execution([6, 2], 30), sourceEventId: 'e30' }, { ...execution([13, 1], 31), sourceEventId: 'e31' },
    { ...execution([4, 1], 32), sourceEventId: 'dup-4' }];
  const [gap] = findFillRoundGaps(all, { now: AFTER });
  assert.deepEqual(gap.missing, []);
  assert.deepEqual(gap.duplicated, [4]);
  assert.equal(gap.missingKey, '|dup:4');
  assert.match(renderAgentMessage(fillRoundGapMessage(gap)), /두 번 들어온 차수: 4차/);
  // 같은 sourceEventId가 파일 두 개로 남은 경우(재전송)는 중복 차수가 아니다.
  const refiled = [...records, { ...records[11], filepath: '/x/again.md' }];
  const [only] = findFillRoundGaps(refiled, { now: AFTER });
  assert.deepEqual(only.duplicated, []);
  assert.equal(only.receivedQuantity, 27);
});

test('알림 메시지는 판단 4단 구조로 렌더되고 스크립트 문구(가는 선)다', () => {
  const [gap] = findFillRoundGaps(RECEIVED.map(execution), { now: AFTER });
  const text = renderAgentMessage(fillRoundGapMessage(gap));
  assert.match(text, /6차·13차/);
  assert.match(text, /연금저축/);
  assert.ok(!text.includes('━'));
});

test('삼성증권 체결 알림에서 차수를 읽어 원장에 남기고, 파일명·dedupKey는 그대로다', () => {
  const body = '[삼성증권]<주식체결안내>\n71612*****-15\nTIGER 미국배당다우존스\n매도2주 14,825원\n체결(5차)';
  const e = parseExecution(body, '2026-10-27 13:40:27');
  assert.equal(e.fillRound, 5);
  const withRound = buildExecutionRecord({ ...e, account: '연금저축' });
  const { fillRound, ...noRound } = e;
  const without = buildExecutionRecord({ ...noRound, account: '연금저축' });
  assert.equal(parseFrontmatter(withRound.content).fillRound, 5);
  assert.equal(withRound.filename, without.filename);
  assert.equal(withRound.dedupKey, without.dedupKey);
  assert.equal(parseExecution(body.replace('\n체결(5차)', ''), '2026-10-27 13:40:27').fillRound, undefined);
});
