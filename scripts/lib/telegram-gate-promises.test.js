import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactPromiseLines, createPromiseStore, describeTrigger, MAX_PENDING, writeVaultFile, promiseExpiredBody, promiseMet, promiseNotifyBody, triggerMet, validatePromiseInput, validateTrigger } from './telegram-gate-promises.mjs';
import { createPromiseRunner } from './telegram-gate-promise-runner.mjs';

// 임시 폴더·가짜 시계만 쓴다. 실제 볼트·텔레그램·claude를 건드리지 않는다.
const NOW = new Date('2026-10-30T05:00:00Z');
const JOBS = ['media-audio', 'weekly-report'];

test('validateTrigger: 시각(7일 안)·잡(아는 이름, ok·fail·any)·파일(볼트 상대, 금고 제외)', () => {
  assert.deepEqual(validateTrigger({ type: 'time', at: '2026-10-30T18:00:00+09:00' }, { now: NOW, knownJobs: JOBS }), { type: 'time', at: '2026-10-30T09:00:00.000Z' });
  assert.deepEqual(validateTrigger({ type: 'job', job: 'media-audio' }, { now: NOW, knownJobs: JOBS }), { type: 'job', job: 'media-audio', status: 'any' });
  assert.deepEqual(validateTrigger({ type: 'file', path: '40_Projects/x/a.md' }, { now: NOW, knownJobs: JOBS }), { type: 'file', path: '40_Projects/x/a.md' });
  for (const bad of [{ type: 'llm-run' }, { type: 'time', at: 'x' }, { type: 'time', at: '2026-11-10T00:00:00Z' }, { type: 'job', job: 'nope' },
    { type: 'job', job: 'media-audio', status: 'maybe' }, { type: 'file', path: '/etc/passwd' }, { type: 'file', path: '../x' }, { type: 'file', path: '99_Room/a' }]) {
    assert.throws(() => validateTrigger(bad, { now: NOW, knownJobs: JOBS }), Error, JSON.stringify(bad));
  }
});

test('validatePromiseInput: 문구·담당·행동 정규화, 기한 7일', () => {
  const p = validatePromiseInput({ text: ' 밤 전사 끝나면 알려줘 ', trigger: { type: 'job', job: 'media-audio', status: 'ok' }, action: 'llm' }, { now: NOW, knownJobs: JOBS, uuid: () => 'abcdef123' });
  assert.equal(p.id, 'P-20261030-abcdef');
  assert.equal(p.text, '밤 전사 끝나면 알려줘');
  assert.equal(p.by, 'zeus');
  assert.equal(p.action, 'llm');
  assert.equal(p.expiresAt, '2026-11-06T05:00:00.000Z');
  assert.throws(() => validatePromiseInput({ text: '', trigger: { type: 'time', at: NOW.toISOString() } }, { now: NOW, knownJobs: JOBS }), /1~300자/);
  assert.throws(() => validatePromiseInput({ text: 'x', trigger: { type: 'time', at: NOW.toISOString() }, agent: 'apollo' }, { now: NOW, knownJobs: JOBS }), /미등록 담당/);
});

test('조건 판정: 시각 도달, 잡·파일은 약속 뒤에 일어난 일만, or는 둘 중 하나', () => {
  const since = NOW.getTime();
  const ctx = (over = {}) => ({ now: NOW, since, jobHealth: () => null, fileMtime: () => null, ...over });
  assert.equal(triggerMet({ type: 'time', at: '2026-10-30T04:59:00Z' }, ctx()), true);
  assert.equal(triggerMet({ type: 'time', at: '2026-10-30T05:01:00Z' }, ctx()), false);
  const ran = (status, at = '2026-10-30T05:30:00Z') => ({ jobHealth: () => ({ lastRun: at, status }) });
  assert.equal(triggerMet({ type: 'job', job: 'a', status: 'ok' }, ctx(ran('OK'))), true);
  assert.equal(triggerMet({ type: 'job', job: 'a', status: 'ok' }, ctx(ran('FAIL'))), false);
  assert.equal(triggerMet({ type: 'job', job: 'a', status: 'fail' }, ctx(ran('FAIL'))), true);
  assert.equal(triggerMet({ type: 'job', job: 'a', status: 'any' }, ctx(ran('OK', '2026-10-30T04:00:00Z'))), false, '약속 전에 돈 것은 세지 않음');
  assert.equal(triggerMet({ type: 'file', path: 'a.md' }, ctx({ fileMtime: () => since + 1 })), true);
  assert.equal(triggerMet({ type: 'file', path: 'a.md' }, ctx({ fileMtime: () => since - 1 })), false);
  const promise = { createdAt: NOW.toISOString(), trigger: { type: 'job', job: 'a', status: 'ok' }, or: { type: 'time', at: '2026-10-30T04:00:00Z' } };
  assert.equal(promiseMet(promise, { now: NOW, jobHealth: () => null, fileMtime: () => null }), true);
});

test('고정 문구: 조건을 사람 말로, 이행·만료 본문', () => {
  assert.equal(describeTrigger({ type: 'job', job: 'media-audio', status: 'ok' }), 'media-audio 잡이 성공하면');
  assert.equal(describeTrigger({ type: 'file', path: 'a.md' }), 'a.md가 바뀌면');
  assert.equal(describeTrigger({ type: 'time', at: '2026-10-30T09:05:00Z' }), '10/30 18:05이 되면');
  const p = { text: '전사 끝', createdAt: NOW.toISOString(), trigger: { type: 'job', job: 'media-audio', status: 'any' } };
  assert.match(promiseNotifyBody(p), /^<blockquote>전사 끝<\/blockquote>\n약속한 일을 알려 드립니다\.\n· 조건: media-audio 잡이 돌면/);
  assert.match(promiseExpiredBody({ ...p, or: { type: 'file', path: 'a.md' } }), /기한\(7일\) 안에[\s\S]*또는 a\.md가 바뀌면/);
  assert.match(promiseNotifyBody({ ...p, text: '<a href="x">링크</a>' }), /&lt;a href="x"&gt;링크&lt;\/a&gt;/, 'LLM 문구는 이스케이프');
});

function withStore(fn, nowFn = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-promise-'));
  const store = createPromiseStore({ vaultFile: join(dir, 'vault', 'promises.jsonl'), requestDir: join(dir, 'state', 'promise-requests'), now: nowFn });
  return Promise.resolve(fn(store, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('저장소: 요청(파일 하나씩) → 데몬이 대기열로 옮김, 지우기 전에 멈춰 다시 읽어도 한 번만, 취소·거절', () => withStore((store, dir) => {
  const { uuid } = store.request({ kind: 'add', input: { text: 'A', trigger: { type: 'time', at: '2026-10-30T06:00:00Z' } } });
  store.request({ kind: 'add', input: { text: 'B', trigger: { type: 'job', job: 'nope' } } });
  const requestDir = join(dir, 'state', 'promise-requests');
  const saved = readdirSync(requestDir).map((n) => [n, readFileSync(join(requestDir, n))]);
  const first = store.ingest({ knownJobs: JOBS });
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0].id.endsWith(uuid.slice(0, 6)), true, 'MCP가 정한 uuid로 id가 정해진다');
  assert.equal(first.rejected.length, 1);
  assert.match(first.rejected[0].reason, /모르는 잡/);
  assert.equal(existsSync(join(dir, 'vault', 'promises.jsonl')), false, 'flush 전에는 볼트에 쓰지 않음');
  store.flush();
  store.removeRequests([...first.consumed, ...first.rejectedPaths]);
  assert.equal(readdirSync(requestDir).length, 0, '반영한 요청 파일은 지운다');
  // 요청 파일을 지우기 전에 멈춘 상황을 흉내: 같은 요청 파일을 되살려 다시 읽는다.
  for (const [n, buf] of saved) writeFileSync(join(requestDir, n), buf);
  store.ingest({ knownJobs: JOBS });
  store.flush();
  assert.equal(store.list().length, 1, '같은 요청(uuid)은 한 번만');
  const id = store.pending()[0].promise.id;
  store.request({ kind: 'cancel', id });
  assert.deepEqual(store.ingest({ knownJobs: JOBS }).cancelled, [id]);
  store.flush();
  assert.equal(store.pending().length, 0);
  assert.equal(store.list()[0].status, '취소');
  assert.equal(existsSync(join(dir, 'vault', 'promises.jsonl')), true);
}));

test('저장소: 대기 약속은 최대 20건', () => withStore((store) => {
  for (let i = 0; i < MAX_PENDING + 2; i += 1) store.request({ kind: 'add', input: { text: `T${i}`, trigger: { type: 'time', at: '2026-10-31T00:00:00Z' } } }, { uuid: `u${String(i).padStart(5, '0')}x`, requestedAt: `2026-10-30T05:00:${String(i).padStart(2, '0')}.000Z` });
  const r = store.ingest({ knownJobs: JOBS });
  assert.equal(r.added.length, MAX_PENDING);
  assert.equal(r.rejected.length, 2);
}));

function runnerWith(store, over = {}) {
  const sent = [];
  const runner = createPromiseRunner({
    store, knownJobs: JOBS, jobHealth: () => null, fileMtime: () => null,
    send: async (m) => { if (over.sendFail) throw new Error('down'); sent.push(m); }, chatId: '1',
    runLlm: over.runLlm ?? (() => null), cooldown: over.cooldown ?? (() => null), now: over.now ?? (() => NOW), log: () => {},
  });
  return { runner, sent };
}

test('이행기: 시각 조건 충족 → 고정 문구(가는 선)로 알리고 이행, 아직이면 대기', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '6시에 알려줘', trigger: { type: 'time', at: '2026-10-30T06:00:00Z' } } });
  let clock = NOW;
  const { runner, sent } = runnerWith(store, { now: () => clock });
  assert.deepEqual(await runner.tick(), { added: 1, fired: 0, expired: 0, rejected: 0 });
  assert.equal(runner.summary().pending, 1);
  assert.equal(runner.summary().nextAt, '2026-10-30T06:00:00.000Z');
  clock = new Date('2026-10-30T06:00:30Z');
  assert.equal((await runner.tick()).fired, 1);
  assert.equal(sent[0].topic, '약속');
  assert.equal(sent[0].kind, '정보');
  assert.match(sent[0].body, /6시에 알려줘/);
  assert.equal(store.list()[0].status, '이행');
}));

test('이행기: LLM 약속은 대화 줄이 바쁘면 다음 점검, 쿨다운이면 고정 문구, LLM 실패면 고정 문구로라도 지킨다', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '맥락 설명', action: 'llm', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  let busy = true;
  let llmResult = { status: '완료' };
  const calls = [];
  const { runner, sent } = runnerWith(store, { runLlm: (p) => { calls.push(p.id); return busy ? null : Promise.resolve(llmResult); } });
  await runner.tick();
  assert.equal(store.pending().length, 1, '바쁘면 다음 점검');
  busy = false;
  await runner.tick();
  assert.equal(store.list()[0].status, '이행');
  assert.equal(sent.length, 0, 'LLM이 보고했으니 고정 문구는 없음');
  // LLM 실패 → 고정 문구
  store.request({ kind: 'add', input: { text: '두 번째', action: 'llm', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  llmResult = { status: '실패' };
  await runner.tick();
  assert.match(sent.at(-1).body, /두 번째/);
}));

test('이행기: 쿨다운 중 LLM 약속은 LLM을 부르지 않고 고정 문구', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '한도 중', action: 'llm', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  let called = 0;
  const { runner, sent } = runnerWith(store, { cooldown: () => ({ resetAt: 1 }), runLlm: () => { called += 1; return Promise.resolve({ status: '완료' }); } });
  await runner.tick();
  assert.equal(called, 0);
  assert.match(sent[0].body, /한도 중/);
}));

test('이행기: 기한이 지나면 만료로 닫고 한 번 알린다, 알림 실패 5번이면 실패로 닫는다', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '안 올 일', trigger: { type: 'job', job: 'weekly-report' } } });
  let clock = NOW;
  const { runner, sent } = runnerWith(store, { now: () => clock });
  await runner.tick();
  clock = new Date(NOW.getTime() + 8 * 86_400_000);
  assert.equal((await runner.tick()).expired, 1);
  assert.match(sent.at(-1).body, /기한\(7일\)/);
  assert.equal(store.list()[0].status, '만료');
  await runner.tick();
  assert.equal(sent.length, 1, '만료 알림은 한 번');

}));

test('이행기: 이행 알림이 5번 실패하면 실패로 닫는다', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '실패할 알림', trigger: { type: 'time', at: NOW.toISOString() } } });
  const failing = runnerWith(store, { sendFail: true }).runner;
  for (let i = 0; i < 5; i += 1) await failing.tick();
  assert.equal(store.list().find((p) => p.promise.text === '실패할 알림').status, '실패');
}));

test('이행기: 한 번에 하나만(겹친 점검은 건너뜀), 거절된 요청은 오너에게 알린다', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: 'x', trigger: { type: 'job', job: 'nope' } } });
  const { runner, sent } = runnerWith(store);
  const [a, b] = await Promise.all([runner.tick(), runner.tick()]);
  assert.ok(a.skipped || b.skipped);
  assert.match(sent[0].body, /약속을 받아 두지 못했습니다\.\n· 사유: 모르는 잡/);
}));

test('KST 기준: 시간대 없는 시각은 KST로 읽고, 약속 id 날짜는 KST 자정 경계를 따른다', () => {
  assert.equal(validateTrigger({ type: 'time', at: '2026-10-30T18:00' }, { now: NOW, knownJobs: JOBS }).at, '2026-10-30T09:00:00.000Z');
  assert.equal(validateTrigger({ type: 'time', at: '2026-10-30T18:00:00Z' }, { now: NOW, knownJobs: JOBS }).at, '2026-10-30T18:00:00.000Z', '시간대가 있으면 그대로');
  const before = validatePromiseInput({ text: 'x', trigger: { type: 'time', at: '2026-10-31T09:00' } }, { now: new Date('2026-10-30T14:59:00Z'), knownJobs: JOBS, uuid: () => 'aaaaaa' });
  const after = validatePromiseInput({ text: 'x', trigger: { type: 'time', at: '2026-10-31T09:00' } }, { now: new Date('2026-10-30T15:00:00Z'), knownJobs: JOBS, uuid: () => 'bbbbbb' });
  assert.equal(before.id, 'P-20261030-aaaaaa', 'KST 23:59');
  assert.equal(after.id, 'P-20261031-bbbbbb', 'KST 00:00');
  // 기한은 만든 시각부터 정확히 7일(경계: 그 순간부터 만료).
  assert.equal(after.expiresAt, '2026-11-06T15:00:00.000Z');
});

test('validateTrigger: 날짜만 있는 시각·빈 경로는 거부한다', () => {
  assert.throws(() => validateTrigger({ type: 'time', at: '2026-10-30' }, { now: NOW, knownJobs: JOBS }), /날짜와 시각이 있는/);
  assert.throws(() => validateTrigger({ type: 'file', path: '' }, { now: NOW, knownJobs: JOBS }), /볼트 안 상대 경로/);
  assert.throws(() => validateTrigger({ type: 'file', path: '.' }, { now: NOW, knownJobs: JOBS }), /볼트 안 상대 경로/);
});

test('safeReason: 검사 오류만 그대로, 그 밖의 예외는 감춘다', async () => {
  const { safeReason } = await import('./telegram-gate-promises.mjs');
  assert.equal(safeReason(new Error('모르는 잡: x')), '모르는 잡: x');
  assert.equal(safeReason(new RangeError('Invalid time value')), '요청 형식 오류');
});

test('이행기: 발송 뒤 볼트 기록이 실패해도 다시 보내지 않고 기록만 다시 한다', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '한 번만', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  const real = store.markStatuses.bind(store);
  let failWrites = 2;
  store.markStatuses = (entries) => { if (failWrites > 0) { failWrites -= 1; throw new Error('disk'); } return real(entries); };
  const { runner, sent } = runnerWith(store);
  await runner.tick();
  await runner.tick();
  await runner.tick();
  assert.equal(sent.filter((m) => m.topic === '약속').length, 1, '알림은 한 번');
  assert.equal(store.list()[0].status, '이행');
}));

test('이행기: LLM 이행 예외·쿨다운 거절이면 고정 문구, LLM은 약속마다 한 번만', () => withStore(async (store) => {
  store.request({ kind: 'add', input: { text: '예외', action: 'llm', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  store.request({ kind: 'add', input: { text: '거절', action: 'llm', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  let calls = 0;
  const { runner, sent } = runnerWith(store, { runLlm: (p) => { calls += 1; return p.text === '예외' ? Promise.reject(new Error('spawn')) : Promise.resolve({ status: '완료', refused: true }); } });
  await runner.tick();
  assert.equal(calls, 2);
  assert.deepEqual(sent.map((m) => /예외|거절/.exec(m.body)[0]).sort(), ['거절', '예외']);
  assert.equal(store.pending().length, 0);
}));

test('볼트 쓰기는 점검당 한 번, 파일 전체 재작성(덧붙이지 않음)', () => withStore(async (store, dir) => {
  const writes = [];
  const counting = createPromiseStore({ vaultFile: join(dir, 'v2', 'p.jsonl'), requestDir: join(dir, 'r2'), now: () => NOW,
    writeFile: (path, text) => { writes.push(text); writeFileSync(path, text); } });
  counting.request({ kind: 'add', input: { text: 'A', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  counting.request({ kind: 'add', input: { text: 'B', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  const { runner } = runnerWith(counting);
  await runner.tick();
  assert.equal(writes.length, 1, '추가 2건 + 이행 2건을 한 번에');
  assert.equal(writes[0].trim().split('\n').length, 4);
  assert.deepEqual(counting.list().map((p) => p.status), ['이행', '이행']);
}));

test('재시작에도 다시 보내지 않는다: 보낸 기록(볼트 밖 파일)이 남아 있으면 볼트 기록만 한다', () => withStore(async (store, dir) => {
  const { createFiredLog } = await import('./telegram-gate-promise-runner.mjs');
  const firedPath = join(dir, 'fired.json');
  store.request({ kind: 'add', input: { text: '한 번만', trigger: { type: 'time', at: '2026-10-30T04:00:00Z' } } });
  // 1차: 볼트 쓰기가 모두 실패(보내긴 했음)
  const failing = createPromiseStore({ vaultFile: join(dir, 'vault', 'promises.jsonl'), requestDir: join(dir, 'state', 'promise-requests'), now: () => NOW,
    writeFile: () => { throw new Error('disk'); } });
  const sent = [];
  const make = (s2) => createPromiseRunner({ store: s2, knownJobs: JOBS, jobHealth: () => null, fileMtime: () => null, send: async (m) => sent.push(m),
    chatId: '1', runLlm: () => null, cooldown: () => null, now: () => NOW, log: () => {}, firedLog: createFiredLog(firedPath) });
  await make(failing).tick();
  assert.equal(sent.length, 1);
  assert.equal(existsSync(firedPath), true);
  // 2차: 관문 재시작(새 이행기·새 저장소, 같은 보낸 기록 파일) — 다시 보내지 않고 볼트에만 적는다.
  const healthy = createPromiseStore({ vaultFile: join(dir, 'vault', 'promises.jsonl'), requestDir: join(dir, 'state', 'promise-requests'), now: () => NOW });
  await make(healthy).tick();
  await make(healthy).tick();
  assert.equal(sent.length, 1, '재시작 뒤에도 알림은 한 번');
  assert.equal(healthy.list()[0].status, '이행');
  assert.equal(JSON.parse(readFileSync(firedPath, 'utf8'))[healthy.list()[0].promise.id], undefined, '기록 뒤 보낸 기록에서 지움');
}));

test('볼트 쓰기: 바뀐 내용이 없으면 0회, 있으면 rename 1회(점 임시 파일, 남지 않음)', () => withStore(async (store, dir) => {
  const vdir = join(dir, 'v3');
  const writes = [];
  const s3 = createPromiseStore({ vaultFile: join(vdir, 'p.jsonl'), requestDir: join(dir, 'r3'), now: () => NOW,
    writeFile: (path, text) => { writes.push(path); writeVaultFile(path, text); } });
  assert.equal(s3.flush(), 0, '버퍼가 비면 쓰지 않음');
  s3.request({ kind: 'add', input: { text: 'A', trigger: { type: 'time', at: '2026-10-30T09:00:00Z' } } });
  s3.ingest({ knownJobs: JOBS });
  s3.flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(readdirSync(vdir), ['p.jsonl'], '임시 파일이 남지 않음');
  // 다시 읽은 요청(이미 저장된 id)은 버퍼에 안 들어가고, 같은 상태 재기록처럼 내용이 같으면 쓰지 않는다.
  s3.ingest({ knownJobs: JOBS });
  s3.flush();
  assert.equal(writes.length, 1, '다시 읽은 요청은 쓰기 없음');
}));

test('writeVaultFile: 같은 폴더의 점 파일에 쓰고 rename, 중간 실패면 원본 그대로·임시 파일 정리', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-vw-'));
  try {
    const file = join(dir, 'p.jsonl');
    writeFileSync(file, 'old\n');
    writeVaultFile(file, 'new\n');
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
    assert.deepEqual(readdirSync(dir), ['p.jsonl']);
    // rename 대상이 폴더면 rename이 실패한다 → 원본(폴더)도 그대로, 점 임시 파일도 지워짐.
    const blocked = join(dir, 'blocked');
    mkdirSync(join(blocked, 'child'), { recursive: true });
    assert.throws(() => writeVaultFile(blocked, 'x'));
    assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'p.jsonl'], '임시 파일이 남지 않음');
    assert.equal(readFileSync(file, 'utf8'), 'new\n', '원본 그대로');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flush 중 쓰기 실패: 원본 볼트 파일은 그대로, 요청 파일은 남아 다음 점검에 다시 반영', () => withStore(async (store, dir) => {
  const vfile = join(dir, 'v4', 'p.jsonl');
  const ok = createPromiseStore({ vaultFile: vfile, requestDir: join(dir, 'r4'), now: () => NOW });
  ok.request({ kind: 'add', input: { text: 'A', trigger: { type: 'time', at: '2026-10-30T09:00:00Z' } } });
  const first = ok.ingest({ knownJobs: JOBS });
  ok.flush();
  ok.removeRequests(first.consumed);
  const original = readFileSync(vfile, 'utf8');
  const failing = createPromiseStore({ vaultFile: vfile, requestDir: join(dir, 'r4'), now: () => NOW,
    writeFile: (path, text) => writeVaultFile(join(path, 'no-such-dir', 'x'), text) });
  failing.request({ kind: 'add', input: { text: 'B', trigger: { type: 'time', at: '2026-10-30T09:00:00Z' } } });
  failing.ingest({ knownJobs: JOBS });
  assert.throws(() => failing.flush());
  assert.equal(readFileSync(vfile, 'utf8'), original, '원본 그대로');
  assert.equal(readdirSync(join(dir, 'r4')).filter((n) => n.endsWith('.json')).length, 1, '요청 파일 남음');
  ok.ingest({ knownJobs: JOBS });
  ok.flush();
  assert.equal(ok.list().length, 2);
}));

test('compactPromiseLines: 줄 수가 한도를 넘을 때만, 30일 지난 완료 건만 빼고 대기 건은 남긴다', () => {
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(NOW.getTime() - 40 * day).toISOString();
  const recent = new Date(NOW.getTime() - 2 * day).toISOString();
  const lines = [
    { type: 'promise', id: 'P-old', createdAt: old }, { type: 'status', id: 'P-old', status: '이행', at: old },
    { type: 'promise', id: 'P-recent', createdAt: recent }, { type: 'status', id: 'P-recent', status: '만료', at: recent },
    { type: 'promise', id: 'P-wait', createdAt: old },
  ];
  assert.equal(compactPromiseLines(lines, { now: NOW, limit: 10 }), lines, '한도 안이면 그대로');
  assert.deepEqual(compactPromiseLines(lines, { now: NOW, limit: 2 }).map((l) => l.id), ['P-recent', 'P-recent', 'P-wait']);
});

test('flush가 정리(compact)도 같은 한 번의 쓰기로 한다', () => withStore(async (store, dir) => {
  const vfile = join(dir, 'v5', 'p.jsonl');
  const old = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const seed = [];
  for (let i = 0; i < 300; i += 1) seed.push({ type: 'promise', id: `P-o${i}`, createdAt: old }, { type: 'status', id: `P-o${i}`, status: '이행', at: old });
  mkdirSync(join(dir, 'v5'));
  writeFileSync(vfile, seed.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const writes = [];
  const s5 = createPromiseStore({ vaultFile: vfile, requestDir: join(dir, 'r5'), now: () => NOW,
    writeFile: (path, text) => { writes.push(text); writeVaultFile(path, text); } });
  s5.request({ kind: 'add', input: { text: 'new', trigger: { type: 'time', at: '2026-10-30T09:00:00Z' } } });
  s5.ingest({ knownJobs: JOBS });
  s5.flush();
  assert.equal(writes.length, 1);
  assert.equal(readFileSync(vfile, 'utf8').trim().split('\n').length, 1, '오래된 완료 600줄 정리 + 새 약속 1줄');
  assert.equal(s5.pending().length, 1);
}));
