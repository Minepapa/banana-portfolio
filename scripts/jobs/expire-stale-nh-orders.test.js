import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProposalRecord, parseProposal, updateProposalRecord } from '../lib/proposal-vault.mjs';
import { INSTRUMENT_TYPE } from '../lib/asset-allocation-instrument-router.mjs';
import { eligibleOrderDate, classifyExpiryRow, runExpiry, formatExpiryMessage } from './expire-stale-nh-orders.mjs';
import { readWarningEvents } from '../lib/warning-event-journal.mjs';

const journalRoot = mkdtempSync(join(tmpdir(), 'nh-expiry-warning-'));
after(() => rmSync(journalRoot, { recursive: true, force: true }));

const NOW = new Date('2026-10-10T07:00:00Z'); // 16:00 KST
const ORDER_TIME = new Date('2026-10-10T05:00:00Z').toISOString();
const CODE = '005930';
const ORDER = '12345678'; // 가상 주문번호

function fixture(status = '주문접수', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nh-expiry-'));
  const record = buildProposalRecord({ track: '자산분배', account: '위탁', assetKey: CODE,
    side: '매수', quantity: 10, proposedPrice: 1000, now: new Date(ORDER_TIME) });
  const filepath = join(dir, record.filename);
  writeFileSync(filepath, updateProposalRecord(record.content, {
    status, brokerOrderId: ORDER, submittedAt: ORDER_TIME, ...extra,
  }));
  return { dir, filepath, proposal: parseProposal(readFileSync(filepath, 'utf8')) };
}

function row({ filled = 0, unfilled = 0, canceled = 10, ...overrides } = {}) {
  return { itg_orr_no: ORDER, iem_cd: CODE, orr_qty: '10', tot_cns_qty: String(filled),
    ny_cns_qty: String(unfilled), can_qty: String(canceled), cns_avg_uit_pr: '1000',
    sby_dit_cd_nm: '매수', ...overrides };
}

function dependencies(apiRow, overrides = {}) {
  const calls = { sent: [], queries: 0 };
  return { calls, options: {
    now: NOW,
    classify: async () => ({ type: INSTRUMENT_TYPE.KR_STOCK, nhAccountLabel: '위탁', iemCd: CODE }),
    accounts: new Map([['위탁', 'test-account'], ['금현물', 'test-gold']]),
    query: { [INSTRUMENT_TYPE.KR_STOCK]: async () => { calls.queries++; return { Output_0: apiRow == null ? [] : [apiRow] }; } },
    send: async (message) => { calls.sent.push(message); return { ok: true, result: { message_id: calls.sent.length } }; },
    journalRoot,
    log: () => {}, ...overrides,
  } };
}

async function withFixture(status, fn, extra) {
  const data = fixture(status, extra);
  try { await fn(data); } finally { rmSync(data.dir, { recursive: true, force: true }); }
}

test('전량 체결은 watcher와 같은 종결 필드를 쓴다', async () => withFixture('주문접수', async ({ dir, filepath }) => {
  const { options, calls } = dependencies(row({ filled: 10, canceled: 0 }));
  const summary = await runExpiry({ proposalsDir: dir, ...options });
  const updated = parseProposal(readFileSync(filepath, 'utf8'));
  assert.equal(updated.status, '체결');
  assert.equal(updated.filledQuantity, 10);
  assert.equal(updated.avgFillPrice, 1000);
  assert.equal(summary.filled, 1);
  assert.equal(calls.sent.length, 1);
}));

test('부분체결 후 잔량 0은 watcher와 같은 취소 종결 필드를 쓴다', async () => withFixture('부분체결', async ({ dir, filepath }) => {
  const { options } = dependencies(row({ filled: 4, canceled: 6 }));
  const summary = await runExpiry({ proposalsDir: dir, ...options });
  const updated = parseProposal(readFileSync(filepath, 'utf8'));
  assert.equal(updated.status, '취소');
  assert.equal(updated.filledQuantity, 4);
  assert.equal(summary.partialClosed, 1);
}));

test('체결 0, 잔량 소멸은 만료되며 거부 쿨다운 상태를 쓰지 않는다', async () => withFixture('주문접수', async ({ dir, filepath }) => {
  const { options } = dependencies(row());
  const summary = await runExpiry({ proposalsDir: dir, ...options });
  const updated = parseProposal(readFileSync(filepath, 'utf8'));
  assert.equal(updated.status, '만료');
  assert.match(updated.rejectReason, /장 마감 미체결 소멸.*12345678.*NH 조회 확인/);
  assert.equal(summary.expired, 1);
}));

test('응답 없음·수량 결측·잔량 존재·종목 불일치에서는 상태 불변', async () => {
  for (const apiRow of [null, row({ ny_cns_qty: '' }), row({ unfilled: 10, canceled: 0 }), row({ iem_cd: '000660' })]) {
    await withFixture('주문접수', async ({ dir, filepath }) => {
      const original = readFileSync(filepath, 'utf8');
      const { options } = dependencies(apiRow);
      const summary = await runExpiry({ proposalsDir: dir, ...options });
      assert.equal(readFileSync(filepath, 'utf8'), original);
      assert.equal(summary.unknown, 1);
    });
  }
});

test('오늘 15:30 전과 미래 주문은 조회조차 하지 않는다', async () => withFixture('주문접수', async ({ dir, proposal, filepath }) => {
  assert.equal(eligibleOrderDate(proposal, new Date('2026-10-10T06:29:00Z')), null);
  assert.equal(eligibleOrderDate(proposal, new Date('2026-10-09T07:00:00Z')), null);
  const original = readFileSync(filepath, 'utf8');
  const { options, calls } = dependencies(row());
  await runExpiry({ proposalsDir: dir, ...options, now: new Date('2026-10-10T06:29:00Z') });
  assert.equal(calls.queries, 0);
  assert.equal(readFileSync(filepath, 'utf8'), original);
}));

test('조회와 쓰기 사이 상태 변경은 잠금 후 재확인해 건너뛴다', async () => withFixture('주문접수', async ({ dir, filepath }) => {
  const { options } = dependencies(row(), { beforeWrite: async () => {
    const content = readFileSync(filepath, 'utf8');
    writeFileSync(filepath, updateProposalRecord(content, { status: '체결' }));
  } });
  const summary = await runExpiry({ proposalsDir: dir, ...options });
  assert.equal(parseProposal(readFileSync(filepath, 'utf8')).status, '체결');
  assert.equal(summary.raced, 1);
  assert.equal(summary.expired, 0);
}));

test('금현물 조회 함수 미제공과 미지원 자산은 상태 불변', async () => {
  for (const type of [INSTRUMENT_TYPE.GOLD, INSTRUMENT_TYPE.OVERSEAS_STOCK]) {
    await withFixture('주문접수', async ({ dir, filepath }) => {
      const original = readFileSync(filepath, 'utf8');
      const { options, calls } = dependencies(row(), { classify: async () => ({ type, nhAccountLabel: type === INSTRUMENT_TYPE.GOLD ? '금현물' : '위탁', iemCd: CODE }) });
      const summary = await runExpiry({ proposalsDir: dir, ...options });
      assert.equal(readFileSync(filepath, 'utf8'), original);
      assert.equal(summary.unknown, 1);
      assert.equal(calls.queries, 0);
    });
  }
});

test('dry-run은 조회·판정만, no-send는 쓰기만 한다', async () => {
  await withFixture('주문접수', async ({ dir, filepath }) => {
    const original = readFileSync(filepath, 'utf8');
    const { options, calls } = dependencies(row());
    const summary = await runExpiry({ proposalsDir: dir, ...options, dryRun: true });
    assert.equal(summary.expired, 1);
    assert.equal(calls.queries, 1);
    assert.equal(calls.sent.length, 0);
    assert.equal(readFileSync(filepath, 'utf8'), original);
  });
  await withFixture('주문접수', async ({ dir, filepath }) => {
    const { options, calls } = dependencies(row());
    await runExpiry({ proposalsDir: dir, ...options, noSend: true });
    assert.equal(parseProposal(readFileSync(filepath, 'utf8')).status, '만료');
    assert.equal(calls.sent.length, 0);
  });
});

test('알림은 주문번호 끝 4자리와 확인 필요 항목만 노출', () => {
  const proposal = fixture().proposal;
  const body = formatExpiryMessage([{ proposal, result: '만료' }, { proposal, result: '확인 필요' }]);
  assert.match(body, /…5678/);
  assert.doesNotMatch(body, /12345678/);
  assert.match(body, /확인 필요/);
  assert.match(body, /필요하면 다시 제안·주문해 주세요/);
});

test('일치하지 않는 주문번호는 판정 불가', () => {
  const proposal = fixture().proposal;
  assert.equal(classifyExpiryRow(row({ itg_orr_no: '9999' }), proposal, CODE).result, '확인 필요');
});

test('정정 방어: 같은 날 같은 종목·같은 방향의 다른 주문이 있으면 만료·부분종결로 닫지 않는다', async () => withFixture('주문접수', async ({ dir, filepath }) => {
  const sibling = row({ itg_orr_no: '87654321', filled: 10, canceled: 0 });
  const { options, calls } = dependencies(null, {
    query: { [INSTRUMENT_TYPE.KR_STOCK]: async () => ({ Output_0: [row(), sibling] }) },
  });
  const summary = await runExpiry({ proposalsDir: dir, ...options });
  assert.equal(summary.expired, 0);
  assert.equal(summary.unknown, 1);
  assert.equal(parseProposal(readFileSync(filepath, 'utf8')).status, '주문접수');
  assert.equal(calls.sent.length, 0, '오늘 주문의 확인 필요는 아직 알리지 않음');
}));

test('하루 넘은 확인 필요 건은 단독으로도 알리고, 쓰기 실패·알림 실패가 처리 전체를 멈추지 않는다', async () => {
  const older = new Date('2026-10-08T05:00:00Z').toISOString();
  const first = fixture('주문접수', { submittedAt: older });
  try {
    const { options, calls } = dependencies(null); // 행 없음 → 확인 필요
    const summary = await runExpiry({ proposalsDir: first.dir, ...options });
    assert.equal(summary.unknown, 1);
    assert.equal(calls.sent.length, 1);
    assert.match(calls.sent[0].body, /■ 확인 필요/);
    const warning = readWarningEvents({ rootDir: journalRoot }).events.find((event) => event.eventType === 'detected');
    assert.equal(warning.warningCode, 'NH_ORDER_EXPIRY_UNCERTAIN');
    assert.match(warning.detail, /확인 필요/);
    assert.doesNotMatch(calls.sent[0].body, /다시 제안·주문해 주세요/, '정리된 건이 없으면 재주문 안내 없음');
  } finally { rmSync(first.dir, { recursive: true, force: true }); }
  const second = fixture('주문접수');
  try {
    const { options } = dependencies(row(), {
      beforeWrite: async () => { throw new Error('디스크 오류'); },
    });
    const summary = await runExpiry({ proposalsDir: second.dir, ...options });
    assert.equal(summary.unknown, 1, '쓰기 실패는 확인 필요로 집계');
    assert.equal(parseProposal(readFileSync(second.filepath, 'utf8')).status, '주문접수');
  } finally { rmSync(second.dir, { recursive: true, force: true }); }
  const third = fixture('주문접수');
  try {
    const { options } = dependencies(row(), { send: async () => { throw new Error('텔레그램 끊김'); } });
    const summary = await runExpiry({ proposalsDir: third.dir, ...options });
    assert.equal(summary.expired, 1);
    assert.equal(summary.sendFailed, true);
  } finally { rmSync(third.dir, { recursive: true, force: true }); }
});

test('알림 본문은 HTML 이스케이프·체결 건에는 재주문 안내를 붙이지 않는다', async () => {
  const body = formatExpiryMessage([{ proposal: { assetKey: 'S&P500 <ETF>', quantity: 3, brokerOrderId: '99991234' }, result: '체결' }]);
  assert.match(body, /S&amp;P500 &lt;ETF&gt;/);
  assert.doesNotMatch(body, /다시 제안·주문해 주세요/);
});
