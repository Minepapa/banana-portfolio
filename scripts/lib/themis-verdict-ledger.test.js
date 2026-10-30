import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';
import { appendVerdict, buildVerdictRecord, parseVerdictLines, readVerdicts, THEMIS_VERDICTS_PATH } from './themis-verdict-ledger.mjs';
import { run } from '../tools/themis-verdict-cli.mjs';

const NOW = new Date('2026-10-31T00:30:00Z'); // KST 2026-10-31 09:30
const fixedUuid = (() => { let n = 0; return () => `0000000${(n += 1).toString(16)}`.slice(-8).padEnd(32, '0'); })();
const base = { subject: '연금저축 리밸런싱 제안 2차 검증', requestedBy: 'zeus', verdict: '보류', kind: '주문 제안',
  reasons: '2026-10-31 15:40 기준 예수금 확인 전이라 보류', refs: ['40_Projects/banana-portfolio/Requests/2026-10-31 제안.md', 'banana-portfolio-v2@abc1234'] };

function ledger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'themis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'Themis', 'verdicts.jsonl');
}

test('원장 경로는 v2 VAULT_REL.themisVerdicts', () => {
  assert.equal(VAULT_REL.themisVerdicts, '95_Etna/Themis/verdicts.jsonl');
  assert.ok(THEMIS_VERDICTS_PATH.endsWith(join('95_Etna', 'Themis', 'verdicts.jsonl')));
});

test('한 줄 형식: id(KST 날짜)·시각·갈래·대상·요청 담당·판정·근거·참조·기록 담당', () => {
  const record = buildVerdictRecord(base, { now: NOW, uuid: () => 'abcdef12-0000-0000-0000-000000000000' });
  assert.deepEqual(record, {
    schemaVersion: 1, id: 'TV-20261031-abcdef12', at: '2026-10-31T00:30:00.000Z', kind: '주문 제안',
    subject: base.subject, requestedBy: 'zeus', verdict: '보류', reasons: base.reasons,
    refs: ['40_Projects/banana-portfolio/Requests/2026-10-31 제안', 'banana-portfolio-v2@abc1234'], recordedBy: 'zeus',
  });
  // 아이디 날짜는 KST: UTC 16:00 = KST 다음날 01:00
  assert.equal(buildVerdictRecord({ ...base, at: '2026-10-31T16:00:00Z' }, { now: new Date('2026-10-31T16:10:00Z'), uuid: fixedUuid }).id.slice(0, 11), 'TV-20261101');
});

test('형식 거부: 모르는 필드·판정·담당·갈래·빈 값·길이·참조 형식', () => {
  const bad = [
    [{ ...base, extra: 1 }, /모르는 필드/], [{ ...base, verdict: '승인' }, /verdict/], [{ ...base, requestedBy: 'apollo' }, /requestedBy/],
    [{ ...base, kind: '잡담' }, /kind/], [{ ...base, subject: '  ' }, /subject/], [{ ...base, reasons: 'x'.repeat(601) }, /600자/],
    [{ ...base, refs: ['../etc/passwd'] }, /refs/], [{ ...base, refs: ['40_Projects/../x'] }, /refs/], [{ ...base, refs: ['짧은링크'] }, /refs/],
    [{ ...base, recordedBy: 'owner' }, /recordedBy/], [{ ...base, at: 'x' }, /at/],
    [{ ...base, at: 0 }, /at/], [{ ...base, at: 12345 }, /at/], [{ ...base, at: '2026-10-31' }, /시간대/],
    [{ ...base, at: '2026-10-31T12:00:00+09:00' }, /1년/], [{ ...base, at: '2025-01-01T00:00:00Z' }, /1년/],
    [{ ...base, at: '2026-02-30T00:00:00Z' }, /없는 날짜/],
  ];
  for (const [input, message] of bad) assert.throws(() => buildVerdictRecord(input, { now: NOW, uuid: fixedUuid }), message);
});

test('민감값은 가리지 않고 거부한다: 금고 경로·이름·자격증명·계좌·전화·금액·주문번호', () => {
  const secret = ['9', '9', '_Fake'].join('');
  const vaultWord = ['A', 'dyton'].join('');
  const bad = [
    `${secret}/노트 확인`, `${vaultWord} 노트`, 'token=abcd1234', 'Bearer xyz', `키 ${'Q'.repeat(40)}`,
    '계좌 205-01-599999', '가림 205-01-59***9', '계좌 3333-01-1234567', '1234-56-789012', '전화 01012345678',
    '010 1234 5678', '302 1234 5678 91', '금액 15000000원', '주문번호 0000995570',
    'OpenDART 키 0123456789abcdef0123456789abcdef01234567 사용', 'md5 d41d8cd98f00b204e9800998ecf8427e', '20261031-1234567',
    'TV-20261031-01012345 전화', 'token: 만료 확인', '종목코드 005930 000660',
  ];
  for (const text of bad) assert.throws(() => buildVerdictRecord({ ...base, reasons: text }, { now: NOW, uuid: fixedUuid }), /넣을 수 없다/, text);
  for (const ref of [`40_Projects/${secret}/x`, '01012345678', '20501599999912', 'acct@20501599999', '0123456789abcdef0123456789abcdef01234567']) {
    assert.throws(() => buildVerdictRecord({ ...base, refs: [ref] }, { now: NOW, uuid: fixedUuid }), /넣을 수 없다|refs/, ref);
  }
  assert.throws(() => buildVerdictRecord({ ...base, reasons: '금액 15000000원' }, { now: NOW, uuid: fixedUuid }), /금액·주문번호를 쓰지 않는다/);
});

test('정상 근거는 허용: 날짜·시각·압축 날짜·판정 아이디·커밋 해시·콤마 금액·작은 식·미디어 파일명 참조', () => {
  const ok = [
    '2026-10-31T15:40:00+09:00 · 10:05 체결 3주 확인', 'TV-20261031-abcdef12 재검토', '20261031 기준', '커밋 abc1234d 반영',
    '금액 15,000,000원', '비중 0.3*2 계산', '체결 2/8 회차', '종목코드 005930, 000660',
  ];
  for (const text of ok) assert.doesNotThrow(() => buildVerdictRecord({ ...base, reasons: text }, { now: NOW, uuid: fixedUuid }), text);
  for (const ref of ['repo@0123456789abcdef0123456789abcdef01234567', 'abc1234', '95_Etna/Media/20261031_123456']) {
    assert.doesNotThrow(() => buildVerdictRecord({ ...base, refs: [ref] }, { now: NOW, uuid: fixedUuid }), ref);
  }
});

test('덧붙이기: 기존 줄은 글자 그대로, 점 임시 파일이 남지 않는다', async (t) => {
  const path = ledger(t);
  const first = await appendVerdict(base, { path, now: NOW, uuid: fixedUuid });
  const raw = readFileSync(path, 'utf8');
  const second = await appendVerdict({ ...base, verdict: '통과' }, { path, now: NOW, uuid: fixedUuid });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.startsWith(raw));
  assert.deepEqual(readVerdicts(path).map((item) => item.id), [first.id, second.id]);
  assert.deepEqual(readdirSync(join(path, '..')).filter((name) => name !== 'verdicts.jsonl' && !name.endsWith('.lock')), []);
});

test('동시에 여러 건을 써도 하나도 빠지지 않는다(락)', async (t) => {
  const path = ledger(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendVerdict({ ...base, subject: `동시 ${i}` }, { path, now: NOW, lockOptions: { retryDelayMs: 5, retries: 200 } })));
  assert.equal(readVerdicts(path).length, 8);
});

test('기존 줄이 깨져 있으면 쓰지 않고 원본을 그대로 둔다', async (t) => {
  const path = ledger(t);
  await appendVerdict(base, { path, now: NOW, uuid: fixedUuid });
  const broken = `${readFileSync(path, 'utf8')}{깨진 줄\n`;
  writeFileSync(path, broken);
  await assert.rejects(appendVerdict(base, { path, now: NOW, uuid: fixedUuid }), /2째 줄을 읽을 수 없다/);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.throws(() => parseVerdictLines('{"schemaVersion":1,"id":"x","verdict":"통과"}'), /형식 불일치/);
});

test('CLI: append는 stdin JSON 한 건, list는 최근 N건, 잘못된 인자는 거부', async (t) => {
  const path = ledger(t);
  const saved = await run('append', [], { stdin: () => JSON.stringify(base), path });
  assert.equal(saved.verdict, '보류');
  assert.deepEqual((await run('list', ['--limit=5'], { path })).map((item) => item.id), [saved.id]);
  await assert.rejects(run('append', [], { stdin: () => '  ', path }), /stdin/);
  await assert.rejects(run('list', ['--limit=0'], { path }), /limit/);
  await assert.rejects(run('list', ['oops'], { path }), /알 수 없는 인자/);
  await assert.rejects(run('delete', [], { path }), /사용법/);
});

test('쓰기 실패(폴더 쓰기 금지)면 원본은 그대로, 임시 파일도 남지 않는다', async (t) => {
  const path = ledger(t);
  await appendVerdict(base, { path, now: NOW, uuid: fixedUuid });
  const before = readFileSync(path, 'utf8');
  const dir = join(path, '..');
  chmodSync(dir, 0o500);
  try {
    await assert.rejects(appendVerdict(base, { path, now: NOW, uuid: fixedUuid, lockOptions: { retries: 0 } }));
  } finally { chmodSync(dir, 0o700); }
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('아이디가 겹치면 쓰지 않는다, 빈 줄은 그대로 두고 줄 번호는 실제 줄', async (t) => {
  const path = ledger(t);
  const same = () => 'abcdef12-0000-0000-0000-000000000000';
  await appendVerdict(base, { path, now: NOW, uuid: same });
  await assert.rejects(appendVerdict(base, { path, now: NOW, uuid: same }), /겹친다/);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  await appendVerdict(base, { path, now: NOW, uuid: fixedUuid });
  assert.equal(readFileSync(path, 'utf8').split('\n')[1], ''); // 빈 줄 유지
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n{x\n`);
  assert.throws(() => readVerdicts(path), /5째 줄/);
});

test('CLI: 잘못된 JSON·모르는 --키 거부', async (t) => {
  const path = ledger(t);
  await assert.rejects(run('append', [], { stdin: () => '{x', path }), /JSON을 읽을 수 없다/);
  await assert.rejects(run('list', ['--limt=5'], { path }), /알 수 없는 인자/);
  await assert.rejects(run('append', ['--limit=5'], { stdin: () => JSON.stringify(base), path }), /알 수 없는 인자/);
});

test('아이디 꼬리는 늘 a-f를 품는다(숫자만 나온 uuid도)', () => {
  const record = buildVerdictRecord(base, { now: NOW, uuid: () => '01234567-0000-0000-0000-000000000000' });
  assert.match(record.id, /^TV-20261031-(?=[0-9a-f]*[a-f])[0-9a-f]{8}$/);
  assert.doesNotThrow(() => buildVerdictRecord({ ...base, at: '2026-10-31T09:20:00+09:00' }, { now: NOW, uuid: fixedUuid }));
});
