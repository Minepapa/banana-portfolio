import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_MINUTES,
  buildWarnableFlows,
  findNearbyFlows,
  formatNearbyFlowWarning,
  kstTimestampMs,
  parseArgs,
  recordAnchor,
  resolveAnchorTimestamp,
} from './record-cash-anchor.mjs';

test('--at: 올바른 KST 벽시계 시각은 변형 없이 앵커 ts로 쓴다', () => {
  assert.equal(resolveAnchorTimestamp('2026-09-25 14:30:00'), '2026-09-25 14:30:00');
});

test('--at: 형식이 틀린 값은 거부한다', () => {
  assert.throws(() => resolveAnchorTimestamp('2026/09/25'), /YYYY-MM-DD HH:MM:SS/);
  assert.throws(() => resolveAnchorTimestamp('2026-09-25 14:30'), /YYYY-MM-DD HH:MM:SS/);
});

test('--at: 달력에 존재하지 않는 날짜는 거부해 원장 전체 재합산·동결을 막는다', () => {
  const now = () => '2026-09-25 15:00:00';
  assert.throws(() => resolveAnchorTimestamp('2026-09-32 10:00:00', now), /존재하지 않는 날짜/);
  assert.throws(() => resolveAnchorTimestamp('2026-02-30 10:00:00', now), /존재하지 않는 날짜/);
});

test('--at: 미래 관측 시각은 거부해 예수금 동결을 막는다', () => {
  assert.throws(
    () => resolveAnchorTimestamp('2026-09-25 15:00:01', () => '2026-09-25 15:00:00'),
    /미래 시각/,
  );
});

test('--at 미지정: 주입된 현재 KST 시각을 앵커 ts로 쓴다', () => {
  assert.equal(resolveAnchorTimestamp(undefined, () => '2026-09-25 14:30:01'), '2026-09-25 14:30:01');
});

test('CLI 옵션: 오타 난 --at 계열 옵션도 조용히 현재시각으로 폴백하지 않고 거부한다', () => {
  assert.throws(() => parseArgs(['--account=연금저축', '--balance=1', '--wat=2026-09-25 14:30:00']), /알 수 없는 옵션/);
});

test('근접 흐름: 60분 창 안의 전후 흐름을 모두 경고 후보로 잡고, 창 밖은 제외한다', () => {
  const anchorTs = '2026-09-25 14:30:00';
  const { nearby, unparseable } = findNearbyFlows(anchorTs, [
    { ts: '2026-09-25 13:30:00', amount: 1000, kind: '배당' },
    { ts: '2026-09-25 13:30:01', amount: 2000, kind: '배당' },
    { ts: '2026-09-25 15:29:59', amount: -3000, kind: '체결' },
    { ts: '2026-09-25 15:30:01', amount: -4000, kind: '체결' },
  ]);

  assert.equal(WINDOW_MINUTES, 60);
  assert.deepEqual(nearby.map((flow) => flow.amount), [1000, 2000, -3000]);
  assert.deepEqual(unparseable, []);
});

test('근접 흐름: 실제 ISA 한 자리 시각과 퀀트 UTC ISO-Z 시각을 절대시각으로 파싱한다', () => {
  assert.equal(kstTimestampMs('2026-08-06 9:28:37'), Date.UTC(2026, 7, 6, 0, 28, 37));
  assert.equal(kstTimestampMs('2026-08-12T00:34:49.755Z'), Date.UTC(2026, 7, 12, 0, 34, 49, 755));
});

test('근접 흐름: 달력상 불가능한 ISO 시각도 손상 원장으로 드러낸다', () => {
  const result = findNearbyFlows('2026-03-02 09:00:00', [
    { ts: '2026-02-30T00:00:00Z', amount: 1000, kind: '체결' },
  ]);
  assert.deepEqual(result.nearby, []);
  assert.deepEqual(result.unparseable.map((flow) => flow.ts), ['2026-02-30T00:00:00Z']);
});

test('근접 흐름: 손상된 원장 시각은 조용히 누락하지 않고 수동 확인 대상으로 돌려준다', () => {
  const result = findNearbyFlows('2026-09-25 14:30:00', [
    { ts: '2026-09-25 14:20:00', amount: 1000, kind: '배당' },
    { ts: '손상된-시각', amount: -2000, kind: '체결' },
  ]);
  assert.deepEqual(result.nearby.map((flow) => flow.amount), [1000]);
  assert.deepEqual(result.unparseable.map((flow) => flow.ts), ['손상된-시각']);
});

test('근접 흐름 경고: 위험 후보가 없으면 출력할 경고가 없다', () => {
  assert.equal(formatNearbyFlowWarning('연금저축', '2026-09-25 14:30:00', { nearby: [], unparseable: [] }), null);
});

test('근접 흐름 경고: 종류·부호·금액을 포함해 전후 후보를 안내한다', () => {
  const warning = formatNearbyFlowWarning('연금저축', '2026-09-25 14:30:00', {
    nearby: [
      { ts: '2026-09-25 14:00:00', amount: 1075702, kind: '체결' },
      { ts: '2026-09-25 15:00:00', amount: -240150, kind: '체결' },
    ],
    unparseable: [{ ts: '손상된-시각', amount: 1, kind: '배당' }],
  });

  assert.match(warning, /연금저축 앵커 시각\(2026-09-25 14:30:00\) 근처 60분 이내에 흐름 2건 발견/);
  assert.match(warning, /2026-09-25 14:00:00 \+1,075,702원 \(체결\)/);
  assert.match(warning, /2026-09-25 15:00:00 -240,150원 \(체결\)/);
  assert.match(warning, /시각 파싱 실패 1건\(수동 확인 필요\): 손상된-시각/);
  assert.match(warning, /관측 시각이 이 목록의 흐름보다 이르면/);
});

test('경고용 흐름: 체결·배당·펀드적립·환전의 유효 flow를 각각 한 건씩 라벨링한다', () => {
  const flows = buildWarnableFlows('연금저축', {
    executions: [{ account: '연금저축', tradeDate: '2026-09-25 09:00:00', tradeType: '매수', quantity: 1, price: 100 }],
    dividends: [{ account: '연금저축', date: '2026-09-25', receivedTime: '10:00:00', afterTaxAmount: 200 }],
    fundPurchases: [{ account: '연금저축', date: '2026-09-25', amount: 300 }],
    exchanges: [{ account: '연금저축', date: '2026-09-25', kind: '외화매수', won: 400 }],
  });

  assert.deepEqual(flows.map(({ kind, amount }) => ({ kind, amount })), [
    { kind: '체결', amount: -100 },
    { kind: '배당', amount: 200 },
    { kind: '펀드적립', amount: -300 },
    { kind: '환전', amount: -400 },
  ]);
});

test('근접 흐름 점검이 실패해도 앵커 기록 단계는 계속 실행한다', () => {
  let written = null;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  let outcome;
  try {
    outcome = recordAnchor({
      account: '연금저축', balance: 12345, ts: '2026-09-25 14:30:00', dryRun: false,
      warn: () => { throw new Error('동기화 중 파일 소실'); },
      write: (record) => { written = record; },
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.match(written.filename, /연금저축-12345\.md$/);
  assert.equal(outcome.account, '연금저축');
  assert.equal(outcome.balance, 12345);
  assert.equal(outcome.ts, '2026-09-25 14:30:00');
});
