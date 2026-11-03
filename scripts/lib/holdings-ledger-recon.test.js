// 보유↔원장 재생 대조 순수 판정 테스트 — 가상 종목·가상 수량만 쓴다(공개 저장소).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  replayHoldings, diffHoldings, findExecutionDuplicates, classifyExecutionFilename, planAnchors, buildAnchorSummaryMessage,
  fundPurchaseAsExecution, selectAlertIssues, hasAlertIssues, alertSignature, buildReconMessage,
  buildQuantityTable, qtyEqual, collectActualHoldings,
} from './holdings-ledger-recon.mjs';
import { renderAgentMessage } from './pantheon-send.mjs';

const exec = (over = {}) => ({
  account: 'ISA', stockName: '가상ETF', tradeDate: '2026-09-01 10:00:00', tradeType: '매수',
  quantity: 10, price: 1000, holdingsApplied: true, dedupKey: `k-${Math.random()}`,
  filename: `f-${Math.random()}.md`, recordedAt: '2026-09-01T01:00:00.000Z', ...over,
});
const holding = (over = {}) => ({ account: 'ISA', name: '가상ETF', qty: 0, isCashLike: false, ...over });
const rowOf = (rows, key) => rows.find((row) => row.key === key);

test('기준점 + 반영 체결 합계 = 보유면 ok, 다르면 mismatch(수량만 본다)', () => {
  const executions = [exec({ quantity: 10 }), exec({ tradeType: '매도', quantity: 4, tradeDate: '2026-09-02 10:00:00' })];
  const okRows = diffHoldings(replayHoldings(executions, { 'ISA|가상ETF': 5 }, { holdings: [holding({ qty: 11, evalAmount: 999 })] }));
  assert.equal(rowOf(okRows, 'ISA|가상ETF').status, 'ok');
  const badRows = diffHoldings(replayHoldings(executions, { 'ISA|가상ETF': 5 }, { holdings: [holding({ qty: 14 })] }));
  const bad = rowOf(badRows, 'ISA|가상ETF');
  assert.equal(bad.status, 'mismatch');
  assert.equal(bad.expected, 11);
  assert.equal(bad.actual, 14);
  assert.equal(bad.diff, 3);
});

test('기준점이 없으면 암묵 기초(보유 − 체결 합)로 판정: 음수면 매도 초과, 0이 아니면 새 기준점 후보', () => {
  const sells = [exec({ tradeType: '매도', quantity: 7 })];
  const negative = diffHoldings(replayHoldings(sells, {}, { holdings: [holding({ qty: 0 })] }));
  // 보유 0 − (−7) = 7 → 원장 이전에 7주가 있었다는 뜻(정상 후보)
  assert.equal(rowOf(negative, 'ISA|가상ETF').status, 'new-anchor');
  assert.equal(rowOf(negative, 'ISA|가상ETF').impliedOpening, 7);
  const buys = [exec({ quantity: 7 })];
  const tooLow = diffHoldings(replayHoldings(buys, {}, { holdings: [holding({ qty: 3 })] }));
  assert.equal(rowOf(tooLow, 'ISA|가상ETF').status, 'negative-opening');
  const exact = diffHoldings(replayHoldings(buys, {}, { holdings: [holding({ qty: 7 })] }));
  assert.equal(rowOf(exact, 'ISA|가상ETF').status, 'ok');
});

test('하루 끝 잔고가 이력 중 음수면 negative-history(매수 누락·날짜 뒤바뀜 신호)', () => {
  const executions = [
    exec({ tradeType: '매도', quantity: 5, tradeDate: '2026-09-01 10:00:00' }),
    exec({ quantity: 5, tradeDate: '2026-09-03 10:00:00' }),
  ];
  const rows = diffHoldings(replayHoldings(executions, { 'ISA|가상ETF': 0 }, { holdings: [] }));
  assert.equal(rowOf(rows, 'ISA|가상ETF').status, 'negative-history');
  assert.equal(rowOf(rows, 'ISA|가상ETF').minRunning, -5);
});

test('같은 날 안의 매수·매도 순서는 보지 않는다(NH API 행은 시각이 00:00:00)', () => {
  const executions = [
    exec({ tradeType: '매도', quantity: 5, tradeDate: '2026-09-01 00:00:00' }),
    exec({ quantity: 5, tradeDate: '2026-09-01 13:00:00' }),
  ];
  const rows = diffHoldings(replayHoldings(executions, { 'ISA|가상ETF': 0 }, { holdings: [] }));
  assert.equal(rowOf(rows, 'ISA|가상ETF').status, 'ok');
});

test('반영 대상 규칙: legacy·duplicateOf·duplicate-skipped 제외, 적용 키가 증명한 재시도는 포함, 미반영은 따로', () => {
  const retry = exec({ dedupKey: 'retry-key', holdingsApplied: 'duplicate-skipped', quantity: 2 });
  const executions = [
    exec({ quantity: 10 }),
    exec({ quantity: 10, legacy: true }),
    exec({ quantity: 10, duplicateOf: 'other' }),
    exec({ quantity: 10, holdingsApplied: 'duplicate-skipped' }),
    retry,
    exec({ quantity: 3, holdingsApplied: false, recordedAt: '2026-09-01T00:00:00.000Z' }),
  ];
  const replay = replayHoldings(executions, {}, {
    holdings: [holding({ qty: 12, appliedDedupKeys: JSON.stringify(['retry-key']) })],
    now: Date.parse('2026-09-03T00:00:00.000Z'),
  });
  assert.equal(replay.rows.get('ISA|가상ETF').ledgerNet, 12);
  assert.equal(replay.pending.length, 1);
  assert.equal(replay.pending[0].stale, true);
  assert.equal(rowOf(diffHoldings(replay), 'ISA|가상ETF').status, 'ok');
});

test('퀀트 체결·현금성 보유는 대조하지 않는다', () => {
  const replay = replayHoldings([exec({ account: '퀀트', quantity: 3 })], {}, {
    holdings: [holding({ account: 'CMA', name: '예수금', qty: 100, isCashLike: true })],
  });
  assert.equal(replay.notInHoldings, 1);
  assert.deepEqual(diffHoldings(replay), []);
});

test('소수 수량(펀드 좌수)은 허용오차 안이면 일치, 펀드 매수는 매수 체결로 재생', () => {
  const purchase = fundPurchaseAsExecution({ filename: 'p.md', date: '2026-09-01', fundName: '가상펀드',
    units: 1234.5678, holdingsApplied: true, dedupKey: 'p1', recordedAt: '2026-09-01T00:00:00Z' });
  assert.equal(purchase.account, '연금저축');
  assert.equal(purchase.tradeType, '매수');
  const rows = diffHoldings(replayHoldings([purchase], { '연금저축|가상펀드': 100.1 }, {
    holdings: [{ account: '연금저축', name: '가상펀드', qty: 100.1 + 1234.5678 + 1e-7 }],
  }));
  assert.equal(rowOf(rows, '연금저축|가상펀드').status, 'ok');
  assert.ok(qtyEqual(1, 1.0005));
  assert.ok(!qtyEqual(1, 2));
});

test('같은 키 보유 파일이 여럿이면 수량을 합친다(로트 통합 전)', () => {
  const actual = collectActualHoldings([holding({ qty: 3 }), holding({ qty: 4 })]);
  assert.equal(actual.get('ISA|가상ETF').qty, 7);
});

test('중복: 같은 원천 ID·같은 dedupKey·같은 주문 같은 차수는 확정, 시각·수량·가격만 같은 건 의심', () => {
  const a = exec({ source: 'KAKAO', sourceEventId: 'ev1', filename: 'a.md' });
  const b = exec({ source: 'KAKAO', sourceEventId: 'ev1', filename: 'b.md' });
  const c = exec({ dedupKey: 'same', filename: 'c.md', tradeDate: '2026-09-05 10:00:00' });
  const d = exec({ dedupKey: 'same', filename: 'd.md', tradeDate: '2026-09-05 10:00:00' });
  const e = exec({ orderNo: 'o1', fillRound: 2, filename: 'e.md', tradeDate: '2026-09-06 10:00:01' });
  const f = exec({ orderNo: 'o1', fillRound: 2, filename: 'f.md', tradeDate: '2026-09-06 10:00:02' });
  const g = exec({ filename: 'g.md', tradeDate: '2026-09-07 11:00:00' });
  const h = exec({ filename: 'h.md', tradeDate: '2026-09-07 11:00:00' });
  const { confirmed, suspected } = findExecutionDuplicates([a, b, c, d, e, f, g, h]);
  assert.deepEqual(confirmed.map((dup) => dup.reason).sort(), ['같은 dedupKey', '같은 원천 ID', '같은 주문·같은 차수'].sort());
  assert.deepEqual(suspected.map((dup) => dup.records.map((r) => r.filename).sort()), [['g.md', 'h.md']]);
});

test('중복 의심 제외: 차수가 다르면 별개 분할 체결, 오너 확인 행은 별개, 이미 표시된 중복은 처리 끝', () => {
  const base = { tradeDate: '2026-09-08 10:00:00', quantity: 2 };
  const rounds = [exec({ ...base, fillRound: 1, filename: 'r1.md' }), exec({ ...base, fillRound: 2, filename: 'r2.md' })];
  const owner = [exec({ ...base, tradeDate: '2026-09-09 10:00:00', filename: 'o1.md' }),
    exec({ ...base, tradeDate: '2026-09-09 10:00:00', source: 'OWNER_CONFIRMED', filename: 'o2.md' })];
  const marked = [exec({ ...base, tradeDate: '2026-09-10 10:00:00', filename: 'm1.md' }),
    exec({ ...base, tradeDate: '2026-09-10 10:00:00', filename: 'm2.md', duplicateOf: 'm1' })];
  const { confirmed, suspected } = findExecutionDuplicates([...rounds, ...owner, ...marked]);
  assert.equal(confirmed.length, 0);
  assert.equal(suspected.length, 0);
});

test('파일명 규칙 4종 분류와 프론트매터 불일치', () => {
  const record = { tradeDate: '2026-09-01 10:00:00', tradeType: '매수', stockName: '가상 ETF', quantity: 5 };
  assert.equal(classifyExecutionFilename('2026-09-01-100000-매수-가상-ETF-5.md', record), 'quantity');
  assert.equal(classifyExecutionFilename('2026-09-01-100000-매수-가상-ETF-5-123-ev.md', record), 'quantity');
  assert.equal(classifyExecutionFilename('2026-09-01-100000-매수-가상-ETF.md', record), 'noQuantity');
  assert.equal(classifyExecutionFilename('2026-09-01-10_00_00-매수-가상-ETF-r12.md', record), 'v1Row');
  const utc = { ...record, tradeDate: '2026-09-01T01:00:00.123Z' };
  assert.equal(classifyExecutionFilename('2026-09-01-010000.123Z-매수-가상-ETF.md', utc), 'utcTime');
  // 수량을 고친 행의 파일명이 옛 수량이면 규칙 밖으로 보고한다.
  assert.equal(classifyExecutionFilename('2026-09-01-100000-매수-가상-ETF-6.md', record), 'unknown');
});

test('기준점 계획: 첫 실행은 이상 없는 종목만, 그 뒤 설명 안 되는 보유·중복 의심 종목은 잡지 않는다', () => {
  const rows = [
    { key: 'ISA|A', status: 'new-anchor', impliedOpening: 5 },
    { key: 'ISA|B', status: 'ok', impliedOpening: 0 },
    { key: 'ISA|C', status: 'negative-opening', impliedOpening: -2 },
    { key: 'ISA|H', status: 'new-anchor', impliedOpening: 3 },
    { key: 'IRP|X', status: 'external-mismatch', impliedOpening: -1 },
  ];
  const first = planAnchors({ rows, heldKeys: new Set(['ISA|H']), nowIso: 't' });
  assert.deepEqual(first.state.anchors, { 'ISA|A': 5, 'ISA|B': 0 });
  assert.deepEqual(first.held, ['ISA|H']);
  assert.deepEqual(first.seeded, ['ISA|A', 'ISA|B']);
  const later = planAnchors({ rows: [{ key: 'ISA|D', status: 'new-anchor', impliedOpening: 4 }, { key: 'ISA|E', status: 'ok', impliedOpening: 0 }],
    previous: first.state });
  assert.deepEqual(later.state.anchors, { 'ISA|A': 5, 'ISA|B': 0, 'ISA|E': 0 });
  assert.deepEqual(later.changes, [{ key: 'ISA|E', before: null, after: 0 }]);
});

test('기준점 재설정: 종목 단위는 보류 종목도 인정하고 이전 → 새를 남기며, 음수·없는 종목은 거부. 전 종목은 보류·음수 제외', () => {
  const previous = { anchors: { 'ISA|A': 5, 'ISA|B': 0 } };
  const rows = [
    { key: 'ISA|A', status: 'mismatch', impliedOpening: 7 },
    { key: 'ISA|B', status: 'ok', impliedOpening: 0 },
    { key: 'ISA|H', status: 'new-anchor', impliedOpening: 3 },
    { key: 'ISA|N', status: 'negative-opening', impliedOpening: -1 },
  ];
  const one = planAnchors({ rows, previous, heldKeys: new Set(['ISA|H']), rebaselineKeys: [' ISA | A ', 'ISA|H'] });
  // 키 앞뒤 공백은 정규화된다.
  assert.deepEqual(one.state.anchors, { 'ISA|A': 7, 'ISA|B': 0, 'ISA|H': 3 });
  assert.deepEqual(one.changes, [{ key: 'ISA|A', before: 5, after: 7 }, { key: 'ISA|H', before: null, after: 3 }]);
  const bad = planAnchors({ rows, previous, rebaselineKeys: ['ISA|N', 'ISA|없음'] });
  assert.deepEqual(bad.rejected.map((item) => item.key), ['ISA|N', 'ISA|없음']);
  const all = planAnchors({ rows, previous, heldKeys: new Set(['ISA|H']), rebaselineAll: true });
  assert.deepEqual(all.state.anchors, { 'ISA|A': 7, 'ISA|B': 0 });
  assert.deepEqual(all.held, ['ISA|H']);
});

test('키 정규화(trim·NFC)와 종목코드 묶기: 표기만 다른 체결은 같은 보유로, 코드가 없으면 이름으로', () => {
  const decomposed = '가상ETF'.normalize('NFD');
  const rows = diffHoldings(replayHoldings([
    exec({ stockName: ` ${decomposed} `, quantity: 2 }),
    exec({ stockName: '가상ETF(옛 표기)', stockCode: 'A123456', quantity: 3 }),
  ], { ' ISA |가상ETF': 0 }, { holdings: [holding({ qty: 5, ticker: '123456' })] }));
  assert.deepEqual(rows.map((row) => [row.key, row.status]), [['ISA|가상ETF', 'ok']]);
});

test('IRP는 미반영 체결도 원장 합에 넣고, 어긋나면 external-mismatch(원래 판정은 cause)', () => {
  const irp = { account: 'IRP', stockName: '가상TDF' };
  const replay = replayHoldings([exec({ ...irp, quantity: 4 }), exec({ ...irp, quantity: 1, holdingsApplied: false })],
    { 'IRP|가상TDF': 10 }, { holdings: [{ account: 'IRP', name: '가상TDF', qty: 15 }] });
  assert.equal(replay.pending.length, 0);
  assert.equal(rowOf(diffHoldings(replay), 'IRP|가상TDF').status, 'ok');
  const off = diffHoldings(replayHoldings([exec({ ...irp, quantity: 4 })], { 'IRP|가상TDF': 10 },
    { holdings: [{ account: 'IRP', name: '가상TDF', qty: 13 }] }));
  assert.equal(rowOf(off, 'IRP|가상TDF').status, 'external-mismatch');
  assert.equal(rowOf(off, 'IRP|가상TDF').cause, 'mismatch');
  const text = renderAgentMessage(buildReconMessage({ quantityIssues: [rowOf(off, 'IRP|가상TDF')], confirmedDuplicates: [], stalePending: [] }));
  assert.ok(text.includes('카카오 원장 ↔ KIS 잔고'));
});

test('현금성 보유의 계좌|종목 키는 원장 쪽에서도 뺀다', () => {
  const replay = replayHoldings([exec({ account: 'CMA', stockName: '가상RP', quantity: 9 })], {}, {
    holdings: [{ account: 'CMA', name: '가상RP', qty: 100, isCashLike: true }],
  });
  assert.equal(replay.cashLikeSkipped, 1);
  assert.deepEqual(diffHoldings(replay), []);
});

test('미반영 체결의 오래됨: recordedAt 없으면 tradeDate, 둘 다 없으면 오래된 것으로', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const replay = replayHoldings([
    exec({ holdingsApplied: false, recordedAt: undefined, tradeDate: '2026-09-09 20:00:00', filename: 'fresh.md' }),
    exec({ holdingsApplied: false, recordedAt: undefined, tradeDate: '2026-09-01 10:00:00', filename: 'old.md' }),
    exec({ holdingsApplied: false, recordedAt: undefined, tradeDate: undefined, filename: 'none.md' }),
  ], {}, { holdings: [], now });
  assert.deepEqual(replay.pending.map((record) => [record.filename, record.stale]), [['fresh.md', false], ['old.md', true], ['none.md', true]]);
});

test('표 이름 자르기는 서로게이트 쌍을 깨지 않는다', () => {
  const table = buildQuantityTable([{ account: 'ISA', name: `가상${'😀'.repeat(30)}`, expected: 1, actual: 2, diff: 1, status: 'mismatch' }]);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(table), '짝 없는 상위 서로게이트');
});

test('기준점 요약 메시지는 정보성·플루토스·항목별 한 줄', () => {
  const message = buildAnchorSummaryMessage({ seeded: ['ISA|A', 'ISA|B'], held: ['연금저축|가상&ETF'], heldReasons: { '연금저축|가상&ETF': '중복 의심' } });
  assert.equal(message.agent, 'plutus');
  assert.equal(message.kind, '정보');
  const text = renderAgentMessage(message);
  assert.ok(text.includes('잡은 종목 2개'));
  assert.ok(text.includes('- 연금저축 가상&amp;ETF: 중복 의심'));
});

test('알림 대상: 첫 실행의 새 기준점은 알리지 않고, 기준점이 있던 뒤엔 알린다. 서명은 같은 이상이면 같다', () => {
  const rows = [{ key: 'ISA|A', account: 'ISA', name: 'A', status: 'new-anchor', expected: 0, actual: 5, diff: 5 }];
  const empty = { confirmed: [], suspected: [] };
  assert.equal(hasAlertIssues(selectAlertIssues({ rows, duplicates: empty, pending: [], anchorsExisted: false })), false);
  const issues = selectAlertIssues({ rows, duplicates: empty, pending: [], anchorsExisted: true });
  assert.equal(hasAlertIssues(issues), true);
  assert.equal(alertSignature(issues), alertSignature(selectAlertIssues({ rows: [...rows], duplicates: empty, pending: [], anchorsExisted: true })));
  const suspectedOnly = selectAlertIssues({ rows: [], duplicates: { confirmed: [], suspected: [{ reason: 'x', records: [] }] }, pending: [], anchorsExisted: true });
  assert.equal(hasAlertIssues(suspectedOnly), false);
});

test('표: 숫자 칸이 앞·한글 이름이 끝, 폰 한 줄 44칸 안, 이름의 &는 이스케이프', () => {
  const table = buildQuantityTable([
    { account: '연금저축', name: '가상 S&P 아주아주긴이름의상장지수펀드', expected: 1200, actual: 1180, diff: -20, status: 'mismatch' },
    { account: 'ISA', name: '가상ETF', expected: 10.5, actual: 10, diff: -0.5, status: 'negative-history' },
  ]);
  assert.match(table, /^<pre>/);
  assert.match(table, /S&amp;P/);
  const lines = table.replace(/^<pre>|<\/pre>$/g, '').replace(/&amp;/g, '&').split('\n');
  const width = (s) => [...s].reduce((w, ch) => w + (/[ㄱ-힝]/.test(ch) ? 2 : 1), 0);
  for (const line of lines) assert.ok(width(line) <= 44, `폭 초과: ${line}`);
  assert.match(lines[1], /^\s*1,200\s+1,180\s+-20 연금 /);
  assert.match(lines[2], /^\s*10\.5\s+10\s+-0\.5 ISA 가상ETF$/);
});

test('경고 메시지는 판단 4단 구조로 렌더되고 플루토스 명의다', () => {
  const message = buildReconMessage({
    quantityIssues: [{ key: 'ISA|가상ETF', account: 'ISA', name: '가상ETF', status: 'mismatch', expected: 10, actual: 12, diff: 2 }],
    confirmedDuplicates: [{ reason: '같은 원천 ID', records: [exec({ quantity: 1 }), exec({ quantity: 1 })] }],
    stalePending: [exec({ quantity: 3, holdingsApplied: false })],
  });
  assert.equal(message.agent, 'plutus');
  assert.equal(message.kind, '판단');
  assert.equal(message.llm, false);
  const text = renderAgentMessage(message);
  for (const section of ['[결론]', '[사실]', '[맥락]', '[의사결정]']) assert.ok(text.includes(section), section);
  assert.ok(text.includes('사유: 기준점 대비 불일치 1'));
  assert.ok(text.includes('보유 미반영 체결 1건'));
});

test('표: 수량이 커서 이름 칸이 좁아지면 기대 칸을 빼고, 1,000 이상 소수는 정수로 줄인다', () => {
  const table = buildQuantityTable([
    { account: '연금저축', name: '가상펀드', expected: 1234567.89, actual: 7654321.12, diff: 6419753.23, status: 'mismatch' },
  ]);
  const lines = table.replace(/^<pre>|<\/pre>$/g, '').split('\n');
  assert.match(lines[0], /^\s*실제\s+차이 계좌 종목$/);
  assert.match(lines[1], /^7,654,321\s+\+6,419,753 연금 가상펀드$/);
});
