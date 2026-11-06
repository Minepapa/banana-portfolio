import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { PHOTO_TEXT_PROMPT_VERSION } from '../lib/mine-photo-scene.mjs';
import { applyPhotoAnswers, buildAmbiguousSheet, pendingPhotoAmbiguous, photoOwnerFields } from './mine-photo-ambiguous.mjs';

const rules = [{ type: 'media', path: '20_Records/24_Media/{YYYY}/', pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2} \S/, required: { bundle: ['type', 'category', 'description'], extra: [] } }];
const note = (day) => `---\ntype: "media"\ncategory: ["[[01_Home/201 미네]]"]\ndescription: "미네 순간"\nmodified: "2025-05-${day}"\noccurred: "2025-05-${day}T14:00:00+09:00"\norigin: "phone"\nmediaCount: 2\nmineAge: 9\n---\n사진\n`;
const row = (id, rel, status, extra = {}) => ({ mode: 'orb', id, rel, status, engine: 'claude', model: 'sonnet', promptVersion: PHOTO_TEXT_PROMPT_VERSION,
  photos: [{ id: `${id}-p`, path: `Imports/${id}.jpg`, faceBox: [10, 10, 50, 50] }], ...extra });
const quiet = { log() {}, error() {} };

test('pendingPhotoAmbiguous: 순간마다 마지막 줄(지금 판 Claude·오너)이 애매함이고 대표 사진이 있을 때만', () => {
  const rows = [row('a', 'r/a.md', 'ambiguous'), row('b', 'r/b.md', 'ambiguous'), { ...row('b', 'r/b.md', 'applied'), engine: 'owner' },
    row('c', 'r/c.md', 'ambiguous', { promptVersion: 'photo-text/claude-0.1' }), row('d', 'r/d.md', 'ambiguous', { photos: [] }),
    { ...row('e', 'r/e.md', 'ambiguous'), mode: undefined }];
  assert.deepEqual(pendingPhotoAmbiguous(rows).map((r) => r.id), ['a']);
});

test('사진 애매함 시트 → 오너 답 반영: 순간 노트 감정 필드만 쓰고 백업·오너 줄, 다음 시트에서 빠진다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'photo-ambiguous-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'), out = join(base, 'out'), ledgerPath = join(base, 'ledger.jsonl');
  mkdirSync(join(root, '20_Records/24_Media/2025'), { recursive: true });
  const [one, two] = ['10', '11'].map((day) => `20_Records/24_Media/2025/2025-05-${day} 공원 순간.md`);
  writeFileSync(join(root, one), note('10'));
  writeFileSync(join(root, two), note('11'));
  writeFileSync(ledgerPath, `${[row('m1', one, 'ambiguous'), row('m2', two, 'ambiguous')].map((r) => JSON.stringify(r)).join('\n')}\n`);
  const copied = [];
  const photo = (source) => { copied.push(source); return { dataUrl: 'data:image/jpeg;base64,QUJD', upright: { width: 100, height: 100 } }; };
  const now = new Date('2026-11-08T23:00:00Z');
  const sheet = buildAmbiguousSheet({ root, mediaRoot: '/media', ledgerPath, out, now, criteria: fixtureCriteria, photo, output: quiet });
  assert.equal(sheet.cards.length, 2);
  assert.deepEqual(copied, ['/media/Imports/m1.jpg', '/media/Imports/m2.jpg']);
  const html = readFileSync(sheet.sheetPath, 'utf8');
  assert.match(html, /미네 사진 애매함 검수[\s\S]*QUJD[\s\S]*left:10%/);
  assert.equal(html.includes('/media/'), false, '시트에 원본 경로를 넣지 않는다');
  assert.match(sheet.cardsPath, /photo-ambiguous-2026-11-09-08-00\/cards-photo-ambiguous-2026-11-09-08-00\.json$/);
  const title = (rel) => rel.split('/').pop().replace(/\.md$/, '');
  const answersPath = join(base, 'photo-answers-ambiguous-2026-11-09-08-00 (1).json');
  writeFileSync(answersPath, JSON.stringify({ 1: { t: title(one), id: 'm1', read: '예', state: '있음', emo: '기쁨', int: '1' }, 2: { t: title(two), read: '아니오', state: '모름' } }));
  const opts = { answersPath, cardsPath: sheet.cardsPath, root, out, ledgerPath, rules, criteria: fixtureCriteria, now, output: quiet };
  assert.deepEqual((await applyPhotoAnswers({ ...opts, dryRun: true })).applied.length, 2);
  assert.equal(readFileSync(join(root, one), 'utf8'), note('10'), 'dry-run은 쓰지 않는다');
  const summary = await applyPhotoAnswers(opts);
  assert.deepEqual([summary.applied.length, summary.errors.length], [2, 0]);
  const written = readFileSync(join(root, one), 'utf8');
  assert.match(written, /^primaryEmotion: "기쁨"$/m);
  assert.match(written, /^emotionIntensity: 1$/m);
  assert.match(written, /^mediaCount: 2$/m, '다른 필드는 그대로');
  assert.match(readFileSync(join(root, two), 'utf8'), /^emotionEvidence: "모름: 오너 판단/m);
  const ledger = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.slice(2).map((r) => [r.mode, r.id, r.engine, r.status]), [['orb', 'm1', 'owner', 'applied'], ['orb', 'm2', 'owner', 'applied']]);
  assert.ok(existsSync(join(out, 'owner-apply-backup-2026-11-09.jsonl')));
  assert.deepEqual(buildAmbiguousSheet({ root, mediaRoot: '/media', ledgerPath, out, now: new Date('2026-11-09T00:00:00Z'), criteria: fixtureCriteria, photo, output: quiet }).cards, []);
  await assert.rejects(applyPhotoAnswers({ ...opts, answersPath: join(base, 'photo-answers-ambiguous-2026-01-01-00-00.json') }), /같은 시트가 아님/);
});

test('사진 오너 답 → 필드: 감정 없음·모름·있음(강도 필수), 다른 경로·제목은 쓰지 않는다', async (t) => {
  assert.deepEqual(photoOwnerFields({ state: '감정 없음' }).emotions, []);
  assert.equal(photoOwnerFields({ state: '있음', emo: '기쁨' }), null, '강도 없이 감정만이면 쓰지 않는다');
  assert.equal(photoOwnerFields(undefined), null);
  const base = mkdtempSync(join(tmpdir(), 'photo-ambiguous-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cardsPath = join(base, 'cards-photo-ambiguous-2026-11-09-08-00.json');
  const answersPath = join(base, 'photo-answers-ambiguous-2026-11-09-08-00.json');
  writeFileSync(cardsPath, JSON.stringify([{ no: 1, rel: '20_Records/23_Conversations/2025/x.md', id: 'a', title: 'x' }, { no: 2, rel: '20_Records/24_Media/2025/y.md', id: 'b', title: 'y' }]));
  writeFileSync(answersPath, JSON.stringify({ 1: { t: 'x', state: '감정 없음' }, 2: { t: 'z', state: '감정 없음' } }));
  const summary = await applyPhotoAnswers({ answersPath, cardsPath, root: base, out: base, ledgerPath: join(base, 'l.jsonl'), rules, criteria: fixtureCriteria, output: quiet });
  assert.deepEqual(summary.errors.map((e) => e.reason.startsWith('순간 노트 경로가 아님') || e.reason.startsWith('답·번호표·노트 제목이 다름')), [true, true]);
});
