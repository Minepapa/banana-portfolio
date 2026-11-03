// 보유↔원장 대조 실행 흐름 테스트 — 임시 상태 디렉터리·가짜 발송 함수만 쓴다(볼트·텔레그램 접근 없음).
// 잡 진입점은 vault-paths를 끌어와 import하지 않는다(흐름은 전부 이 lib에 있다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseReconArgs, runHoldingsLedgerRecon, vaultCopyCompareKey, ANCHORS_FILENAME, ALERTS_FILENAME,
} from './holdings-ledger-recon-run.mjs';
import { REAL_VAULT_ROOT } from './write-if-changed.mjs';

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

// ── 볼트 사본(95_Etna/Jobs/HoldingsLedgerRecon.json) — 임시 폴더를 볼트 사본 경로로 주입한다 ──
function setupWithVault(t) {
  const base = setup(t);
  const vaultDir = mkdtempSync(join(tmpdir(), 'holdings-ledger-recon-vault-'));
  t.after(() => rmSync(vaultDir, { recursive: true, force: true }));
  const vaultFile = join(vaultDir, '95_Etna', 'Jobs', 'HoldingsLedgerRecon.json');
  const runV = (argv, data, now, overrides = {}) => base.run(argv, data, now, { vaultFile, ...overrides });
  return { ...base, vaultFile, runV };
}

test('볼트 사본: 기준점·마지막 대조 요약(상태별 건수·이상·보류)을 쓰고, generatedAt만 바뀐 실행은 쓰지 않는다', async (t) => {
  const { runV, vaultFile, stateDir } = setupWithVault(t);
  const first = await runV([], clean());
  assert.equal(first.wroteVaultCopy, true);
  const copy = JSON.parse(readFileSync(vaultFile, 'utf8'));
  assert.equal(copy.schemaVersion, 1);
  assert.equal(copy.generatedAt, '2026-09-10T12:00:00.000Z');
  assert.deepEqual(copy.anchors, JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8')).anchors);
  assert.equal(copy.lastRecon.rowCount, first.rows.length);
  assert.equal(Object.values(copy.lastRecon.statusCounts).reduce((a, b) => a + b, 0), first.rows.length);
  assert.deepEqual(copy.lastRecon.held.map((item) => item.key), ['ISA|의심종목']);
  assert.match(copy.lastRecon.held[0].reason, /중복 의심/);
  assert.deepEqual(copy.lastRecon.issues, []);
  // 둘째 실행부터는 기준점이 있으므로 보류 종목이 '기준점 없음' 이상으로 잡혀 내용이 바뀐다 — 그래서 쓴다.
  const second = await runV([], clean(), new Date('2026-09-11T12:00:00Z'));
  assert.equal(second.wroteVaultCopy, true);
  const before = readFileSync(vaultFile, 'utf8');
  // 같은 결과로 다음 날 다시 돌면 generatedAt만 다르므로 쓰지 않는다.
  const third = await runV([], clean(), new Date('2026-09-12T12:00:00Z'));
  assert.equal(third.wroteVaultCopy, false);
  assert.equal(readFileSync(vaultFile, 'utf8'), before);
  // 수량 이상이 생기면 다시 쓰고 이상 목록에 남긴다.
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  const fourth = await runV([], drifted, new Date('2026-09-13T12:00:00Z'));
  assert.equal(fourth.wroteVaultCopy, true);
  const issues = JSON.parse(readFileSync(vaultFile, 'utf8')).lastRecon.issues;
  const gainer = issues.find((item) => item.key === 'ISA|가상ETF');
  assert.equal(gainer.type, 'quantity');
  assert.equal(gainer.actual, 18);
  assert.equal(JSON.parse(readFileSync(vaultFile, 'utf8')).generatedAt, '2026-09-13T12:00:00.000Z');
});

test('볼트 사본: --dry-run·--anchors에서는 쓰지 않는다', async (t) => {
  const { runV, vaultFile, stateDir } = setupWithVault(t);
  await runV(['--dry-run'], clean());
  assert.equal(existsSync(vaultFile), false);
  const anchorsFile = join(stateDir, 'given.json');
  writeFileSync(anchorsFile, JSON.stringify({ 'ISA|가상ETF': 5 }));
  await runV([`--anchors=${anchorsFile}`], clean());
  assert.equal(existsSync(vaultFile), false);
});

test('볼트 사본: 상태 파일이 없으면 사본의 기준점으로 복원하고 새로 잡지 않는다(요약 발송 없음, 차이는 경고)', async (t) => {
  const { runV, vaultFile, stateDir, sent, logs } = setupWithVault(t);
  await runV([], clean());
  assert.equal(sent.info.length, 1);
  rmSync(join(stateDir, ANCHORS_FILENAME));
  // 그 사이 원장에 안 잡힌 보유 증가(15 → 18). 새로 잡았다면 기준점 8로 묻혔을 차이다.
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  // 미리보기는 복원값으로 계산만 하고 상태 파일을 만들지 않는다.
  const preview = await runV(['--dry-run'], drifted, new Date('2026-09-11T03:00:00Z'));
  assert.equal(preview.restoredFromVault, true);
  assert.equal(existsSync(join(stateDir, ANCHORS_FILENAME)), false);
  const result = await runV([], drifted, new Date('2026-09-11T03:00:00Z'));
  assert.equal(result.restoredFromVault, true);
  assert.equal(sent.info.length, 1, '복원은 첫 설정이 아니다');
  const restored = JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8'));
  assert.deepEqual(restored.anchors, { 'ISA|가상ETF': 5 });
  assert.equal(sent.warning.length, 1);
  assert.ok(result.issues.quantityIssues.some((row) => row.key === 'ISA|가상ETF' && row.actual === 18));
  assert.ok(logs.some((line) => line.includes('볼트 사본에서 복원')));
  assert.deepEqual(JSON.parse(readFileSync(vaultFile, 'utf8')).anchors, { 'ISA|가상ETF': 5 });
});

test('볼트 사본: 상태 파일이 없는데 사본이 깨졌거나 형식이 틀리면 아무것도 쓰지 않고 실패(--rebaseline-all만 통과)', async (t) => {
  const { runV, vaultFile, sent, files, logs } = setupWithVault(t);
  mkdirSync(dirname(vaultFile), { recursive: true });
  for (const content of ['{ 깨짐', JSON.stringify({ schemaVersion: 1, anchors: { 'ISA|가상ETF': '5' } })]) {
    writeFileSync(vaultFile, content);
    for (const argv of [[], ['--dry-run']]) {
      await assert.rejects(runV(argv, clean()), /볼트 사본.*복원할 수 없음/);
    }
    assert.equal(readFileSync(vaultFile, 'utf8'), content, '깨진 사본을 덮어쓰지 않는다');
    assert.deepEqual(files(), []);
  }
  assert.deepEqual(sent, { warning: [], info: [] });
  // 오너가 확인한 뒤 명시적으로 다시 잡는 길은 열려 있다.
  const reset = await runV(['--rebaseline-all'], clean());
  assert.equal(reset.restoredFromVault, false);
  assert.ok(logs.some((line) => line.includes('--rebaseline-all이라 계속')));
  assert.deepEqual(JSON.parse(readFileSync(vaultFile, 'utf8')).anchors, { 'ISA|가상ETF': 5 });
  // 기준점이 빈 사본은 복원할 것이 없으므로 첫 실행처럼 잡는다.
  const empty = setupWithVault(t);
  mkdirSync(dirname(empty.vaultFile), { recursive: true });
  writeFileSync(empty.vaultFile, JSON.stringify({ schemaVersion: 1, anchors: {} }));
  const seeded = await empty.runV([], clean());
  assert.equal(seeded.restoredFromVault, false);
  assert.equal(empty.sent.info.length, 1);
});

test('볼트 사본: 복원만 한 날은 원래 기준점 시각을 지키고, 복원 + 종목 재설정은 그 종목만 바꾼다', async (t) => {
  const { runV, vaultFile, stateDir, sent } = setupWithVault(t);
  await runV([], clean());
  const firstAt = JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8')).updatedAt;
  rmSync(join(stateDir, ANCHORS_FILENAME));
  await runV([], clean(), new Date('2026-09-11T03:00:00Z'));
  assert.equal(JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8')).updatedAt, firstAt);
  assert.equal(JSON.parse(readFileSync(vaultFile, 'utf8')).anchorsUpdatedAt, firstAt);
  rmSync(join(stateDir, ANCHORS_FILENAME));
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  const result = await runV(['--rebaseline=ISA|가상ETF'], drifted, new Date('2026-09-12T03:00:00Z'));
  assert.equal(result.restoredFromVault, true);
  assert.equal(sent.info.length, 1, '복원 + 재설정도 첫 설정 요약은 보내지 않는다');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, ANCHORS_FILENAME), 'utf8')).anchors, { 'ISA|가상ETF': 8 });
  assert.ok(!result.issues.quantityIssues.some((row) => row.key === 'ISA|가상ETF'), '방금 인정한 차이는 경고하지 않는다');
  assert.deepEqual(JSON.parse(readFileSync(vaultFile, 'utf8')).anchors, { 'ISA|가상ETF': 8 });
});

test('볼트 사본: 쓰기가 실패해도 기준점 저장·경고는 계속하고 vaultCopyError를 남긴다', async (t) => {
  const { runV, vaultFile, stateDir, sent } = setupWithVault(t);
  mkdirSync(vaultFile, { recursive: true }); // 사본 경로 자리에 폴더 — 원자적 쓰기의 rename이 실패한다
  const drifted = { ...clean(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, { account: 'ISA', name: '의심종목', qty: 7 }] };
  await assert.rejects(runV([], drifted), /볼트 사본/, '폴더는 깨진 사본으로 보고 복원을 거부한다');
  // 상태 파일이 있으면 사본을 읽지 않으므로 쓰기 실패만 남는다.
  const ok = setupWithVault(t);
  await ok.runV([], clean());
  rmSync(ok.vaultFile);
  mkdirSync(ok.vaultFile);
  const result = await ok.runV([], drifted, new Date('2026-09-11T03:00:00Z'));
  assert.ok(result.vaultCopyError);
  assert.equal(result.wroteVaultCopy, false);
  assert.equal(ok.sent.warning.length, 1);
  assert.ok(existsSync(join(ok.stateDir, ANCHORS_FILENAME)));
  assert.deepEqual(sent, { warning: [], info: [] });
  assert.ok(!existsSync(join(stateDir, ANCHORS_FILENAME)));
});

test('볼트 사본: 테스트 중 실볼트 경로는 아무것도 하기 전에 거부한다', async (t) => {
  const { run, files } = setup(t);
  const realVaultFile = join(REAL_VAULT_ROOT, '95_Etna', 'Jobs', 'HoldingsLedgerRecon.json');
  for (const argv of [[], ['--dry-run']]) {
    await assert.rejects(run(argv, clean(), undefined, { vaultFile: realVaultFile }), /실볼트/);
  }
  assert.deepEqual(files(), []);
});

test('볼트 사본 비교 키는 generatedAt만 뺀다', () => {
  const a = JSON.stringify({ schemaVersion: 1, generatedAt: 'x', anchors: { k: 1 } });
  const b = JSON.stringify({ schemaVersion: 1, generatedAt: 'y', anchors: { k: 1 } });
  const c = JSON.stringify({ schemaVersion: 1, generatedAt: 'y', anchors: { k: 2 } });
  assert.equal(vaultCopyCompareKey(a), vaultCopyCompareKey(b));
  assert.notEqual(vaultCopyCompareKey(a), vaultCopyCompareKey(c));
});
