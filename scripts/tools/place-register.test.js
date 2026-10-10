import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { saveCandidates, readCandidates } from '../lib/place-candidates.mjs';
import { registerPlace, validPlaceName } from './place-register.mjs';

const rules = [{ type: 'place', pathRegex: new RegExp(`^${VAULT_REL.places}/[^/]+\\.md$`), path: VAULT_REL.places,
  titleRegex: null, required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'], extra: ['lat', 'lon', 'radius'] } }];
const fixture = (t) => { const root = mkdtempSync(join(tmpdir(), 'd89-place-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  saveCandidates(root, [{ id: 'C3', lat: 12, lon: 34, address: '건물', visits: ['2026-10-07', '2026-10-09'], eventTitles: [], status: '물음', askedAt: '2026-10-09' }]); return root; };

test('이름 검증, dry-run, 등록 및 중복 거부', (t) => {
  const root = fixture(t);
  for (const name of ['bad/name', 'bad:name', 'bad\nname', 'x'.repeat(81)]) assert.equal(validPlaceName(name), false);
  for (const name of ['.숨김', '끝.', '끝 ', 'x#y', 'x|y', 'x^y', 'x[y]', 'x\u007fy', 'x\u2028y', 'x\u2029y']) assert.equal(validPlaceName(name), false);
  assert.match(registerPlace({ candidate: 'C3', name: '헬스장' }, { root, rules, dryRun: true }), /dry-run/);
  const path = join(root, VAULT_REL.places, '헬스장.md');
  assert.equal(existsSync(path), false);
  assert.match(registerPlace({ candidate: 'C3', name: '헬스장' }, { root, rules }), /등록/);
  assert.match(readFileSync(path, 'utf8'), /lat: 12/);
  assert.equal(readCandidates(root)[0].status, '등록');
  assert.throws(() => registerPlace({ candidate: 'C3', name: '헬스장' }, { root, rules }), /등록 대기/);
  const candidates = readCandidates(root);
  candidates.push({ ...candidates[0], id: 'C4', lat: 13, status: '물음' });
  saveCandidates(root, candidates);
  assert.throws(() => registerPlace({ candidate: 'C4', name: '헬스장' }, { root, rules }), /이미/);
  assert.equal(readCandidates(root)[1].status, '물음');
});

test('checkNote가 거부하면 장소 파일과 후보 상태를 그대로 둔다', (t) => {
  const root = fixture(t);
  assert.throws(() => registerPlace({ candidate: 'C3', name: '새 장소' }, { root, rules: [] }), /등록부 위반/);
  assert.equal(existsSync(join(root, VAULT_REL.places, '새 장소.md')), false);
  assert.equal(readCandidates(root)[0].status, '물음');
});

test('제외는 노트 없이 상태만 갱신', (t) => {
  const root = fixture(t);
  assert.match(registerPlace({ candidate: 'C3', exclude: true }, { root, rules }), /제외/);
  assert.equal(readCandidates(root)[0].status, '제외');
  assert.equal(existsSync(join(root, VAULT_REL.places)), false);
});

test('등록중 상태의 같은 좌표 노트는 재시도에서 등록으로 끝낸다', (t) => {
  const root = fixture(t);
  registerPlace({ candidate: 'C3', name: '운동장' }, { root, rules });
  const candidates = readCandidates(root);
  candidates[0].status = '등록중';
  saveCandidates(root, candidates);
  assert.throws(() => registerPlace({ candidate: 'C3', exclude: true }, { root, rules }), /진행 중/);
  assert.match(registerPlace({ candidate: 'C3', name: '운동장' }, { root, rules }), /등록/);
  assert.equal(readCandidates(root)[0].status, '등록');
});

const hereNow = new Date('2026-10-08T15:10:00Z'); // KST 2026-10-09 00:10
const hereOptions = (root, extra = {}) => ({ root, rules, now: hereNow, geocode: async () => ({ address: '테스트 주소' }), ...extra });
function writePoints(root, date, agesMinutes = [2, 4, 6], offsets = [0, 0.00001, -0.00001]) {
  const directory = join(root, VAULT_REL.location, date.slice(0, 4));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${date}.jsonl`), agesMinutes.map((age, index) => JSON.stringify({
    lat: 12 + offsets[index], lon: 34, tst: Math.floor(hereNow.getTime() / 1000) - age * 60, acc: 20,
  })).join('\n') + '\n');
}

test('현재 위치 등록은 어제 점도 읽고 KST 날짜를 기록하며 근처 후보를 정리한다', async (t) => {
  const root = fixture(t);
  const candidates = readCandidates(root);
  candidates.push({ ...candidates[0], id: 'C4', status: '관찰' });
  saveCandidates(root, candidates);
  writePoints(root, '2026-10-08');
  let lookups = 0;
  const output = await registerPlace({ here: true, name: '회사' }, hereOptions(root, {
    geocode: async () => { lookups += 1; return { address: '테스트 주소' }; },
  }));
  assert.equal(output, '회사 등록(현재 위치, 주소: 테스트 주소)');
  assert.equal(lookups, 1);
  const note = readFileSync(join(root, VAULT_REL.places, '회사.md'), 'utf8');
  assert.match(note, /created: "2026-10-09"/);
  assert.match(note, /# 회사\n\n테스트 주소 · 등록 2026-10-09\(현재 위치\)/);
  assert.deepEqual(readCandidates(root).map((candidate) => candidate.status), ['등록', '등록']);
});

test('현재 위치는 부족하거나 오래된 점과 이동 중인 점을 거부한다', async (t) => {
  const root = fixture(t);
  writePoints(root, '2026-10-09', [2, 4]);
  await assert.rejects(registerPlace({ here: true, name: '회사' }, hereOptions(root)), /최근 위치가 부족함/);
  writePoints(root, '2026-10-09', [31, 32, 33]);
  await assert.rejects(registerPlace({ here: true, name: '회사' }, hereOptions(root)), /최근 위치가 부족함/);
  writePoints(root, '2026-10-09', [2, 4, 6], [0, 0.005, -0.005]);
  await assert.rejects(registerPlace({ here: true, name: '회사' }, hereOptions(root)), /이동 중/);
  assert.equal(existsSync(join(root, VAULT_REL.places)), false);
});

test('현재 위치 이름과 입력 조합을 검증하고 등록 장소 근처를 거부한다', async (t) => {
  const root = fixture(t);
  writePoints(root, '2026-10-09');
  await assert.rejects(registerPlace({ here: true, name: 'bad/name' }, hereOptions(root)), /이름 형식/);
  assert.throws(() => registerPlace({ candidate: 'C3', here: true, name: '회사' }, hereOptions(root)), /함께/);
  registerPlace({ candidate: 'C3', name: '기존 장소' }, { root, rules });
  await assert.rejects(registerPlace({ here: true, name: '회사' }, hereOptions(root)), /이미 등록된 장소 근처: 기존 장소/);
});

test('현재 위치 dry-run은 지오코딩과 파일 쓰기를 생략한다', async (t) => {
  const root = fixture(t);
  writePoints(root, '2026-10-09');
  const before = readCandidates(root);
  const output = await registerPlace({ here: true, name: '회사' }, hereOptions(root, {
    dryRun: true, geocode: () => { throw new Error('called'); },
  }));
  assert.match(output, /주소: 주소 미조회.*dry-run/);
  assert.equal(existsSync(join(root, VAULT_REL.places)), false);
  assert.deepEqual(readCandidates(root), before);
});

test('지오코딩 실패에도 주소 미조회로 등록하고 checkNote 실패 시 후보를 유지한다', async (t) => {
  const root = fixture(t);
  writePoints(root, '2026-10-09');
  await assert.rejects(registerPlace({ here: true, name: '회사' }, hereOptions(root, { rules: [] })), /등록부 위반/);
  assert.equal(readCandidates(root)[0].status, '물음');
  const output = await registerPlace({ here: true, name: '회사' }, hereOptions(root, {
    geocode: async () => { throw new Error('offline'); },
  }));
  assert.match(output, /주소: 주소 미조회/);
  assert.match(readFileSync(join(root, VAULT_REL.places, '회사.md'), 'utf8'), /주소 미조회 · 등록/);
});

function writeCorrectionPoints(root) {
  const date = '2026-10-09';
  const directory = join(root, VAULT_REL.location, '2026');
  mkdirSync(directory, { recursive: true });
  const start = Date.parse(`${date}T12:00:00+09:00`) / 1000;
  writeFileSync(join(directory, `${date}.jsonl`), [0, 15, 30].map((minutes) => JSON.stringify({
    tst: start + minutes * 60, lat: 12, lon: 34, acc: 10,
  })).join('\n') + '\n');
}

test('과거 체류 정정은 dry-run 뒤 등록하며 후보와 그날 동선을 갱신한다', async (t) => {
  const root = fixture(t);
  writeCorrectionPoints(root);
  let recomputed = 0;
  const options = hereOptions(root, { recompute: async ({ date, force }) => {
    assert.equal(date, '2026-10-09'); assert.equal(force, true); recomputed += 1;
  } });
  const input = { correct: { date: '2026-10-09', time: '12:15' }, name: '시험 장소' };
  const dry = await registerPlace(input, { ...options, dryRun: true, geocode: () => { throw new Error('network called'); } });
  assert.match(dry, /dry-run/);
  assert.equal(existsSync(join(root, VAULT_REL.places, '시험 장소.md')), false);
  assert.equal(readCandidates(root)[0].status, '물음');
  const output = await registerPlace(input, options);
  assert.match(output, /시험 장소 등록/);
  assert.doesNotMatch(output, /12[,.:]0|34[,.:]0/);
  assert.match(readFileSync(join(root, VAULT_REL.places, '시험 장소.md'), 'utf8'), /created: "2026-10-09"/);
  assert.equal(readCandidates(root)[0].status, '등록');
  assert.equal(recomputed, 1);
  await assert.rejects(registerPlace(input, options), /같은 이름/);
  await assert.rejects(registerPlace({ ...input, name: '다른 장소' }, options), /이미 '시험 장소'으로 표시되는 곳/);
});

test('과거 체류가 없거나 기존 장소인 경우 거부하고 재계산 실패는 등록만 유지한다', async (t) => {
  const root = fixture(t);
  const options = hereOptions(root);
  const input = { correct: { date: '2026-10-09', time: '12:15' }, name: '새 장소' };
  await assert.rejects(registerPlace(input, options), /그 시각에 머문 곳이 없음/);
  writeCorrectionPoints(root);
  await assert.rejects(registerPlace({ ...input, correct: { date: '2026-10-09', time: '11:00' } }, options), /그 시각에 머문 곳이 없음/);
  const output = await registerPlace(input, { ...options, recompute: async () => { throw new Error('recompute failed'); } });
  assert.match(output, /동선 재계산 경고/);
  assert.equal(existsSync(join(root, VAULT_REL.places, '새 장소.md')), true);
  await assert.rejects(registerPlace({ ...input, name: '다른 장소' }, options), /그 장소 노트를 고치세요/);
  await assert.rejects(registerPlace({ ...input, name: 'bad/name' }, options), /이름 형식/);
  assert.throws(() => registerPlace({ ...input, here: true }, options), /함께/);
});

test('장소 등록 뒤 오너 수정으로 동선 재계산을 건너뛰면 경고한다', async (t) => {
  const root = fixture(t);
  writeCorrectionPoints(root);
  const output = await registerPlace({ correct: { date: '2026-10-09', time: '12:15' }, name: '시험 장소' },
    hereOptions(root, { recompute: async () => ({ updated: false, skipped: 'AI 칸을 오너가 수정함' }) }));
  assert.match(output, /등록.*동선 재계산 경고: AI 칸을 오너가 수정함/);
  assert.equal(existsSync(join(root, VAULT_REL.places, '시험 장소.md')), true);
});

test('과거 체류 정정은 주소 조회가 실패해도 캐시를 flush한다', async (t) => {
  const root = fixture(t);
  writeCorrectionPoints(root);
  let flushes = 0;
  const geocode = async () => { throw new Error('offline'); };
  geocode.flush = async () => { flushes += 1; };
  const output = await registerPlace({ correct: { date: '2026-10-09', time: '12:15' }, name: '시험 장소' },
    hereOptions(root, { geocode, recompute: async () => ({ updated: true }) }));
  assert.match(output, /시험 장소 등록/);
  assert.equal(flushes, 1);
  assert.match(readFileSync(join(root, VAULT_REL.places, '시험 장소.md'), 'utf8'), /주소 미조회/);
});
