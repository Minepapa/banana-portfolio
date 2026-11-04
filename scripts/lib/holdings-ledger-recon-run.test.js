// 보유↔원장 대조 실행 흐름 테스트 — 임시 상태 디렉터리·가짜 발송 함수만 쓴다(볼트·텔레그램 접근 없음).
// 잡 진입점은 vault-paths를 끌어와 import하지 않는다(흐름은 전부 이 lib에 있다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseReconArgs, runHoldingsLedgerRecon, vaultCopyCompareKey, ANCHORS_FILENAME, ALERTS_FILENAME, GB_PENDING_FILENAME,
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
    { dryRun: true, externalDryRun: false, anchorsFile: null, rebaselineKeys: ['ISA|가', '연금저축|나'], rebaselineAll: false });
  assert.deepEqual(parseReconArgs(['--external-dry-run']),
    { dryRun: true, externalDryRun: true, anchorsFile: null, rebaselineKeys: [], rebaselineAll: false });
  for (const argv of [['--external-dry-run', '--anchors=a.json'], ['--external-dry-run', '--rebaseline-all'], ['--external-dry-run', '--rebaseline=ISA|x']]) {
    assert.throws(() => parseReconArgs(argv), /--external-dry-run/, argv.join(' '));
  }
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

// ── 위탁 해외주식 보유 ↔ NH 잔고 외부 대사 — NH 조회는 가짜 함수 주입(실API 없음) ──
const gbHolding = (over = {}) => ({ account: '위탁', assetClass: '해외주식', name: '가상해외주식A', ticker: '', qty: 10, isCashLike: false, ...over });
const gbBody = (rows) => ({ Output_0: {}, Output_1: rows });
const gbRow = (over = {}) => ({ iem_cd: 'VAAA', iem_nm: '가상해외주식A', cns_bse_bnc_qty: '10', byn_cns_qty: '0', sll_cns_qty: '0', ...over });
// 중복 의심 종목 없이(둘째 실행부터 원장 경고가 섞이지 않게) ISA 한 종목 + 위탁 해외주식 한 종목.
const withGb = (holdingQty = 10) => ({
  executions: [exec({ filename: 'a.md' })],
  holdings: [{ account: 'ISA', name: '가상ETF', qty: 15 }, gbHolding({ qty: holdingQty })],
});
function fakeFetch(response) {
  const fetch = async () => {
    fetch.calls += 1;
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response() : response;
  };
  fetch.calls = 0;
  return fetch;
}
// 원장 대조 쪽 결과만 뽑는다(외부 대사가 이것을 바꾸면 안 된다).
const ledgerView = (result) => ({ rows: result.rows, issues: result.issues, plan: result.plan, wroteAnchors: result.wroteAnchors,
  sentWarning: result.sentWarning, suppressed: result.suppressed, sentInfo: result.sentInfo });

test('외부 대사: 실운영은 NH 잔고를 한 번 조회해 판정하고, 볼트 사본에 요약 칸을 남긴다', async (t) => {
  const { runV, vaultFile, sent } = setupWithVault(t);
  const fetchGbBalance = fakeFetch(gbBody([gbRow()]));
  const result = await runV([], withGb(), undefined, { fetchGbBalance });
  assert.equal(fetchGbBalance.calls, 1);
  assert.equal(result.externalRecon.status, 'ok');
  const copy = JSON.parse(readFileSync(vaultFile, 'utf8'));
  assert.deepEqual(copy.externalRecon, {
    checkedAt: '2026-09-10T12:00:00.000Z', status: 'ok', compared: 1,
    matched: [{ name: '가상해외주식A', holdingsQty: 10, nhQty: 10 }], pending: [], mismatches: [],
  });
  assert.equal(sent.warning.length, 0);
  // 둘째 실행은 원장 상태가 new-anchor → ok로 바뀌어 쓰고(기존 동작), 같은 결과의 셋째 실행은 실행 시각만 달라 쓰지 않는다.
  await runV([], withGb(), new Date('2026-09-11T12:00:00Z'), { fetchGbBalance });
  const third = await runV([], withGb(), new Date('2026-09-12T12:00:00Z'), { fetchGbBalance });
  assert.equal(third.wroteVaultCopy, false);
  assert.equal(JSON.parse(readFileSync(vaultFile, 'utf8')).externalRecon.checkedAt, '2026-09-11T12:00:00.000Z');
});

test('외부 대사 불변식: 조회 실패·빈 응답·구조 이상·판정 오류는 건너뜀(사유)이고 원장 대조·기준점·원장 경고는 그대로', async (t) => {
  const drifted = { ...withGb(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, gbHolding()] };
  const baseline = setupWithVault(t);
  await baseline.runV([], withGb());
  const expected = await baseline.runV([], drifted, new Date('2026-09-11T03:00:00Z'));
  const expectedAnchors = readFileSync(join(baseline.stateDir, ANCHORS_FILENAME), 'utf8');
  const tokenError = Object.assign(new Error('토큰 거부 원문'), { stage: '토큰', code: 'RATE_LIMIT' });
  const cases = [
    [tokenError, /NH 조회 실패\(토큰\) — RATE_LIMIT/],
    [gbBody([]), /빈 응답/],
    [{ Output_1: 'x' }, /배열이 아님/],
    [null, /응답 없음/],
    [gbBody([{ iem_cd: 'VAAA', cns_bse_bnc_qty: 'abc' }]), /cns_bse_bnc_qty/],
    [() => ({ get Output_1() { throw new Error('응답 읽기 폭발'); } }), /외부 대사 내부 오류/],
  ];
  for (const [response, pattern] of cases) {
    const each = setupWithVault(t);
    await each.runV([], withGb(), undefined, { fetchGbBalance: fakeFetch(gbBody([gbRow()])) });
    const fetchGbBalance = fakeFetch(response);
    const result = await each.runV([], drifted, new Date('2026-09-11T03:00:00Z'), { fetchGbBalance });
    assert.equal(fetchGbBalance.calls, 1);
    assert.equal(result.externalRecon.status, 'skipped');
    assert.match(result.externalRecon.reason, pattern);
    assert.deepEqual(ledgerView(result), ledgerView(expected));
    assert.equal(readFileSync(join(each.stateDir, ANCHORS_FILENAME), 'utf8'), expectedAnchors);
    assert.equal(each.sent.warning.length, 1, '원장 경고는 그대로 한 번');
    assert.equal(each.sent.warning[0].signature, baseline.sent.warning[0].signature);
    assert.deepEqual(JSON.parse(readFileSync(each.vaultFile, 'utf8')).externalRecon.status, 'skipped');
    assert.ok(!JSON.stringify(JSON.parse(readFileSync(each.vaultFile, 'utf8')).externalRecon).includes('토큰 거부 원문'), '응답 원문은 사본에 남기지 않는다');
  }
});

test('외부 대사: --dry-run·--anchors·--rebaseline·--rebaseline-all에서는 NH를 부르지 않는다', async (t) => {
  const { run, stateDir } = setup(t);
  await run([], withGb());
  const anchorsFile = join(stateDir, 'given.json');
  writeFileSync(anchorsFile, JSON.stringify({ 'ISA|가상ETF': 5 }));
  for (const argv of [['--dry-run'], [`--anchors=${anchorsFile}`], ['--rebaseline=ISA|가상ETF'], ['--rebaseline-all']]) {
    const fetchGbBalance = fakeFetch(gbBody([gbRow()]));
    const result = await run(argv, withGb(), undefined, { fetchGbBalance });
    assert.equal(fetchGbBalance.calls, 0, argv.join(' '));
    assert.equal(result.externalRecon.status, 'skipped');
    assert.match(result.externalRecon.reason, /NH 조회 안 함/);
  }
  assert.ok(!existsSync(join(stateDir, GB_PENDING_FILENAME)));
});

test('외부 대사: --external-dry-run은 NH를 한 번 조회하지만 어떤 파일도 쓰지 않고 발송하지 않는다', async (t) => {
  const { runV, vaultFile, sent, files, logs } = setupWithVault(t);
  const fetchGbBalance = fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12' })]));
  const result = await runV(['--external-dry-run'], withGb(), undefined, { fetchGbBalance });
  assert.equal(fetchGbBalance.calls, 1);
  assert.equal(result.externalRecon.status, 'ok');
  assert.equal(result.externalRecon.mismatches.length, 1);
  assert.deepEqual(files(), []);
  assert.equal(existsSync(vaultFile), false);
  assert.deepEqual(sent, { warning: [], info: [] });
  assert.ok(logs.some((line) => line.includes('외부 대사 경고 발송·억제 기록 없음')));
  assert.ok(logs.some((line) => line.includes('위탁 해외주식 보유 파일과 NH 해외주식 잔고가 맞지 않습니다')));
});

test('외부 대사: 수량 차이 경고는 하루 1회(원장 경고와 다른 억제 키), 발송 실패는 던지지 않고 gbAlertError', async (t) => {
  const { run, sent, stateDir } = setup(t);
  const fetchGbBalance = fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12' })]));
  const day1 = new Date('2026-09-10T12:00:00Z');
  const first = await run([], withGb(), day1, { fetchGbBalance });
  assert.equal(first.sentGbWarning, true);
  assert.equal(sent.warning.length, 1);
  assert.match(sent.warning[0].signature, /^gb-m:/);
  assert.match(sent.warning[0].message.conclusion, /NH 해외주식 잔고/);
  const again = await run([], withGb(), new Date('2026-09-10T13:00:00Z'), { fetchGbBalance });
  assert.equal(again.gbSuppressed, true);
  assert.equal(sent.warning.length, 1);
  const alerts = JSON.parse(readFileSync(join(stateDir, ALERTS_FILENAME), 'utf8'));
  assert.ok(Object.keys(alerts.sent).some((key) => key.startsWith('holdings-gb-balance:')));
  await run([], withGb(), new Date('2026-09-11T12:00:00Z'), { fetchGbBalance });
  assert.equal(sent.warning.length, 2);
  // 발송 실패: 원장 결과는 그대로, 던지지 않음, 억제 기록 없음.
  const other = setup(t);
  const result = await other.run([], withGb(), day1, { fetchGbBalance, sendWarning: async () => { throw new Error('전송 실패'); } });
  assert.match(result.gbAlertError, /전송 실패/);
  assert.equal(result.sentGbWarning, false);
  assert.ok(existsSync(join(other.stateDir, ANCHORS_FILENAME)));
  assert.ok(!existsSync(join(other.stateDir, ALERTS_FILENAME)));
});

test('외부 대사: 게시 대기는 1일차 경고 없음, 시작일을 상태 파일에 기억해 주말 빼고 2영업일 초과 때 경고', async (t) => {
  const { run, sent, stateDir } = setup(t);
  const fetchGbBalance = fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12', byn_cns_qty: '2' })]));
  // 2026-09-04(금) KST 21시 → 월(1) 화(2) 조용히, 수(3) 경고.
  const at = (day) => new Date(`${day}T12:10:00Z`);
  const fri = await run([], withGb(10), at('2026-09-04'), { fetchGbBalance });
  assert.equal(fri.externalRecon.pending[0].since, '2026-09-04');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, GB_PENDING_FILENAME), 'utf8')).pending, { '위탁|가상해외주식A': { since: '2026-09-04' } });
  for (const day of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']) await run([], withGb(10), at(day), { fetchGbBalance });
  assert.equal(sent.warning.length, 0);
  const wed = await run([], withGb(10), at('2026-09-09'), { fetchGbBalance });
  assert.equal(wed.sentGbWarning, true);
  assert.match(sent.warning[0].signature, /^gb-p:위탁\|가상해외주식A:2026-09-04$/);
  assert.equal(wed.externalRecon.pending[0].businessDays, 3);
  // 미리보기는 상태 파일을 바꾸지 않는다.
  const before = readFileSync(join(stateDir, GB_PENDING_FILENAME), 'utf8');
  await run(['--external-dry-run'], withGb(12), at('2026-09-10'), { fetchGbBalance: fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12' })])) });
  assert.equal(readFileSync(join(stateDir, GB_PENDING_FILENAME), 'utf8'), before);
  // 게시되면(보유 12 = 잔고 12, 대기 0) 상태에서 빠진다.
  await run([], withGb(12), at('2026-09-10'), { fetchGbBalance: fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12' })])) });
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, GB_PENDING_FILENAME), 'utf8')).pending, {});
});

test('외부 대사: 게시 대기 상태 파일이 깨졌으면 오늘부터 다시 세고 사본 요약에 표시한다', async (t) => {
  const { run, stateDir } = setup(t);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, GB_PENDING_FILENAME), '{ 깨짐');
  const result = await run([], withGb(10), undefined, { fetchGbBalance: fakeFetch(gbBody([gbRow({ cns_bse_bnc_qty: '12', byn_cns_qty: '2' })])) });
  assert.equal(result.externalRecon.pendingStateReset, true);
  assert.equal(result.externalRecon.pending[0].since, '2026-09-10');
});

test('볼트 사본 비교 키는 외부 대사 checkedAt도 뺀다', () => {
  const a = JSON.stringify({ generatedAt: 'x', anchors: {}, externalRecon: { checkedAt: 'x', status: 'ok', compared: 1 } });
  const b = JSON.stringify({ generatedAt: 'y', anchors: {}, externalRecon: { checkedAt: 'y', status: 'ok', compared: 1 } });
  const c = JSON.stringify({ generatedAt: 'y', anchors: {}, externalRecon: { checkedAt: 'y', status: 'skipped', reason: 'r' } });
  assert.equal(vaultCopyCompareKey(a), vaultCopyCompareKey(b));
  assert.notEqual(vaultCopyCompareKey(a), vaultCopyCompareKey(c));
});

test('외부 대사: NH 조회가 제한 시간 안에 끝나지 않으면 건너뜀(시간 초과)이고 원장 사본·경고는 이어진다', async (t) => {
  const { runV, vaultFile, stateDir } = setupWithVault(t);
  await runV([], withGb());
  const hang = () => new Promise(() => {});
  const drifted = { ...withGb(), holdings: [{ account: 'ISA', name: '가상ETF', qty: 18 }, gbHolding()] };
  const result = await runV([], drifted, new Date('2026-09-11T03:00:00Z'), { fetchGbBalance: hang, gbFetchTimeoutMs: 20 });
  assert.equal(result.externalRecon.status, 'skipped');
  assert.match(result.externalRecon.reason, /NH 조회 실패 — TIMEOUT/);
  assert.equal(result.sentWarning, true);
  assert.equal(JSON.parse(readFileSync(vaultFile, 'utf8')).externalRecon.status, 'skipped');
  assert.ok(!existsSync(join(stateDir, GB_PENDING_FILENAME)));
});
