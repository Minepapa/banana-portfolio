import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTestQuestion, parseTestVaultArgs, seedCalendarSample, seedTestVault, SEED_FILES, testVaultRoot } from './telegram-gate-test-vault.mjs';
import { DEFAULT_VAULT_ROOT } from '../lib/vault-paths.mjs';
import { calendarFacts } from './calendar-facts.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';

// 임시 폴더만 쓴다 — 실제 볼트·질문 큐·텔레그램을 건드리지 않는다.
function withRoots(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-seed-'));
  const source = join(dir, 'source');
  const target = join(dir, 'target');
  try { return fn({ source, target }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('seedTestVault: 구조 파일(등록부·상태표준·채널 규칙)만 복사한다', () => withRoots(({ source, target }) => {
  for (const rel of SEED_FILES) {
    mkdirSync(dirname(join(source, rel)), { recursive: true });
    writeFileSync(join(source, rel), `구조 ${rel}`);
  }
  mkdirSync(join(source, VAULT_REL.inboxRoot), { recursive: true });
  writeFileSync(join(source, VAULT_REL.inboxRoot, '개인 메모.md'), '개인');
  assert.deepEqual(seedTestVault({ sourceRoot: source, targetRoot: target }), [...SEED_FILES]);
  assert.equal(readFileSync(join(target, VAULT_REL.registryFile), 'utf8'), `구조 ${VAULT_REL.registryFile}`);
  assert.equal(existsSync(join(target, VAULT_REL.inboxRoot)), false, '개인 노트 폴더는 복사하지 않음');
  assert.ok(SEED_FILES.every((rel) => rel.startsWith('90_Delphi/Schema/') || rel.startsWith('90_Delphi/Channels/')));
}));

test('seedTestVault: 금고 경로·상위 경로는 거부한다', () => withRoots(({ source, target }) => {
  assert.throws(() => seedTestVault({ sourceRoot: source, targetRoot: target, files: [`${VAULT_REL.adytonRoot}/x.md`] }), /금고 경로/);
  assert.throws(() => seedTestVault({ sourceRoot: source, targetRoot: target, files: [VAULT_REL.adytonRoot] }), /금고 경로/);
  assert.throws(() => seedTestVault({ sourceRoot: source, targetRoot: target, files: ['../밖.md'] }), /올바르지 않은 경로/);
}));

test('createTestQuestion: manual-change 시험 질문을 가짜 발송으로 만든다(네트워크 없음)', async () => {
  const calls = [];
  const create = async (input, { sender }) => {
    const response = await sender({ text: '질문' });
    calls.push({ input, response });
    return { questionId: 'WQ-20261030-ABCDEF01', status: '답변대기' };
  };
  const result = await createTestQuestion({ create });
  assert.equal(result.questionId, 'WQ-20261030-ABCDEF01');
  assert.equal(calls[0].input.kind, 'manual-change');
  assert.equal(calls[0].input.asker, 'zeus');
  assert.deepEqual(calls[0].response, { result: { message_id: 1 } });
});

test('testVaultRoot: 시험 상태 폴더 아래 vault', () => {
  assert.equal(testVaultRoot({ TELEGRAM_GATE_STATE_DIR: '/s' }), '/s/vault');
});

test('일정 샘플: 시험 볼트에 KST 기준 n일치 구조만, 있는 날은 그대로, 실제 볼트 거부, calendar-facts가 읽음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cal-'));
  try {
    const now = new Date('2026-11-03T16:00:00Z'); // 11-04 01:00 KST
    const keep = join(dir, '95_Etna', 'Calendar', '2026', '2026-11-05.json');
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(keep, '{"schemaVersion":1,"date":"2026-11-05","events":[]}\n');
    assert.deepEqual(seedCalendarSample({ targetRoot: dir, now, days: 3 }), ['2026-11-04', '2026-11-06']);
    assert.equal(readFileSync(keep, 'utf8'), '{"schemaVersion":1,"date":"2026-11-05","events":[]}\n');
    const day = JSON.parse(readFileSync(join(dir, '95_Etna', 'Calendar', '2026', '2026-11-04.json'), 'utf8'));
    assert.match(day.events[0].title, /^\[시험\]/);
    assert.deepEqual(seedCalendarSample({ targetRoot: dir, now, days: 3 }), [], '다시 돌려도 새로 쓰지 않음');
    const out = calendarFacts({ now, read: (d) => { try { return JSON.parse(readFileSync(join(dir, '95_Etna', 'Calendar', '2026', `${d}.json`), 'utf8')); } catch { return null; } } });
    assert.match(out, /2026-11-04: 1건\n- 20:00~21:00 \[시험\] \[시험\] 창구 일정 경로 확인용/);
    assert.throws(() => seedCalendarSample({ targetRoot: DEFAULT_VAULT_ROOT, now }), /실제 볼트/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseTestVaultArgs: 인자 없음·--calendar-only만, 모르는 인자 거부(--help 포함)', () => {
  assert.deepEqual(parseTestVaultArgs([]), { calendarOnly: false });
  assert.deepEqual(parseTestVaultArgs(['--calendar-only']), { calendarOnly: true });
  for (const bad of [['--help'], ['--calendar-only', '--x'], ['x']]) assert.ok(parseTestVaultArgs(bad).error);
});
