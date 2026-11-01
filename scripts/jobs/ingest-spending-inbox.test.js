import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync,
  statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestSpendingInbox } from './ingest-spending-inbox.mjs';
import { withLock } from '../lib/state-writer.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'spending-inbox-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeDb(documents) {
  const remaining = new Map(documents.map((document) => [document.id, document]));
  const deleted = [];
  return {
    deleted,
    remaining,
    collection(name) {
      assert.equal(name, 'spendingInbox');
      return {
        async get() {
          return { docs: [...remaining.values()].map((document) => ({
            id: document.id, data: () => document,
          })) };
        },
        doc(id) {
          return { async delete() { deleted.push(id); remaining.delete(id); } };
        },
      };
    },
  };
}

function notification(id, ts = '2026-10-10 09:00:00') {
  return {
    id, ts, source: 'app', packageName: 'example.app', appLabel: 'Sample App',
    sender: 'Example Sender', body: '가상 알림 본문', postedAt: 1791580800000,
    createdAt: 'ignored',
  };
}

function lines(directory, date) {
  const file = join(directory, date.slice(0, 4), `${date}.jsonl`);
  return readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
}

const quietLogger = { log() {} };

test('정상 수집은 지정한 필드만 JSONL로 저장하고 재확인 후 삭제한다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([notification('sample-1')]);
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  assert.equal(result.deleted, 1);
  assert.deepEqual(db.deleted, ['sample-1']);
  assert.deepEqual(lines(directory, '2026-10-10'), [{
    id: 'sample-1', ts: '2026-10-10 09:00:00', source: 'app',
    packageName: 'example.app', appLabel: 'Sample App', sender: 'Example Sender',
    body: '가상 알림 본문', postedAt: 1791580800000,
  }]);
});

test('같은 id 재실행은 줄을 더하지 않고 확인된 문서만 삭제한다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([notification('sample-1')]), spendingDir: directory, logger: quietLogger });
  const retryDb = fakeDb([notification('sample-1')]);
  const result = await ingestSpendingInbox({ db: retryDb, spendingDir: directory, logger: quietLogger });
  assert.equal(result.duplicate, 1);
  assert.equal(lines(directory, '2026-10-10').length, 1);
  assert.deepEqual(retryDb.deleted, ['sample-1']);
});

test('같은 id라도 원문이 달라졌으면 기존 줄을 유지하고 Firestore 문서를 남긴다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([notification('sample-1')]), spendingDir: directory, logger: quietLogger });
  const changedDocument = { ...notification('sample-1'), body: '수정된 가상 알림 본문' };
  const retryDb = fakeDb([changedDocument]);
  const result = await ingestSpendingInbox({ db: retryDb, spendingDir: directory, logger: quietLogger });
  assert.equal(result.failed, 1);
  assert.equal(result.duplicate, 0);
  assert.deepEqual(retryDb.deleted, []);
  assert.deepEqual(lines(directory, '2026-10-10').map((line) => line.body), ['가상 알림 본문']);
});

test('쓰기 실패 시 Firestore 문서는 남는다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([notification('sample-1')]);
  const fileOps = {
    existsSync,
    readFileSync,
    mkdirSync,
    appendFileSync() { throw new Error('synthetic write failure'); },
  };
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger, fileOps });
  assert.equal(result.failed, 1);
  assert.deepEqual(db.deleted, []);
  assert.equal(db.remaining.size, 1);
});

test('추가 후 다시 읽어 확인하지 못하면 Firestore 문서는 남는다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([notification('sample-1')]);
  const fileOps = {
    existsSync, mkdirSync, appendFileSync,
    readFileSync() { return ''; },
  };
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger, fileOps });
  assert.equal(result.failed, 1);
  assert.deepEqual(db.deleted, []);
  assert.equal(lines(directory, '2026-10-10').length, 1);
});

test('충돌로 남은 마지막 미완성 줄만 잘라낸 뒤 같은 날 수집을 재개한다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([notification('first')]), spendingDir: directory, logger: quietLogger });
  const filepath = join(directory, '2026', '2026-10-10.jsonl');
  appendFileSync(filepath, '{"id":"unfinished"', 'utf8');

  const db = fakeDb([notification('second')]);
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  assert.equal(result.deleted, 1);
  assert.deepEqual(db.deleted, ['second']);
  assert.deepEqual(lines(directory, '2026-10-10').map((line) => line.id), ['first', 'second']);
});

test('줄바꿈까지 있는 손상 줄은 보존하고 해당 날짜 문서를 삭제하지 않는다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([notification('first')]), spendingDir: directory, logger: quietLogger });
  const filepath = join(directory, '2026', '2026-10-10.jsonl');
  appendFileSync(filepath, '{"id":"broken"\n', 'utf8');

  const db = fakeDb([notification('second')]);
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  assert.equal(result.failed, 1);
  assert.deepEqual(db.deleted, []);
  assert.match(readFileSync(filepath, 'utf8'), /broken/);
});

test('잘못된 ts와 빈 body는 삭제하지 않고 건수만 기록한다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([
    notification('bad-date', '2026-02-30 09:00:00'),
    notification('bad-format', '2026/10/10 09:00:00'),
    { ...notification('empty'), body: '   ' },
  ]);
  const logs = [];
  const result = await ingestSpendingInbox({ db, spendingDir: directory, logger: { log: (message) => logs.push(message) } });
  assert.equal(result.invalid, 3);
  assert.deepEqual(db.deleted, []);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /가상 알림|bad-date|2026-10-10/);
});

test('dry-run은 파일 생성과 Firestore 삭제 없이 계획 건수만 낸다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([notification('sample-1')]);
  const result = await ingestSpendingInbox({ db, spendingDir: directory, dryRun: true, logger: quietLogger });
  assert.equal(result.planned, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(db.deleted, []);
  assert.deepEqual(readdirSync(directory), []);
});

test('확인된 원문을 보존하고 일별 파생 요약을 갱신한다', async (t) => {
  const directory = fixture(t);
  const payment = { ...notification('sample-1'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' };
  await ingestSpendingInbox({ db: fakeDb([payment]), spendingDir: directory, logger: quietLogger });
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
  assert.equal(lines(directory, '2026-10-10')[0].body, payment.body);
  await ingestSpendingInbox({ db: fakeDb([notification('sample-2')]), spendingDir: directory,
    dryRun: true, logger: quietLogger });
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
});

test('요약 실패 후 Firestore 문서가 없어도 다음 실행에서 원문으로 복구한다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([{ ...notification('payment'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' }]);
  const settingsPath = join(directory, 'settings.json');
  writeFileSync(settingsPath, '{broken', 'utf8');

  const first = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  assert.equal(first.deleted, 1);
  assert.equal(first.failed, 1);
  assert.equal(db.remaining.size, 0);
  assert.equal(existsSync(summaryPath), false);
  assert.equal(lines(directory, '2026-10-10').length, 1);

  writeFileSync(settingsPath, '{"recipientDecisions":[]}', 'utf8');
  const second = await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  assert.equal(second.read, 0);
  assert.equal(second.failed, 0);
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
  assert.equal(lines(directory, '2026-10-10').length, 1);
});

test('원문보다 오래된 요약은 신규 문서가 없어도 다시 계산한다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([{ ...notification('first'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' }]), spendingDir: directory, logger: quietLogger });
  const rawPath = join(directory, '2026', '2026-10-10.jsonl');
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  appendFileSync(rawPath, `${JSON.stringify({ ...notification('second'), sender: '하나카드',
    body: '사용금액 : 1,500원\n가맹점 : 가상식당' })}\n`, 'utf8');
  utimesSync(summaryPath, new Date(0), new Date(0));

  await ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory, logger: quietLogger });
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 4000);
  assert.equal(lines(directory, '2026-10-10').length, 2);
});

test('소비 설정이 요약보다 새로우면 지난날 요약에도 화면 칸을 다시 채우고, 내용이 같으면 수정 시각만 올린다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([{ ...notification('first'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' }]), spendingDir: directory, logger: quietLogger });
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  const before = JSON.parse(readFileSync(summaryPath, 'utf8')).entries[0];
  assert.deepEqual([before.instrument, before.fixedCost, before.categoryGuess], [null, null, null]);
  utimesSync(summaryPath, new Date(1000), new Date(1000));
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ recipientDecisions: [],
    merchantCategories: [{ merchant: '가상식당', category: '식비' }] }));
  await ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory, logger: quietLogger });
  assert.deepEqual(JSON.parse(readFileSync(summaryPath, 'utf8')).entries[0].categoryGuess,
    { category: '식비', subcategory: null, via: 'owner' });
  const settingsPath = join(directory, 'settings.json');
  utimesSync(summaryPath, new Date(1000), new Date(1000));
  utimesSync(settingsPath, new Date(2000), new Date(2000));
  const content = readFileSync(summaryPath, 'utf8');
  await ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory, logger: quietLogger });
  assert.equal(readFileSync(summaryPath, 'utf8'), content);
  assert.ok(statSync(summaryPath).mtimeMs > 2000, '같은 내용이면 다시 쓰지 않고 수정 시각만 올려 다음 회차 후보에서 빠진다');
});

test('보강 판이 없는 옛 요약은 원문·설정보다 새로워도 다시 계산해 화면 칸을 채운다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([{ ...notification('first'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' }]), spendingDir: directory, logger: quietLogger });
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  const old = JSON.parse(readFileSync(summaryPath, 'utf8'));
  delete old.enrichmentVersion;
  for (const entry of old.entries) { delete entry.instrument; delete entry.fixedCost; delete entry.categoryGuess; }
  writeFileSync(summaryPath, `${JSON.stringify(old, null, 2)}\n`);
  const future = new Date(Date.now() + 60_000);
  utimesSync(summaryPath, future, future);
  const logs = [];
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ recipientDecisions: [], fixedCosts: [{ name: 'x' }] }));
  utimesSync(join(directory, 'settings.json'), new Date(0), new Date(0));
  await ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory, logger: { log: (line) => logs.push(line) } });
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.enrichmentVersion, 1);
  assert.ok('categoryGuess' in summary.entries[0]);
  assert.match(logs.at(-1), /enrichmentProblems=fixedCosts/, '깨진 설정 칸은 로그로 드러난다');
});

test('요약 재계산은 원문 잠금이 풀릴 때까지 기다린다', async (t) => {
  const directory = fixture(t);
  await ingestSpendingInbox({ db: fakeDb([{ ...notification('first'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당' }]), spendingDir: directory, logger: quietLogger });
  const rawPath = join(directory, '2026', '2026-10-10.jsonl');
  const summaryPath = join(directory, '2026', '2026-10-10.summary.json');
  appendFileSync(rawPath, `${JSON.stringify({ ...notification('second'), sender: '하나카드',
    body: '사용금액 : 1,500원\n가맹점 : 가상식당' })}\n`, 'utf8');
  utimesSync(summaryPath, new Date(0), new Date(0));

  let retry;
  await withLock(rawPath, async () => {
    retry = ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory, logger: quietLogger });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 2500);
  });
  await retry;
  assert.equal(JSON.parse(readFileSync(summaryPath, 'utf8')).total, 4000);
});

test('손상된 다른 날짜 파일 항목은 유효한 요약 복구를 막지 않는다', async (t) => {
  const directory = fixture(t);
  const yearDir = join(directory, '2026');
  mkdirSync(yearDir);
  writeFileSync(join(yearDir, '2026-10-10.jsonl'), `${JSON.stringify({
    ...notification('payment'), sender: '하나카드',
    body: '사용금액 : 2,500원\n가맹점 : 가상식당',
  })}\n`, 'utf8');
  symlinkSync(join(yearDir, 'missing.jsonl'), join(yearDir, '2026-10-09.jsonl'));

  const result = await ingestSpendingInbox({ db: fakeDb([]), spendingDir: directory,
    logger: quietLogger });
  assert.equal(result.failed, 0);
  assert.equal(JSON.parse(readFileSync(join(yearDir, '2026-10-10.summary.json'), 'utf8')).total, 2500);
});

test('KST 자정 양쪽은 각 문서 ts의 날짜에 저장한다', async (t) => {
  const directory = fixture(t);
  const db = fakeDb([
    notification('before', '2026-10-10 23:59:59'),
    notification('after', '2026-10-11 00:00:00'),
  ]);
  await ingestSpendingInbox({ db, spendingDir: directory, logger: quietLogger });
  assert.deepEqual(lines(directory, '2026-10-10').map((line) => line.id), ['before']);
  assert.deepEqual(lines(directory, '2026-10-11').map((line) => line.id), ['after']);
});
