import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { confirmHoldFaces, holdSampleHash, holdSheetMediaFaces, renderHoldAllSheet } from './media-faces.mjs';

test('통합 시트의 카드 선택은 월별 인물 답 블록과 진행률을 갱신한다', () => {
  const hashes = ['a'.repeat(64), 'b'.repeat(64)];
  const cards = [1, 2, 1].map((number) => ({
    dataset: { number: String(number) }, pressed: 'false',
    getAttribute(name) { return name === 'aria-pressed' ? this.pressed : null; },
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; },
    querySelector() { return this.label ??= { textContent: '아님' }; },
  }));
  const months = [
    { dataset: { hash: hashes[0] }, querySelectorAll: () => cards.slice(0, 2).filter((card) => card.pressed === 'true') },
    { dataset: { hash: hashes[1] }, querySelectorAll: () => cards.slice(2).filter((card) => card.pressed === 'true') },
  ];
  const elements = { progress: {}, result: {}, copy: {}, save: {} };
  const document = {
    querySelectorAll: (selector) => selector === '.month' ? months : cards,
    getElementById: (id) => elements[id],
  };
  const html = renderHoldAllSheet(months.map((month, index) => ({ month: `2020-0${index + 1}`,
    sampleHash: month.dataset.hash, photos: [{ number: 1, image: 'YQ==' }] })));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, { document });
  assert.equal(elements.result.value, `해시: ${hashes[0]}\n인물: \n\n해시: ${hashes[1]}\n인물: `);
  cards[1].onclick();
  cards[2].onclick();
  assert.equal(elements.result.value, `해시: ${hashes[0]}\n인물: 2\n\n해시: ${hashes[1]}\n인물: 1`);
  assert.equal(elements.progress.textContent, '확인 2 / 3장 · 맞음 2장');
});

test('통합 보류 시트는 월별 번호와 해시를 보존하며 사진 이미지만 내장한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'hold-all-sheet-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const out = join(base, 'faces');
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  const peoplePath = join(root, VAULT_REL.mediaFacePeople);
  put(galleryPath, JSON.stringify({ bands: {} }));
  put(join(root, VAULT_REL.mediaArchiveIndex), [
    { id: 'a', capturedAt: '2020-01-10', archivePath: 'Archive/a.jpg' },
    { id: 'b', capturedAt: '2020-02-10', archivePath: 'Archive/b.jpg' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  put(join(out, 'matches.jsonl'), ['a', 'b'].map((id) =>
    JSON.stringify({ id, i: 0, score: 0.45 })).join('\n') + '\n');
  put(join(out, 'faces-index.jsonl'), ['a', 'b'].map((id) =>
    JSON.stringify({ id, faces: [{ i: 0, bbox: [0, 0, 10, 10] }] })).join('\n') + '\n');
  const result = await holdSheetMediaFaces({ root, out, indexPath: join(out, 'faces-index.jsonl'),
    cropper: async (images) => images.map((image) => image.out),
    thumbnailer: async (paths) => paths.map(() => 'YQ=='), returnDetails: true,
    output: { log() {} } });
  assert.equal(result.count, 2);
  const allPath = join(out, 'sheets', 'hold-all.html');
  const html = readFileSync(allPath, 'utf8');
  assert.match(html, /2020-01 · 1장/);
  assert.match(html, /2020-02 · 1장/);
  assert.equal((html.match(/data:image\/jpeg;base64,YQ==/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\.\.\/crops|file:\/\//);
  assert.match(html, /해시: .*\\n인물: /);
  assert.match(html, /확인 .*장/);
  const first = JSON.parse(readFileSync(join(out, 'sheets', 'hold-2020-01.json'), 'utf8'));
  assert.equal(first.sampleHash, holdSampleHash(first.sample));
  assert.match(readFileSync(result.sheets[0], 'utf8'), /\.\.\/crops\/a_0.jpg/);
  assert.match(renderHoldAllSheet([{ month: '2020-01', sampleHash: first.sampleHash,
    photos: [{ number: 1, image: 'YQ==' }] }]), /data-number="1"/);

  const second = JSON.parse(readFileSync(join(out, 'sheets', 'hold-2020-02.json'), 'utf8'));
  const answerPath = join(base, 'hold-all.txt');
  put(answerPath, `해시: ${first.sampleHash}\n인물: 1`);
  await assert.rejects(confirmHoldFaces(answerPath, { root, out, output: { log() {} } }), /블록 수 불일치/);
  put(answerPath, `해시: ${first.sampleHash}\n인물: 1\n\n해시: ${first.sampleHash}\n인물: 1`);
  await assert.rejects(confirmHoldFaces(answerPath, { root, out, output: { log() {} } }), /해시 불일치/);
  put(answerPath, `해시: ${first.sampleHash}\n인물: 1\n\n해시: ${'0'.repeat(64)}\n인물: 1`);
  await assert.rejects(confirmHoldFaces(answerPath, { root, out, output: { log() {} } }), /해시 불일치/);
  assert.equal(existsSync(peoplePath), false);
  assert.equal(existsSync(join(out, 'sheets', 'hold-2020-01.answered.json')), false);
  put(answerPath, `해시: ${first.sampleHash}\n인물: 1\n\n해시: ${second.sampleHash}\n인물: `);
  assert.equal(await confirmHoldFaces(answerPath, { root, out, output: { log() {} } }), null);
  assert.equal(existsSync(peoplePath), false);
  put(answerPath, `해시: ${first.sampleHash}\n인물: 1\n\n해시: ${second.sampleHash}\n인물: 1`);
  const applied = await confirmHoldFaces(answerPath, { root, out, output: { log() {} } });
  assert.equal(applied.confirmations.a.미네, true);
  assert.equal(applied.confirmations.b.미네, true);
  assert.equal(existsSync(join(out, 'sheets', 'hold-2020-02.answered.json')), true);
});
