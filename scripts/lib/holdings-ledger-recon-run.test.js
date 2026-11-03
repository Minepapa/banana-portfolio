// 보유↔원장 대조 실행 흐름 테스트 — 임시 상태 디렉터리·가짜 발송 함수만 쓴다(볼트·텔레그램 접근 없음).
// 잡 진입점은 vault-paths를 끌어와 import하지 않는다(흐름은 전부 이 lib에 있다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReconArgs, runHoldingsLedgerRecon, ANCHORS_FILENAME, ALERTS_FILENAME } from './holdings-ledger-recon-run.mjs';

const exec = (over = {}) => ({
  account: 'ISA', stockName: '가상ETF', tradeDate: '2026-09-01 10:00:00', tradeType: '매수', quantity: 10, price: 1000,
  holdingsApplied: true, recordedAt: '2026-09-01T01:00:00.000Z', ...over,
  dedupKey: over.dedupKey ?? `k-${over.filename ?? Math.random()}`, filename: over.filename ?? `f-${Math.random()}.md`,
});

function setup(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'holdings-ledger-recon-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sent = { warning: [], info: [] };
  const logs = [];
  const run = (argv, data, now = new Date('2026-09-10T12:00:00Z'), overrides = {}) => runHoldingsLedgerRecon({
    args: parseReconArgs(argv), stateDir, now, log: (line) => logs.push(line), logError: (line) => logs.push(line),
    sendWarning: async (message, signature) => { sent.warning.push({ message, signature }); },
    sendInfo: async (message) => { sent.info.push(message); },
    fundPurchases: [], ...data, ...overrides,
  });
  const files = () => readdirSync(stateDir).filter((name) => !name.endsWith('.lock')).sort();
  return { stateDir, sent, logs, run, files };
}

// 기초 5 + 매수 10 = 보유 15. 중복 의심 쌍(같은 시각·수량·가격, 다른 파일)이 있는 다른 종목 하나.
const clean = () => ({
  executions: [
    exec({ filename: 'a.md' }),
    exec({ stockName: '의심종목', tradeDate: '2026-09-02 11:00:00', quantity: 1, filename: 's1.md' }),
    exec({ stockName: '의심종목', tradeDate: '2026-09-02 11:00:00', quantity: 1, filename: 's2.md' }),
  ],
  holdings: [{ account: 'ISA', name: '가상ETF', qty: 15 }, { account: 'ISA', name: '의심종목', qty: 7 }],
});

test('CLI: 모르는 인자·--help·빈 --anchors=·맨 --rebaseline·잘못된 키·충돌 조합은 거부', () => {
  for (const argv of [['--help'], ['--anchors='], ['--anchors=  '], ['--rebaseline'], ['--rebaseline=ISA'],
    ['--rebaseline=|x'], ['--anchors=a.json', '--rebaseline-all'], ['--anchors=a.json', '--rebaseline=ISA|x'],
    ['--rebaseline-all', '--rebaseline=ISA|x']]) {
    assert.throws(() => parseReconArgs(argv), Error, argv.join(' '));
  }
  assert.deepEqual(parseReconArgs(['--dry-run', '--rebaseline=ISA|가', '--rebaseline=연금저축|나']),
    { dryRun: true, anchorsFile: null, rebaselineKeys: ['ISA|가', '연금저축|나'], rebaselineAll: false });
});

test('첫 실행: 기준점 저장, 중복 의심 종목은 보류, 정보성 요약 한 번. 다음 실행은 요약 없음', async (t) => {
  const { sent, logs, run, files, stateDir } = setup(t);
  const first = await run([], clean());
  assert.deepEqual(files(), [ANCHORS_FILENAME]);
  const saved = JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8'));
  assert.deepEqual(saved.anchors, { 'ISA|가상ETF': 5 });
  assert.deepEqual(first.plan.held, ['ISA|의심종목']);
  assert.equal(sent.info.length, 1);
  assert.match(sent.info[0].body, /잡은 종목 1개/);
  assert.match(sent.info[0].body, /ISA 의심종목: 중복 의심/);
  assert.equal(sent.warning.length, 0);
  assert.ok(logs.some((line) => line.includes('기준점 보류 ISA|의심종목')));
  await run([], clean());
  assert.equal(sent.info.length, 1);
});

test('--dry-run·--anchors는 이상이 있어도 파일을 쓰지 않고 발송하지 않는다', async (t) => {
  const { sent, run, files, stateDir } = setup(t);
  const data = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 3 }] }; // 매수 10인데 보유 3 → 매도 초과
  await run(['--dry-run'], data);
  assert.deepEqual(files(), []);
  const anchorsFile = join(stateDir, 'given.json');
  writeFileSync(anchorsFile, JSON.stringify({ 'ISA|가상ETF': 0 }));
  const result = await run([`--anchors=${anchorsFile}`], data);
  assert.ok(result.issues.quantityIssues.length > 0);
  assert.deepEqual(files(), ['given.json']);
  assert.deepEqual(sent, { warning: [], info: [] });
});

test('같은 이상은 KST 하루 1회만, 다음 날 다시. 발송 실패면 억제 기록을 남기지 않는다', async (t) => {
  const { sent, run, files } = setup(t);
  await run([], clean());
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  const day1 = new Date('2026-09-11T03:00:00Z');
  await run([], drifted, day1);
  const again = await run([], drifted, new Date('2026-09-11T10:00:00Z'));
  assert.equal(sent.warning.length, 1);
  assert.equal(again.suppressed, true);
  assert.ok(files().includes(ALERTS_FILENAME));
  await run([], drifted, new Date('2026-09-12T03:00:00Z'));
  assert.equal(sent.warning.length, 2);
  // 다른 상태 디렉터리에서 발송 실패 → 기록 없음 → 다음 실행이 다시 시도
  const other = setup(t);
  await other.run([], clean());
  await assert.rejects(other.run([], drifted, day1, { sendWarning: async () => { throw new Error('전송 실패'); } }));
  assert.ok(!other.files().includes(ALERTS_FILENAME));
});

test('종목 단위 재설정: 덮어쓰기 전 백업, 이전 → 새 로그, 거부 키가 있으면 아무것도 쓰지 않음', async (t) => {
  const { sent, logs, run, files, stateDir } = setup(t);
  await run([], clean());
  const before = readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8');
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  await assert.rejects(run(['--rebaseline=ISA|가상ETF', '--rebaseline=ISA|없는종목'], drifted), /거부/);
  assert.equal(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8'), before);
  await run(['--rebaseline=ISA|가상ETF', '--rebaseline=ISA|의심종목'], drifted, new Date('2026-09-11T03:00:00Z'));
  const backups = files().filter((name) => name.startsWith('holdings-ledger-anchors.2026-09-11'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(stateDir, backups[0]), 'utf8'), before);
  const saved = JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8'));
  assert.deepEqual(saved.anchors, { 'ISA|가상ETF': 8, 'ISA|의심종목': 5 });
  assert.ok(logs.some((line) => line.includes('기준점 ISA|가상ETF: 5 → 8')));
  assert.ok(logs.some((line) => line.includes('기준점 ISA|의심종목: 없음 → 5')));
  // 방금 인정한 차이는 경고로 나가지 않는다.
  assert.equal(sent.warning.length, 0);
});

test('상태 파일이 사라지면 다시 잡고 요약을 다시 보낸다', async (t) => {
  const { sent, run, stateDir } = setup(t);
  await run([], clean());
  rmSync(join(stateDir, ANCHORS_FILENAME));
  await run([], clean());
  assert.equal(sent.info.length, 2);
});
