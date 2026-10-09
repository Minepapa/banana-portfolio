import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
