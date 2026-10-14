#!/usr/bin/env node
// 원본과 Vault 색인은 읽기만 한다. 얼굴 특징값·메타는 Media/Faces에만 기록한다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS, VAULT_PATHS, VAULT_REL, categoryLink } from '../lib/vault-paths.mjs';
import { buildGallery, confirmBand, FACE_BANDS, FACE_PARAMS, MATCH_HIGH, MATCH_LOW, mineAlbum, ageBand,
  classifyFaceScore,
  selectGalleryCandidates, selectSheetMembers, clusterFamily,
  vectorLoader, matchFaces, selectGoldSample, goldMetrics } from '../lib/media-face-gallery.mjs';
import { photoPeopleWithGallery, PHOTO_HIGH, PHOTO_HOLD } from '../lib/media-face-people.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';

const SCRIPT = fileURLToPath(new URL('../tools/faces/media_faces.py', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png']);
const BATCH_SIZE = 200;

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function safeMediaPath(mediaRoot, record) {
  const relative = record.importPath || record.archivePath;
  const base = resolve(mediaRoot, record.importPath ? 'Imports' : 'Archive');
  const path = resolve(mediaRoot, relative);
  if (!path.startsWith(`${base}${sep}`)) throw new Error(`미디어 경로 오류: ${relative}`);
  return path;
}

function readGallery(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function facesById(rows) { return new Map(rows.map((row) => [row.id, row])); }

export async function clusterMediaFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  indexPath = MEDIA_FACES_PATHS.index, embeddingsPath = MEDIA_FACES_PATHS.embeddings,
  galleryPath = join(root, VAULT_REL.mediaFaceGallery), now = new Date().toISOString(),
  output = console } = {}) {
  const execute = () => {
    const albumsFile = join(root, VAULT_REL.mediaImportAlbums);
    const albumData = JSON.parse(readFileSync(albumsFile, 'utf8'));
    const albums = albumData.albums ?? albumData;
    const candidates = selectGalleryCandidates(jsonLines(indexPath),
      jsonLines(join(root, VAULT_REL.mediaImportsIndex)), albums);
    const previous = readGallery(galleryPath);
    const { gallery } = buildGallery(previous, candidates, vectorLoader(embeddingsPath), now);
    writeAtomic(galleryPath, `${JSON.stringify(gallery, null, 2)}\n`);
    output.log(`[media-faces] 기준 ${Object.keys(gallery.bands).length}개 나이대`);
    return gallery;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

const CROP_SCRIPT = fileURLToPath(new URL('../tools/faces/crop_faces.py', import.meta.url));

export async function runCropFaces(images, { python = MEDIA_FACES_PATHS.python,
  spawnProcess = spawn } = {}) {
  if (!images.length) return [];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(python, [CROP_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (stderr) process.stderr.write(stderr);
      if (code !== 0) {
        rejectPromise(new Error(`얼굴 조각 생성 실패: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolvePromise(stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : []);
      } catch (error) {
        rejectPromise(new Error(`얼굴 조각 결과 오류: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify({ images })}\n`);
  });
}

function sheetHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// HTML에는 선택에 필요한 표시값만 둔다. 원본 ID와 얼굴 좌표는 JSON 확인 시트에만 남긴다.
export function renderFaceSheet({ band = null, state = null, sheet = null, sample = null }) {
  const gold = sample !== null;
  const entries = gold ? sample : sheet;
  const hash = sheetHash(gold ? { sample } : { members: state.members, sheet });
  const storageKey = `media-faces:${gold ? 'gold' : band}:${hash}`;
  const title = gold ? '미네 얼굴 골드 판정' : `미네 ${band}`;
  const cards = entries.map((member, index) => {
    const number = gold ? member.number : index + 1;
    const predicted = gold ? member.predicted : 'mine';
    const image = gold ? `gold-${number}.jpg` : `${member.id}_${member.i}.jpg`;
    const details = gold
      ? `<span class="details">모델 ${htmlText(predicted)} · ${htmlText(member.band ?? '날짜 없음')}</span>`
      : '';
    const initialAnswer = predicted === 'mine' ? '미네' : '아님';
    return `<figure><button class="card ${htmlText(predicted)}" type="button" data-number="${htmlText(number)}" data-predicted="${htmlText(predicted)}" aria-pressed="false"><img src="../crops/${htmlText(image)}" alt="얼굴 ${htmlText(number)}"><figcaption>${htmlText(number)}</figcaption>${details}<span class="answer">오너 답: ${initialAnswer}</span><span class="badge" hidden>${gold ? '교정' : '제외'}</span></button></figure>`;
  }).join('\n');
  const summary = gold
    ? '<span>교정 <strong id="count">0</strong>개</span><span>미네가 아닌 번호: <strong id="not-mine">없음</strong></span><span>미네인데 아니라고 한 번호: <strong id="is-mine">없음</strong></span>'
    : '<span>제외 <strong id="count">0</strong>개</span><span>제외 번호: <strong id="removed">없음</strong></span>';
  const description = gold
    ? '<p>얼굴을 누르면 오너 답이 바뀝니다. 모델 판정은 mine=미네, uncertain·other=아님으로 시작합니다.</p>'
    : `<p>후보 ${state.candidateCount} · 묶음 크기 ${state.clusterSizes.join(', ')} · 얼굴을 누르면 제외됩니다.</p>`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlText(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#202124;background:#f6f7f8}
.toolbar{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #bbb;padding:.75rem 1rem;box-shadow:0 2px 8px #0002}
.stats{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;margin-bottom:.5rem}button{font:inherit;cursor:pointer}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}.actions button{padding:.45rem .8rem}
#fallback{display:none;width:min(100%,44rem);height:4rem;margin-top:.5rem}#fallback.visible{display:block}
.content{padding:1rem}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.75rem}
figure{margin:0}.card{position:relative;width:100%;height:100%;padding:.4rem;background:white;border:3px solid #888;border-radius:8px;text-align:center}
.card.mine{border-color:#338252}.card.uncertain{border-color:#b8860b}.card.other{border-color:#63748a}
.card.changed{border-color:#d52222;background:#fff3f3}.card:focus-visible{outline:3px solid #115bc4;outline-offset:2px}
img{display:block;width:160px;max-width:100%;height:160px;margin:auto;object-fit:contain}
figcaption{font-size:1.3rem;font-weight:700}.details,.answer{display:block;font-size:.85rem;margin-top:.2rem}
.badge{position:absolute;top:.3rem;right:.3rem;background:#d52222;color:white;padding:.15rem .35rem;border-radius:4px;font-size:.8rem}
.badge[hidden]{display:none}
@media(min-width:1550px){main{grid-template-columns:repeat(9,minmax(0,1fr))}}
</style>
<div class="toolbar"><div class="stats">${summary}</div><div class="actions"><button id="copy" type="button">결과 복사</button><button id="save" type="button">파일로 저장</button><button id="reset" type="button">초기화</button></div><textarea id="fallback" aria-label="복사할 결과" readonly></textarea></div>
<div class="content"><h1>${htmlText(title)}</h1>${description}<main>${cards}</main></div>
<script>
(() => {
  const gold = ${gold};
  const band = ${scriptJson(band)};
  const storageKey = ${scriptJson(storageKey)};
  const repoRoot = ${scriptJson(REPO_ROOT)};
  const cards = [...document.querySelectorAll('.card')];
  let changed = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) changed = new Set(saved.filter((number) => Number.isInteger(number)));
  } catch { /* file:// 저장소가 차단되어도 시트는 사용할 수 있다. */ }

  function result() {
    const mineToOther = [];
    const otherToMine = [];
    for (const card of cards) {
      const number = Number(card.dataset.number);
      if (!changed.has(number)) continue;
      if (gold && card.dataset.predicted !== 'mine') otherToMine.push(number);
      else mineToOther.push(number);
    }
    if (gold) return '미네가 아닌 번호: ' + mineToOther.join(', ')
      + '\\n미네인데 아니라고 한 번호: ' + otherToMine.join(', ');
    return 'cd ' + JSON.stringify(repoRoot) + ' && node scripts/jobs/media-faces.mjs --confirm=' + band
      + (mineToOther.length ? ' --remove=' + mineToOther.join(',') : '');
  }

  function update() {
    let count = 0;
    const mineToOther = [];
    const otherToMine = [];
    for (const card of cards) {
      const number = Number(card.dataset.number);
      const corrected = changed.has(number);
      const ownerMine = (card.dataset.predicted === 'mine') !== corrected;
      card.classList.toggle('changed', corrected);
      card.querySelector('.badge').hidden = !corrected;
      card.querySelector('.answer').textContent = '오너 답: ' + (ownerMine ? '미네' : gold ? '아님' : '제외');
      card.setAttribute('aria-pressed', String(corrected));
      if (!corrected) continue;
      count++;
      if (gold && card.dataset.predicted !== 'mine') otherToMine.push(number);
      else mineToOther.push(number);
    }
    document.getElementById('count').textContent = String(count);
    if (gold) {
      document.getElementById('not-mine').textContent = mineToOther.join(', ') || '없음';
      document.getElementById('is-mine').textContent = otherToMine.join(', ') || '없음';
    } else document.getElementById('removed').textContent = mineToOther.join(', ') || '없음';
  }

  for (const card of cards) card.addEventListener('click', () => {
    const number = Number(card.dataset.number);
    if (changed.has(number)) changed.delete(number);
    else changed.add(number);
    try { localStorage.setItem(storageKey, JSON.stringify([...changed])); } catch {}
    update();
  });
  document.getElementById('copy').addEventListener('click', async () => {
    const value = result();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
    } catch {
      const fallback = document.getElementById('fallback');
      fallback.value = value;
      fallback.classList.add('visible');
      fallback.focus();
      fallback.select();
    }
  });
  document.getElementById('save').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([result()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = gold ? 'gold-answers.txt' : band + '-answers.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById('reset').addEventListener('click', () => {
    changed.clear();
    try { localStorage.removeItem(storageKey); } catch {}
    document.getElementById('fallback').classList.remove('visible');
    update();
  });
  update();
})();
</script></html>\n`;
}

export async function sheetMediaFaces({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot,
  out = MEDIA_FACES_PATHS.root, indexPath = MEDIA_FACES_PATHS.index,
  embeddingsPath = MEDIA_FACES_PATHS.embeddings, galleryPath = join(root, VAULT_REL.mediaFaceGallery),
  cropper = runCropFaces, output = console } = {}) {
  const execute = async () => {
    const gallery = readGallery(galleryPath);
    if (!gallery?.bands) throw new Error('face-gallery.json이 없습니다. --cluster를 먼저 실행하세요.');
    const source = new Map([...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)),
      ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))].map((row) => [row.id, row]));
    const faces = facesById(jsonLines(indexPath));
    const vectorFor = vectorLoader(embeddingsPath);
    const cropsPath = join(out, 'crops');
    const sheetsPath = join(out, 'sheets');
    const planned = [];
    const pages = [];
    for (const band of FACE_BANDS) {
      const state = gallery.bands[band];
      if (!state?.members?.length) continue;
      const sheet = selectSheetMembers(state.members, vectorFor);
      for (const member of sheet) {
        try {
          const record = source.get(member.id);
          const face = faces.get(member.id)?.faces?.find((item) => item.i === member.i);
          if (!record || !face || !Array.isArray(face.bbox) || face.bbox.length !== 4) {
            throw new Error('얼굴 원본/좌표 누락');
          }
          planned.push({ id: member.id, i: member.i, path: safeMediaPath(mediaRoot, record), bbox: face.bbox,
            out: join(cropsPath, `${member.id}_${member.i}.jpg`) });
        } catch (error) {
          process.stderr.write(`[media-faces] ${member.id}/${member.i}: ${error.message}\n`);
        }
      }
      pages.push({ band, state, sheet });
    }
    mkdirSync(cropsPath, { recursive: true });
    mkdirSync(sheetsPath, { recursive: true });
    const cropped = new Set(await cropper(planned));
    for (const { band, state, sheet } of pages) {
      const available = sheet.filter((member) => cropped.has(join(cropsPath, `${member.id}_${member.i}.jpg`)));
      writeAtomic(join(sheetsPath, `${band}.json`), `${JSON.stringify({ members: state.members, sheet: available })}\n`);
      writeAtomic(join(sheetsPath, `${band}.html`), renderFaceSheet({ band, state, sheet: available }));
    }
    const goldLink = existsSync(join(sheetsPath, 'gold.html')) ? '<li><a href="gold.html">골드 표본</a></li>' : '';
    writeAtomic(join(sheetsPath, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>미네 얼굴 확인 시트</title><h1>미네 얼굴 확인 시트</h1><ul>${pages.map(({ band }) => `<li><a href="${band}.html">${band}</a></li>`).join('')}${goldLink}</ul></html>\n`);
    output.log(`[media-faces] 확인 시트 ${pages.length}개`);
    return pages.length;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export async function confirmMediaFaces(band, removeNumbers, { root = VAULT_PATHS.root,
  out = MEDIA_FACES_PATHS.root, galleryPath = join(root, VAULT_REL.mediaFaceGallery),
  sheetsPath = join(out, 'sheets'), now = new Date().toISOString(), output = console } = {}) {
  const execute = () => {
    const gallery = readGallery(galleryPath);
    if (!gallery) throw new Error('face-gallery.json이 없습니다.');
    if (!FACE_BANDS.includes(band)) throw new Error(`나이대 오류: ${band}`);
    const mapping = JSON.parse(readFileSync(join(sheetsPath, `${band}.json`), 'utf8'));
    const updated = confirmBand(gallery, band, mapping, removeNumbers, now);
    writeAtomic(galleryPath, `${JSON.stringify(updated, null, 2)}\n`);
    output.log(`[media-faces] ${band} 확인 완료: 제외 ${removeNumbers.length}`);
    return updated;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export function selectFaceTargets(visionRows, mediaRows, completedRows, {
  embeddingsPath, limit = 500, ids = null, fileExists = existsSync,
} = {}) {
  const requested = ids ? new Set(ids) : null;
  const mediaById = new Map();
  for (const row of mediaRows) {
    if (!mediaById.has(row.id) || mediaById.get(row.id).duplicateOf && !row.duplicateOf) {
      mediaById.set(row.id, row);
    }
  }
  const completed = new Set(completedRows.filter((row) => !row.error).map((row) => row.id));
  const seen = new Set();
  return visionRows.flatMap((vision) => {
    const record = mediaById.get(vision.id);
    if (!record || !vision.id || seen.has(vision.id) || !(vision.faces >= 1)
      || record.duplicateOf || record.screenshot || record.kind === 'Screenshots'
      || requested && !requested.has(vision.id)) return [];
    const relative = record.importPath || record.archivePath;
    if (!relative || !IMAGE_EXTENSIONS.has(extname(relative).toLowerCase())) return [];
    if (!/^[A-Za-z0-9_-]+$/.test(vision.id)) throw new Error(`얼굴 id 경로 오류: ${vision.id}`);
    seen.add(vision.id);
    if (completed.has(vision.id) && fileExists(join(embeddingsPath, `${vision.id}.npy`))) return [];
    return [record];
  }).slice(0, limit);
}

export function parseFaceOutput(lines, inputs) {
  const expected = new Set(inputs.map((input) => input.id));
  const rows = new Map();
  for (const line of lines) {
    let row;
    try { row = typeof line === 'string' ? JSON.parse(line) : line; }
    catch (error) { throw new Error(`얼굴 도구 JSON 오류: ${error.message}`); }
    if (!row || !expected.has(row.id) || rows.has(row.id)) {
      throw new Error(`얼굴 도구 id 오류: ${row?.id}`);
    }
    if (!row.error && (!Array.isArray(row.faces) || !Number.isFinite(row.ms))) {
      rows.set(row.id, { id: row.id, error: '얼굴 도구 결과 형식 오류' });
    } else rows.set(row.id, row);
  }
  return inputs.map((input) => rows.get(input.id) ?? { id: input.id, error: '얼굴 도구 결과 누락' });
}

export async function runPythonFaces(images, { out = MEDIA_FACES_PATHS.root,
  python = MEDIA_FACES_PATHS.python, spawnProcess = spawn, timeoutMs = images.length * 60_000,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(python, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { stderr += error.message; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const crashed = timedOut || code !== 0 || !!signal;
      const complete = crashed ? stdout.slice(0, stdout.lastIndexOf('\n') + 1) : stdout;
      resolvePromise({ lines: complete.trimEnd() ? complete.trimEnd().split('\n') : [],
        crashed, stderr: stderr.trim().slice(0, 500) });
    });
    child.stdin.end(`${JSON.stringify({ images, out })}\n`);
  });
}

export async function runMediaFaces({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot,
  out = MEDIA_FACES_PATHS.root, indexPath = MEDIA_FACES_PATHS.index,
  embeddingsPath = MEDIA_FACES_PATHS.embeddings, limit = 500, ids = null, dryRun = false,
  runner = runPythonFaces, spawnProcess = spawn, output = console, now = new Date().toISOString(),
} = {}) {
  if (!Number.isInteger(limit) || limit < 0 || ids && (!Array.isArray(ids) || ids.some((id) => !id))) {
    throw new Error('media-faces 옵션 오류');
  }
  const execute = async () => {
    const mediaRows = [
      ...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)),
      ...jsonLines(join(root, VAULT_REL.mediaImportsIndex)),
    ];
    const previous = jsonLines(indexPath);
    const targets = selectFaceTargets(jsonLines(join(root, VAULT_REL.mediaVisionIndex)), mediaRows,
      previous, { embeddingsPath, limit, ids });
    if (dryRun) {
      output.log(`[media-faces] dry-run 대상 ${targets.length}`);
      return { selected: targets.length, processed: 0, failed: 0 };
    }
    if (!targets.length) {
      output.log('[media-faces] 대상 0');
      return { selected: 0, processed: 0, failed: 0 };
    }
    mkdirSync(embeddingsPath, { recursive: true });
    const results = [];
    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE);
      const images = batch.map((record) => ({ id: record.id, path: safeMediaPath(mediaRoot, record) }));
      let response;
      try { response = await runner(images, { out, spawnProcess }); }
      catch (error) { response = { lines: [], crashed: true, stderr: error.message }; }
      const parsed = parseFaceOutput(Array.isArray(response) ? response : response.lines ?? [], images);
      const batchRows = parsed.map((row) => {
        const embedding = join(embeddingsPath, `${row.id}.npy`);
        const error = row.error || !existsSync(embedding) ? row.error || '특징값 파일 누락' : null;
        return error ? { id: row.id, error: String(error), analyzedAt: now }
          : { ...row, analyzedAt: now };
      });
      const latest = new Map(jsonLines(indexPath).map((row) => [row.id, row]));
      for (const row of batchRows) latest.set(row.id, row);
      writeAtomic(indexPath, `${[...latest.values()].map(JSON.stringify).join('\n')}\n`);
      results.push(...batchRows);
      if (response.crashed) output.error?.(`[media-faces] Python 종료: ${response.stderr || '알 수 없음'}`);
    }
    const success = results.filter((row) => !row.error);
    const distribution = {};
    for (const row of success) distribution[row.faces.length] = (distribution[row.faces.length] ?? 0) + 1;
    const summary = { selected: targets.length, processed: success.length, faces: distribution,
      failed: results.length - success.length,
      averageMs: success.length ? Math.round(success.reduce((sum, row) => sum + row.ms, 0) / success.length) : 0 };
    output.log(`[media-faces] ${JSON.stringify(summary)}`);
    return summary;
  };
  if (dryRun) return execute();
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

function mediaRows(root) {
  return [...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)),
    ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))];
}

export async function matchMediaFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  indexPath = MEDIA_FACES_PATHS.index, embeddingsPath = MEDIA_FACES_PATHS.embeddings,
  galleryPath = join(root, VAULT_REL.mediaFaceGallery), matchesPath = join(out, 'matches.jsonl'),
  vectorFor = vectorLoader(embeddingsPath), output = console } = {}) {
  const execute = () => {
    const gallery = readGallery(galleryPath);
    if (!gallery?.bands) throw new Error('face-gallery.json이 없습니다');
    const galleryHash = sheetHash(gallery);
    const statePath = join(out, 'matches-state.json');
    const previousState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
    const media = mediaRows(root);
    const mediaById = new Map(media.map((row) => [row.id, row]));
    const rows = jsonLines(indexPath);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const inputHashes = Object.fromEntries(rows.filter((row) => !row.error && Array.isArray(row.faces))
      .map((row) => {
        const record = mediaById.get(row.id);
        return [row.id, sheetHash({ faces: row.faces, capturedAt: record?.capturedAt,
          capturedConfidence: record?.capturedConfidence,
          band: ageBand(record?.capturedAt, record?.capturedConfidence) })];
      }));
    const oldMatchesById = new Map();
    for (const face of jsonLines(matchesPath)) {
      if (face.galleryHash !== galleryHash || face.inputHash !== inputHashes[face.id]) continue;
      const group = oldMatchesById.get(face.id) ?? [];
      group.push(face);
      oldMatchesById.set(face.id, group);
    }
    const completeMatches = (row) => {
      const matches = oldMatchesById.get(row.id) ?? [];
      const expected = row.faces.map((face) => face.i);
      return matches.length === expected.length
        && new Set(matches.map((face) => face.i)).size === expected.length
        && expected.every((index) => matches.some((face) => face.i === index));
    };
    // 결과와 상태 중 먼저 기록된 쪽으로 복구하되, 현재 사진 입력 해시가 같아야 재사용한다.
    const completed = new Set(Object.entries(previousState.galleryHash === galleryHash
      ? previousState.inputHashes ?? {} : {})
      .filter(([id, hash]) => inputHashes[id] === hash
        && Array.isArray(rowsById.get(id)?.faces) && completeMatches(rowsById.get(id)))
      .map(([id]) => id));
    for (const row of rows.filter((item) => Array.isArray(item.faces) && item.faces.length)) {
      if (completeMatches(row)) completed.add(row.id);
    }
    const previous = [...completed].flatMap((id) => oldMatchesById.get(id) ?? []);
    const pending = rows.filter((row) => !completed.has(row.id));
    const pendingIds = new Set(pending.map((row) => row.id));
    const matches = [...previous, ...matchFaces(pending, media, gallery, vectorFor)
      .map((face) => ({ ...face, galleryHash, inputHash: inputHashes[face.id] }))];
    writeAtomic(matchesPath, `${matches.map(JSON.stringify).join('\n')}\n`);
    writeAtomic(statePath, `${JSON.stringify({ galleryHash, count: matches.length,
      inputHashes: Object.fromEntries(Object.entries(inputHashes)
        .filter(([id]) => completed.has(id) || pendingIds.has(id))) })}\n`);
    output.log(`[media-faces] 판정 ${matches.length}개 얼굴`);
    return matches;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export async function labelMediaFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  matchesPath = join(out, 'matches.jsonl'), peoplePath = join(root, VAULT_REL.mediaFacePeople),
  galleryPath = join(root, VAULT_REL.mediaFaceGallery),
  now = new Date().toISOString(), output = console } = {}) {
  const execute = () => {
  if (!existsSync(matchesPath)) throw new Error('matches.jsonl이 없습니다. --match를 먼저 실행하세요');
  const previous = existsSync(peoplePath) ? JSON.parse(readFileSync(peoplePath, 'utf8')) : {};
  const confirmations = previous.confirmations ?? {};
  const photos = photoPeopleWithGallery(jsonLines(matchesPath), readGallery(galleryPath), confirmations);
  const index = { version: 1, updatedAt: now,
    thresholds: { label: PHOTO_HIGH, hold: PHOTO_HOLD }, photos,
    ...(Object.keys(confirmations).length ? { confirmations } : {}) };
  writeAtomic(peoplePath, `${JSON.stringify(index, null, 2)}\n`);
  output.log(`[media-faces] 사진 이름표 ${Object.keys(photos).length}개`);
  return index;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export async function runFacePipeline({ limit = 500, ids = null, dryRun = false,
  detect = runMediaFaces, match = matchMediaFaces, label = labelMediaFaces } = {}) {
  const detected = await detect({ limit, ids, dryRun });
  if (dryRun) return detected;
  await match();
  return label();
}

export function parseFacePipelineArgs(args) {
  if (!['--detect', '--match', '--label'].every((command) => args.includes(command))) return null;
  const rawLimit = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
  const ids = args.find((arg) => arg.startsWith('--ids='))?.slice(6).split(',') ?? null;
  const limit = rawLimit === undefined ? 500 : Number(rawLimit);
  if (!args.every((arg) => ['--detect', '--match', '--label', '--dry-run'].includes(arg)
    || arg.startsWith('--limit=') || arg.startsWith('--ids='))
    || ['--detect', '--match', '--label'].some((command) => args.filter((arg) => arg === command).length !== 1)
    || !Number.isInteger(limit) || limit < 0 || ids?.some((id) => !id)) {
    throw new Error('파이프라인 인자 오류');
  }
  return { limit, ids, dryRun: args.includes('--dry-run') };
}

export function parseFamilyConfirm(text, count) {
  const mapping = {};
  const used = new Set();
  for (const item of text.split(';')) {
    const match = item.trim().match(/^(휘영|나):([\d,]+)$/);
    if (!match || mapping[match[1]]) throw new Error(`가족 확인 형식 오류: ${item}`);
    const numbers = match[2].split(',').map(Number);
    for (const number of numbers) {
      if (!Number.isInteger(number) || number < 1 || number > count || used.has(number)) {
        throw new Error(`가족 묶음 번호 오류: ${number}`);
      }
      used.add(number);
    }
    mapping[match[1]] = numbers;
  }
  return mapping;
}

export function renderFamilySheet(clusters) {
  const cards = clusters.map((members, index) => `<section><h2>묶음 ${index + 1} · ${members.length}개</h2><div class="faces">${members
    .map((member) => `<img src="../crops/${htmlText(member.id)}_${member.i}.jpg" alt="묶음 ${index + 1} 얼굴">`).join('')}</div><select data-cluster="${index + 1}"><option value="">기타·모름</option><option>휘영</option><option>나</option></select></section>`).join('\n');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>가족 얼굴 묶음</title><style>body{font-family:system-ui;margin:2rem}.faces{display:flex;flex-wrap:wrap;gap:.3rem}.faces img{width:100px;height:100px;object-fit:contain}section{border:1px solid #aaa;padding:1rem;margin:1rem 0}textarea{display:block;width:100%;height:4rem}</style><h1>가족 얼굴 묶음</h1><p>묶음별 이름을 고르세요. 기타·모름은 기준에 넣지 않습니다.</p><button id="copy">결과 복사</button><textarea id="result" readonly></textarea>${cards}<script>const root=${scriptJson(REPO_ROOT)};function command(){const groups={휘영:[],나:[]};for(const select of document.querySelectorAll('select'))if(groups[select.value])groups[select.value].push(select.dataset.cluster);return 'cd '+JSON.stringify(root)+' && node scripts/jobs/media-faces.mjs --family-confirm='+JSON.stringify(Object.entries(groups).filter(([,ids])=>ids.length).map(([name,ids])=>name+':'+ids.join(',')).join(';'));}document.getElementById('copy').onclick=async()=>{const value=command();document.getElementById('result').value=value;try{await navigator.clipboard.writeText(value)}catch{document.getElementById('result').select()}};</script></html>\n`;
}

export function selectFamilyDisplay(members, clusterNumber, limit = 24) {
  if (members.length <= limit) return members.map(({ id, i }) => ({ id, i }));
  const nearCount = Math.ceil(limit / 2);
  const near = members.slice(0, nearCount);
  // 남은 절반은 묶음 번호와 얼굴 ID로 고정된 추첨을 한다. 재생성해도 번호가 안정적이다.
  const sampled = members.slice(nearCount).map((member) => ({ member,
    order: sheetHash(`family:${clusterNumber}:${member.id}:${member.i}`) }))
    .sort((left, right) => left.order.localeCompare(right.order))
    .slice(0, limit - nearCount).map(({ member }) => member);
  return [...near, ...sampled].map(({ id, i }) => ({ id, i }));
}

export async function clusterFamilyFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  mediaRoot = MEDIA_FACES_PATHS.mediaRoot, indexPath = MEDIA_FACES_PATHS.index,
  matchesPath = join(out, 'matches.jsonl'), embeddingsPath = MEDIA_FACES_PATHS.embeddings,
  cropper = runCropFaces, output = console } = {}) {
  if (!existsSync(matchesPath)) throw new Error('matches.jsonl이 없습니다. --match를 먼저 실행하세요');
  const rows = jsonLines(indexPath);
  const clusters = clusterFamily(rows, jsonLines(matchesPath), vectorLoader(embeddingsPath));
  const displayed = Object.fromEntries(clusters.map((members, index) =>
    [index + 1, selectFamilyDisplay(members, index + 1)]));
  const byId = facesById(rows);
  const source = new Map(mediaRows(root).map((row) => [row.id, row]));
  const cropsPath = join(out, 'crops');
  const sheetsPath = join(out, 'sheets');
  const planned = Object.values(displayed).flatMap((members) => members).flatMap((member) => {
    const face = byId.get(member.id)?.faces?.find((item) => item.i === member.i);
    const record = source.get(member.id);
    if (!record || face?.bbox?.length !== 4) throw new Error(`가족 시트 원본/좌표 누락: ${member.id}/${member.i}`);
    return [{ id: member.id, i: member.i,
      path: safeMediaPath(mediaRoot, record), bbox: face.bbox,
      out: join(cropsPath, `${member.id}_${member.i}.jpg`) }];
  });
  mkdirSync(cropsPath, { recursive: true });
  mkdirSync(sheetsPath, { recursive: true });
  const cropped = new Set(await cropper(planned));
  if (planned.some((item) => !cropped.has(item.out))) throw new Error('가족 시트 얼굴 조각 생성 누락');
  writeAtomic(join(sheetsPath, 'family.json'), `${JSON.stringify({ clusters, displayed }, null, 2)}\n`);
  writeAtomic(join(sheetsPath, 'family.html'), renderFamilySheet(Object.values(displayed)));
  output.log(`[media-faces] 가족 묶음 ${clusters.length}개`);
  return clusters;
}

export async function confirmFamilyFaces(input, { root = VAULT_PATHS.root,
  out = MEDIA_FACES_PATHS.root, galleryPath = join(root, VAULT_REL.mediaFaceGallery),
  now = new Date().toISOString(), output = console } = {}) {
  const execute = () => {
  const { clusters, displayed } = JSON.parse(readFileSync(join(out, 'sheets', 'family.json'), 'utf8'));
  if (!displayed || clusters.some((_, index) => !Array.isArray(displayed[index + 1]))) {
    throw new Error('가족 시트 표시 얼굴 기록이 없습니다. --family-cluster 재실행');
  }
  const mapping = parseFamilyConfirm(input, clusters.length);
  const gallery = readGallery(galleryPath);
  if (!gallery?.bands) throw new Error('face-gallery.json이 없습니다');
  const people = { ...(gallery.people ?? {}) };
  for (const [person, numbers] of Object.entries(mapping)) {
    people[person] = { members: numbers.flatMap((number) => displayed[number])
      .map(({ id, i }) => ({ id, i })), confirmed: true };
  }
  const updated = { ...gallery, updatedAt: now, people };
  writeAtomic(galleryPath, `${JSON.stringify(updated, null, 2)}\n`);
  output.log(`[media-faces] 가족 기준 ${Object.keys(mapping).join(', ')}`);
  return updated;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export function parseHoldAnswers(text, sample) {
  const match = text.trim().match(/^미네\s*:\s*([\d,\s]*)$/);
  if (!match) throw new Error('보류함 결과 형식 오류: 미네: 1,2');
  const byNumber = new Map(sample.map((item) => [item.number, item]));
  const numbers = match[1].trim() ? match[1].split(',').map((part) => Number(part.trim())) : [];
  if (new Set(numbers).size !== numbers.length || numbers.some((number) => !byNumber.has(number))) {
    throw new Error('보류함 번호 오류');
  }
  return numbers;
}

export function renderHoldSheet(sample) {
  const cards = sample.map((item) => `<button class="card" data-number="${item.number}" aria-pressed="false"><img src="../crops/${htmlText(item.id)}_${item.i}.jpg" alt="보류 얼굴 ${item.number}"><strong>${item.number}</strong><span>아님</span></button>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>미네 보류함</title><style>body{font-family:system-ui;margin:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,130px);gap:.5rem}.card{cursor:pointer;background:white;border:2px solid #888}.card[aria-pressed=true]{border-color:#27824c;background:#e9f5ed}.card img{width:120px;height:120px;object-fit:contain}.card span{display:block}textarea{display:block;width:100%}</style><h1>미네 얼굴 보류함</h1><p>기본 답은 아님입니다. 미네인 얼굴만 누르세요.</p><button id="copy">결과 복사</button><button id="save">파일로 저장</button><textarea id="result" readonly></textarea><div class="grid">${cards}</div><script>const cards=[...document.querySelectorAll('.card')];for(const card of cards)card.onclick=()=>{const yes=card.getAttribute('aria-pressed')!=='true';card.setAttribute('aria-pressed',String(yes));card.querySelector('span').textContent=yes?'미네':'아님'};function result(){return '미네: '+cards.filter(card=>card.getAttribute('aria-pressed')==='true').map(card=>card.dataset.number).join(',')}document.getElementById('copy').onclick=async()=>{const value=result();document.getElementById('result').value=value;try{await navigator.clipboard.writeText(value)}catch{document.getElementById('result').select()}};document.getElementById('save').onclick=()=>{const url=URL.createObjectURL(new Blob([result()],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=location.pathname.split('/').pop().replace('.html','.txt');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};</script></html>\n`;
}

export function renderPersonGoldSheet(person, sample) {
  const cards = sample.map((item) => `<button class="card" data-number="${item.number}" data-predicted="${item.predicted}" aria-pressed="false"><img src="../crops/gold-${htmlText(person)}-${item.number}.jpg" alt="${htmlText(person)} 표본 ${item.number}"><strong>${item.number}</strong><span>${item.predicted === 'mine' ? person : '아님'}</span></button>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${htmlText(person)} 얼굴 표본</title><style>body{font-family:system-ui;margin:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,130px);gap:.5rem}.card{cursor:pointer;background:white;border:2px solid #888}.card[aria-pressed=true]{border-color:#d22;background:#fff3f3}.card img{width:120px;height:120px;object-fit:contain}.card span{display:block}textarea{display:block;width:100%}</style><h1>${htmlText(person)} 얼굴 표본</h1><p>틀린 판정만 누르세요.</p><button id="copy">결과 복사</button><textarea id="result" readonly></textarea><div class="grid">${cards}</div><script>const cards=[...document.querySelectorAll('.card')];for(const card of cards)card.onclick=()=>{const yes=card.getAttribute('aria-pressed')!=='true';card.setAttribute('aria-pressed',String(yes))};document.getElementById('copy').onclick=async()=>{const wrong=cards.filter(card=>card.dataset.predicted==='mine'&&card.getAttribute('aria-pressed')==='true').map(card=>card.dataset.number);const missed=cards.filter(card=>card.dataset.predicted!=='mine'&&card.getAttribute('aria-pressed')==='true').map(card=>card.dataset.number);const value='${htmlText(person)}가 아닌 번호: '+wrong.join(',')+'\\n${htmlText(person)}인데 아니라고 한 번호: '+missed.join(',');document.getElementById('result').value=value;try{await navigator.clipboard.writeText(value)}catch{document.getElementById('result').select()}};</script></html>\n`;
}

export async function holdSheetMediaFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  mediaRoot = MEDIA_FACES_PATHS.mediaRoot, indexPath = MEDIA_FACES_PATHS.index,
  matchesPath = join(out, 'matches.jsonl'), cropper = runCropFaces,
  output = console } = {}) {
  const matches = jsonLines(matchesPath);
  const previousPath = join(root, VAULT_REL.mediaFacePeople);
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : {};
  const gallery = readGallery(join(root, VAULT_REL.mediaFaceGallery));
  const photos = photoPeopleWithGallery(matches, gallery, previous.confirmations ?? {});
  const removed = new Set(Object.values(gallery?.bands ?? {})
    .filter((state) => state.confirmed)
    .flatMap((state) => state.removed ?? [])
    .map((face) => `${face.id}:${face.i}`));
  const byId = new Map(mediaRows(root).map((row) => [row.id, row]));
  const faceRows = facesById(jsonLines(indexPath));
  const byMonth = new Map();
  for (const [id, entry] of Object.entries(photos)) {
    if (!entry.hold?.includes('미네')) continue;
    const record = byId.get(id);
    const month = record?.capturedAt?.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const match = matches.filter((face) => face.id === id && !face.person && !face.prebirth
      && !removed.has(`${face.id}:${face.i}`)
      && face.score >= PHOTO_HOLD && face.score < PHOTO_HIGH)
      .sort((left, right) => right.score - left.score)[0];
    if (!match) continue;
    const sample = byMonth.get(month) ?? [];
    sample.push({ id, i: match.i });
    byMonth.set(month, sample);
  }
  const sheetsPath = join(out, 'sheets');
  const cropsPath = join(out, 'crops');
  mkdirSync(sheetsPath, { recursive: true });
  mkdirSync(cropsPath, { recursive: true });
  for (const [month, entries] of byMonth) {
    const sample = entries.map((entry, index) => ({ ...entry, number: index + 1 }));
    const planned = sample.flatMap((entry) => {
      const face = faceRows.get(entry.id)?.faces?.find((item) => item.i === entry.i);
      const record = byId.get(entry.id);
      if (!record || face?.bbox?.length !== 4) throw new Error(`보류함 원본/좌표 누락: ${entry.id}/${entry.i}`);
      return [{ ...entry,
        path: safeMediaPath(mediaRoot, record), bbox: face.bbox,
        out: join(cropsPath, `${entry.id}_${entry.i}.jpg`) }];
    });
    const cropped = new Set(await cropper(planned));
    if (planned.some((item) => !cropped.has(item.out))) throw new Error('보류함 얼굴 조각 생성 누락');
    writeAtomic(join(sheetsPath, `hold-${month}.json`), `${JSON.stringify({ sample }, null, 2)}\n`);
    writeAtomic(join(sheetsPath, `hold-${month}.html`), renderHoldSheet(sample));
  }
  output.log(`[media-faces] 보류함 ${byMonth.size}개월`);
  return byMonth.size;
}

export async function confirmHoldFaces(input, { root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  peoplePath = join(root, VAULT_REL.mediaFacePeople),
  galleryPath = join(root, VAULT_REL.mediaFaceGallery), allNo = false, output = console } = {}) {
  const execute = () => {
  const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  const basename = expanded.match(/hold-(\d{4}-\d{2})(?:\.txt)?$/)?.[1];
  if (!basename) throw new Error('보류함 파일명은 hold-YYYY-MM.txt 형식이어야 합니다');
  const sample = JSON.parse(readFileSync(join(out, 'sheets', `hold-${basename}.json`), 'utf8')).sample;
  const yes = new Set(parseHoldAnswers(readFileSync(expanded, 'utf8'), sample));
  if (!yes.size && !allNo) {
    output.log('[media-faces] 미네 선택이 0개입니다. 모두 아님을 적용하려면 --hold-all-no를 함께 지정하세요.');
    return null;
  }
  const current = existsSync(peoplePath) ? JSON.parse(readFileSync(peoplePath, 'utf8')) : {};
  const confirmations = { ...(current.confirmations ?? {}) };
  for (const item of sample) confirmations[item.id] = { ...(confirmations[item.id] ?? {}), 미네: yes.has(item.number) };
  const photos = photoPeopleWithGallery(jsonLines(join(out, 'matches.jsonl')),
    readGallery(galleryPath), confirmations);
  const index = { version: 1, updatedAt: new Date().toISOString(),
    thresholds: { label: PHOTO_HIGH, hold: PHOTO_HOLD }, photos, confirmations };
  writeAtomic(peoplePath, `${JSON.stringify(index, null, 2)}\n`);
  const gallery = readGallery(galleryPath);
  if (gallery?.bands && yes.size) {
    const source = new Map(mediaRows(root).map((row) => [row.id, row]));
    const bands = { ...gallery.bands };
    for (const item of sample.filter((entry) => yes.has(entry.number))) {
      const media = source.get(item.id);
      const band = ageBand(media?.capturedAt, media?.capturedConfidence);
      if (!band || !bands[band]) continue;
      const state = bands[band];
      const member = { id: item.id, i: item.i };
      const holdCandidates = state.holdCandidates ?? [];
      const present = (items) => items.some((entry) => entry.id === item.id && entry.i === item.i);
      bands[band] = { ...state,
        holdCandidates: present(holdCandidates) ? holdCandidates : [...holdCandidates, member],
        members: state.confirmed && !present(state.members) ? [...state.members, member] : state.members };
    }
    writeAtomic(galleryPath, `${JSON.stringify({ ...gallery, bands, updatedAt: index.updatedAt }, null, 2)}\n`);
  }
  output.log(`[media-faces] 보류함 확인 ${sample.length}장`);
  return index;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

function percentage(numerator, denominator) {
  return denominator ? `${(100 * numerator / denominator).toFixed(1)}%` : '자료 없음';
}

function htmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function tableText(value) { return String(value).replace(/[|\r\n]/g, ' '); }

export function prebirthFalsePositiveRows(matches) {
  const prebirth = matches.filter((face) => face.prebirth);
  return Array.from({ length: 7 }, (_, index) => {
    const threshold = Number((0.40 + index * 0.05).toFixed(2));
    const falsePositive = prebirth.filter((face) => Number.isFinite(face.score)
      && face.score >= threshold).length;
    return { threshold, falsePositive, rate: percentage(falsePositive, prebirth.length) };
  });
}

function reportBand(face) {
  return face.prebirth ? '출생 이전' : face.band ?? '날짜 모름(bandless)';
}

function reportGenerated(matches, gallery, metrics, albums, sheetPath) {
  const count = (items, label) => items.filter((face) => face.label === label).length;
  const byBand = [...new Set([...FACE_BANDS, ...Object.keys(gallery.bands),
    ...matches.map(reportBand), '날짜 모름(bandless)', '출생 이전'])]
    .sort((left, right) => {
      const leftIndex = FACE_BANDS.indexOf(left);
      const rightIndex = FACE_BANDS.indexOf(right);
      return (leftIndex < 0 ? FACE_BANDS.length : leftIndex)
        - (rightIndex < 0 ? FACE_BANDS.length : rightIndex) || left.localeCompare(right);
    });
  const bandRows = byBand.map((band) => {
    const items = matches.filter((face) => reportBand(face) === band);
    const state = gallery.bands[band];
    const bandIndex = FACE_BANDS.indexOf(band);
    const referenceCount = bandIndex < 0 ? Object.values(gallery.bands)
      .reduce((sum, value) => sum + (value.members?.length ?? 0), 0)
      : FACE_BANDS.slice(Math.max(0, bandIndex - 1), bandIndex + 2)
        .reduce((sum, name) => sum + (gallery.bands[name]?.members?.length ?? 0), 0);
    return `| ${tableText(band)} | ${state?.members?.length ?? 0} | ${Math.min(5, referenceCount)} | ${(state?.clusterSizes ?? []).slice(0, 5).join(', ') || '없음'} | ${state?.candidateCount ?? 0} | ${state?.confirmed ? '예' : '아니오'} | ${count(items, 'mine')} | ${count(items, 'uncertain')} | ${count(items, 'other')} |`;
  });
  const albumNames = [...new Set(matches.map((face) => face.album ?? '앨범 없음'))].sort();
  const albumRows = albumNames.map((name) => {
    const items = matches.filter((face) => (face.album ?? '앨범 없음') === name);
    const photos = new Set(items.map((face) => face.id));
    const minePhotos = new Set(items.filter((face) => face.label === 'mine').map((face) => face.id));
    return `| ${tableText(name)} | ${photos.size} | ${minePhotos.size} | ${percentage(photos.size - minePhotos.size, photos.size)} |`;
  });
  const scored = matches.filter((face) => face.score !== null);
  const hist = Array.from({ length: 10 }, (_, index) => {
    const lower = -1 + index * 0.2;
    const upper = lower + 0.2;
    return `| ${lower.toFixed(1)}–${upper.toFixed(1)} | ${scored.filter((face) => {
      return face.score >= lower && (index === 9 ? face.score <= upper : face.score < upper);
    }).length} |`;
  });
  const minePhotos = new Set(matches.filter((face) => face.label === 'mine').map((face) => face.id));
  const outside = new Set(matches.filter((face) => face.label === 'mine'
    && !mineAlbum(face.album, albums)).map((face) => face.id));
  const archive = new Set(matches.filter((face) => face.label === 'mine' && face.source === 'Archive')
    .map((face) => face.id));
  const mineAlbumFaces = matches.filter((face) => mineAlbum(face.album, albums));
  const mineAlbumPhotos = new Set(mineAlbumFaces.map((face) => face.id));
  const mineAlbumDetected = new Set(mineAlbumFaces.filter((face) => face.label === 'mine')
    .map((face) => face.id));
  const prebirth = matches.filter((face) => face.prebirth);
  const bandless = matches.filter((face) => !face.prebirth && face.band == null);
  const lines = [
    '# 미네 얼굴 인식 검증', '', '## 1부 · 전체 판정', '',
    `- 모델: InsightFace buffalo_l · 판정 임계값: 미네 ${MATCH_HIGH.toFixed(2)} 이상, 애매 ${MATCH_LOW.toFixed(2)} 이상 · 비교: 코사인 상위 5개 평균`,
    `- 기준 생성 파라미터: 검출 ${FACE_PARAMS.minDetection}, 최소 크기 ${FACE_PARAMS.minSize}px, 흐림 하위 ${(FACE_PARAMS.blurExcludedFraction * 100).toFixed(0)}% 제외, 묶음 유사도 ${FACE_PARAMS.minSimilarity}, 확인 시트 최대 ${FACE_PARAMS.sheetLimit}개`,
    `- 분석 사진: ${new Set(matches.map((face) => face.id)).size}장 · 얼굴: ${matches.length}개`,
    `- 미네 판정 사진: ${minePhotos.size}장 · 얼굴: ${count(matches, 'mine')}개`,
    `- 애매: ${count(matches, 'uncertain')}개 (${percentage(count(matches, 'uncertain'), matches.length)}) · 아님: ${count(matches, 'other')}개`,
    `- 미네 앨범 밖 미네 판정: ${outside.size}장`,
    `- Archive 미네 판정: ${archive.size}장`,
    `- 미네 앨범에서 얼굴은 있으나 미네 판정 없음(누락 대리 지표): ${mineAlbumPhotos.size - mineAlbumDetected.size}/${mineAlbumPhotos.size}장 (${percentage(mineAlbumPhotos.size - mineAlbumDetected.size, mineAlbumPhotos.size)})`,
    `- 골드 확인 시트: ${sheetPath}`, '',
    '### 출생 이전 사진으로 잰 오탐률(오너 확인 불필요)', '',
    `- 출생 이전 얼굴: ${prebirth.length}개`,
    '- 모든 나이대 기준과 비교한다. 인접 나이대 기준이 5개 이상일 때는 실제 banded 판정보다 보수적인 오탐률 상한이며, 5개 미만이면 엄밀한 상한을 보장하지 않는다.',
    '| 임계값 | 잘못 미네로 잡힐 얼굴 | 비율 |', '|---:|---:|---:|',
    ...prebirthFalsePositiveRows(matches).map((row) => `| ${row.threshold.toFixed(2)} | ${row.falsePositive} | ${row.rate} |`),
    `- 날짜 모름(bandless) 얼굴: ${bandless.length}개 · 미네 판정: ${count(bandless, 'mine')}개`, '',
    '### 나이대별', '', '| 나이대 | 기준 수 | 상위 비교 수 | 묶음 크기 상위 5개 | 후보 수 | 확인 | 미네 | 애매 | 아님 |',
    '|---|---:|---:|---|---:|---|---:|---:|---:|', ...bandRows, '',
    '### 앨범별 사진 수', '', '| 앨범 | 얼굴 있는 사진 | 미네 판정 사진 | 미네 없음 비율 |',
    '|---|---:|---:|---:|', ...albumRows, '',
    '### 점수 분포', '', '| 점수 구간 | 얼굴 수 |', '|---|---:|', ...hist,
  ];
  if (metrics) {
    lines.push('', '## 2부 · 오너 판정 표본', '',
      '- 정밀도·재현율은 판정군(mine/uncertain/other)×나이대 모집단 크기로 가중한 표본 추정치다. 98% 달성을 보증하지 않는다.',
      `- 기본 0.50 정밀도: ${metrics.atDefault.precision === null ? '자료 없음' : percentage(metrics.atDefault.truePositive, metrics.atDefault.truePositive + metrics.atDefault.falsePositive)}`,
      `- 기본 0.50 재현율: ${metrics.atDefault.recall === null ? '자료 없음' : `${(metrics.atDefault.recall * 100).toFixed(1)}%`}`,
      `- 정밀도 98% 이상인 최저 임계값: ${metrics.recommended ?? '없음'}`, '',
      '### 나이대별 오류 수', '',
      ...Object.entries(metrics.errorsByBand).map(([band, errors]) => `- ${band}: ${errors}개`),
      '', '### 임계값별 정확도', '', '| 임계값 | 정밀도 추정 | 재현율 추정 | 가중 TP | 가중 FP |', '|---:|---:|---:|---:|---:|',
      ...metrics.thresholds.map((item) => `| ${item.threshold.toFixed(2)} | ${item.precision === null ? '자료 없음' : `${(item.precision * 100).toFixed(1)}%`} | ${item.recall === null ? '자료 없음' : `${(item.recall * 100).toFixed(1)}%`} | ${item.truePositive.toFixed(1)} | ${item.falsePositive.toFixed(1)} |`));
  } else {
    lines.push('', '## 2부 · 오너 판정 대기', '',
      '> 정밀도·재현율은 2부(표본 확인) 뒤',
      '골드 표본 오너 판정 뒤 나이대별 오류·임계값 표를 채운다.');
  }
  return `${lines.join('\n')}\n`;
}

const REPORT_START = '<!-- media-faces:generated:start -->';
const REPORT_END = '<!-- media-faces:generated:end -->';

export function validatePersonGold(person, gold, sheet, matches) {
  if (!sheet || JSON.stringify(sheet.sample) !== JSON.stringify(gold.sample)) {
    throw new Error(`가족 골드 라벨과 시트가 다릅니다. --gold-sheet --person=${person} 재실행`);
  }
  const current = new Map(matches.map((face) => [`${face.id}:${face.i}`, face]));
  if (gold.sample.some((member) => {
    const face = current.get(`${member.id}:${member.i}`);
    return !face || face.person !== person || face.score !== member.score
      || face.band !== member.band
      || (face.score >= PHOTO_HIGH ? 'mine' : 'uncertain') !== member.predicted;
  })) throw new Error(`가족 골드 표본이 현재 판정과 다릅니다. --gold-sheet --person=${person} 재실행`);
}

export async function reportMediaFaces({ root = VAULT_PATHS.root, out = MEDIA_FACES_PATHS.root,
  matchesPath = join(out, 'matches.jsonl'), galleryPath = join(root, VAULT_REL.mediaFaceGallery),
  goldPath = join(out, 'gold-labels.json'), reportRel,
  registryRules, now = new Date().toISOString(), output = console } = {}) {
  const execute = () => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric',
      month: '2-digit', day: '2-digit' }).format(new Date(now));
    const relativeReport = reportRel ?? `${VAULT_REL.mediaFaceReports}/${date.slice(0, 4)}/${date} 미네 얼굴 인식 검증.md`;
    const matches = jsonLines(matchesPath);
    if (!existsSync(matchesPath)) throw new Error('matches.jsonl이 없습니다. --match를 먼저 실행하세요');
    const gallery = readGallery(galleryPath);
    if (!gallery?.bands) throw new Error('face-gallery.json이 없습니다');
    const gold = existsSync(goldPath) ? JSON.parse(readFileSync(goldPath, 'utf8')) : null;
    if (gold) {
      const sheetPath = join(out, 'sheets', 'gold.json');
      const sheet = existsSync(sheetPath) ? JSON.parse(readFileSync(sheetPath, 'utf8')) : null;
      if (!sheet || JSON.stringify(sheet.sample) !== JSON.stringify(gold.sample)) {
        throw new Error('골드 라벨과 확인 시트가 다릅니다. --gold를 다시 실행하세요');
      }
      const current = new Map(matches.map((face) => [`${face.id}:${face.i}`, face]));
      if (gold.sample.some((member) => {
        const face = current.get(`${member.id}:${member.i}`);
        return !face || face.prebirth || member.prebirth
          || face.score !== member.score || face.label !== member.predicted
          || face.band !== member.band;
      })) throw new Error('골드 표본과 현재 판정이 다릅니다. --gold-sheet를 다시 실행하세요');
    }
    const metrics = gold ? goldMetrics(gold.sample, gold.labels, matches) : null;
    const familyRows = ['휘영', '나'].map((person) => {
      const path = join(out, `gold-${person}-labels.json`);
      if (!existsSync(path)) return `| ${person} | 판정 대기 | 자료 없음 |`;
      const sample = JSON.parse(readFileSync(path, 'utf8'));
      const sheetPath = join(out, 'sheets', `gold-${person}.json`);
      const sheet = existsSync(sheetPath) ? JSON.parse(readFileSync(sheetPath, 'utf8')) : null;
      validatePersonGold(person, sample, sheet, matches);
      const selected = sample.sample.filter((item) => item.predicted === 'mine');
      const correct = selected.filter((item) => sample.labels[item.number] === true).length;
      return `| ${person} | ${selected.length} | ${percentage(correct, selected.length)} |`;
    });
    const path = join(root, relativeReport);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    let before = '';
    let after = '\n\n## 오너 메모\n\n';
    if (existing) {
      const front = existing.match(/^---\n[\s\S]*?\n---\n/);
      const fields = parseFrontmatter(existing);
      if (!front || fields.type !== 'report' || fields.author !== 'zeus'
        || existing.split(REPORT_START).length !== 2 || existing.split(REPORT_END).length !== 2
        || existing.indexOf(REPORT_START) < front[0].length
        || existing.indexOf(REPORT_END) < existing.indexOf(REPORT_START)) {
        throw new Error('기존 얼굴 리포트 표식/소유권 오류');
      }
      before = existing.slice(front[0].length, existing.indexOf(REPORT_START));
      after = existing.slice(existing.indexOf(REPORT_END) + REPORT_END.length);
    }
    const albumsFile = join(root, VAULT_REL.mediaImportAlbums);
    const albumData = existsSync(albumsFile) ? JSON.parse(readFileSync(albumsFile, 'utf8')) : {};
    const albums = albumData.albums ?? albumData;
    const mediaById = new Map(mediaRows(root).map((row) => [row.id, row]));
    const reportMatches = matches.map((face) => {
      const media = mediaById.get(face.id);
      return { ...face,
        ...(face.person ? { score: face.mineScore,
          label: face.prebirth || face.mineScore == null ? 'other' : classifyFaceScore(face.mineScore) } : {}),
        album: media?.album ?? null,
        source: media?.importPath ? 'Imports' : media?.archivePath ? 'Archive' : null };
    });
    const note = `${buildFrontmatter({ type: 'report',
      category: [categoryLink('201 미네'), categoryLink('500 기술')],
      description: '미네 얼굴 인식 정확도 검증', sensitivity: '개인',
      created: date, modified: date,
      author: 'zeus', model: 'media-faces' })}${before}${REPORT_START}\n${reportGenerated(reportMatches, gallery, metrics, albums, join(out, 'sheets', 'gold.html'))}\n### 가족별 표본 정밀도\n\n| 사람 | 자동 판정 표본 | 정밀도 |\n|---|---:|---:|\n${familyRows.join('\n')}\n${REPORT_END}${after}`;
    const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
    const problems = checkNote(relativeReport, note, rules);
    if (problems.length) throw new Error(`리포트 경로 검사 실패: ${problems.join('; ')}`);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, note);
    output.log(`[media-faces] 리포트 ${relativeReport}`);
    return { matches: matches.length, metrics };
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export function selectPersonGoldSample(matches, person) {
  const select = (low, high, limit) => {
    const bestByPhoto = new Map();
    for (const face of matches) {
      if (face.person !== person || face.score < low || face.score >= high) continue;
      const previous = bestByPhoto.get(face.id);
      if (!previous || face.score > previous.score) bestByPhoto.set(face.id, face);
    }
    return [...bestByPhoto.values()].sort((left, right) =>
      sheetHash(`${person}:${left.id}`).localeCompare(sheetHash(`${person}:${right.id}`)))
      .slice(0, limit);
  };
  return [...select(PHOTO_HIGH, Infinity, 40), ...select(PHOTO_HOLD, PHOTO_HIGH, 20)]
    .map((face, index) => ({ number: index + 1, id: face.id, i: face.i,
      predicted: face.score >= PHOTO_HIGH ? 'mine' : 'uncertain', score: face.score,
      band: face.band, winner: true }));
}

export async function goldSheetMediaFaces({ root = VAULT_PATHS.root,
  mediaRoot = MEDIA_FACES_PATHS.mediaRoot, out = MEDIA_FACES_PATHS.root,
  indexPath = MEDIA_FACES_PATHS.index, matchesPath = join(out, 'matches.jsonl'),
  count = 200, person = null, cropper = runCropFaces, output = console } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new Error('골드 표본 크기 오류');
  if (person && !['휘영', '나'].includes(person)) throw new Error('가족 표본 사람 오류');
  const execute = async () => {
    const quotas = { mine: Math.round(count * 0.4), uncertain: Math.round(count * 0.3) };
    quotas.other = count - quotas.mine - quotas.uncertain;
    const matches = jsonLines(matchesPath);
    const sample = person ? selectPersonGoldSample(matches, person) : selectGoldSample(matches, quotas);
    const source = new Map(mediaRows(root).map((row) => [row.id, row]));
    const faceIndex = new Map(jsonLines(indexPath).map((row) => [row.id, row]));
    const cropPath = join(out, 'crops');
    const images = sample.map((member) => {
      const record = source.get(member.id);
      const face = faceIndex.get(member.id)?.faces?.find((item) => item.i === member.i);
      if (!record || !Array.isArray(face?.bbox) || face.bbox.length !== 4) {
        throw new Error(`골드 표본 원본/좌표 누락: ${member.number}`);
      }
      return { id: member.id, i: member.i, path: safeMediaPath(mediaRoot, record),
        bbox: face.bbox, out: join(cropPath, `${person ? `gold-${person}` : 'gold'}-${member.number}.jpg`) };
    });
    mkdirSync(cropPath, { recursive: true });
    const cropped = new Set(await cropper(images));
    if (cropped.size !== images.length || images.some((image) => !cropped.has(image.out))) {
      throw new Error('골드 표본 얼굴 조각 생성 누락');
    }
    const sheetsPath = join(out, 'sheets');
    mkdirSync(sheetsPath, { recursive: true });
    writeAtomic(join(sheetsPath, `${person ? `gold-${person}` : 'gold'}.json`), `${JSON.stringify({ sample }, null, 2)}\n`);
    writeAtomic(join(sheetsPath, `${person ? `gold-${person}` : 'gold'}.html`),
      person ? renderPersonGoldSheet(person, sample) : renderFaceSheet({ sample }));
    output.log(`[media-faces] 골드 표본 ${sample.length}개`);
    return sample;
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

export function parseGoldCorrections(text, sample) {
  const labels = Object.fromEntries(sample.map((member) => [member.number,
    member.predicted === 'mine']));
  const byNumber = new Map(sample.map((member) => [member.number, member]));
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^(미네가 아닌 번호|미네인데 아니라고 한 번호)\s*:\s*(.*)$/);
    if (!match) throw new Error(`골드 판정 형식 오류: ${line}`);
    if (seen.has(match[1])) throw new Error(`골드 판정 항목 중복: ${match[1]}`);
    seen.add(match[1]);
    const value = match[1] === '미네인데 아니라고 한 번호';
    const numbers = match[2] ? match[2].split(',').map((part) => part.trim()) : [];
    for (const part of numbers) {
      if (!/^\d+$/.test(part)) throw new Error(`골드 판정 번호 오류: ${part}`);
      const number = Number(part);
      const member = byNumber.get(number);
      if (!member || (member.predicted === 'mine') === value) {
        throw new Error(`골드 판정 번호/방향 오류: ${number}`);
      }
      labels[number] = value;
    }
  }
  if (seen.size !== 2) throw new Error('두 교정 목록을 모두 입력해야 합니다');
  return labels;
}

export async function recordGoldLabels(input, { out = MEDIA_FACES_PATHS.root,
  person = null, goldPath = join(out, person ? `gold-${person}-labels.json` : 'gold-labels.json'),
  output = console } = {}) {
  const execute = () => {
    const sheetName = person ? `gold-${person}.json` : 'gold.json';
    const { sample } = JSON.parse(readFileSync(join(out, 'sheets', sheetName), 'utf8'));
    const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
    const content = existsSync(expanded) ? readFileSync(expanded, 'utf8') : input;
    if (content === input && !new RegExp(`^\\s*\\uFEFF?${person ?? '미네'}가 아닌 번호\\s*:`).test(input)) {
      throw new Error(`파일을 찾을 수 없음: ${expanded}`);
    }
    const labels = parseGoldCorrections(person ? content
      .replaceAll(`${person}가 아닌 번호`, '미네가 아닌 번호')
      .replaceAll(`${person}인데 아니라고 한 번호`, '미네인데 아니라고 한 번호') : content, sample);
    writeAtomic(goldPath, `${JSON.stringify({ sample, labels }, null, 2)}\n`);
    output.log(`[media-faces] 골드 라벨 ${sample.length}개`);
    return { sample, labels };
  };
  mkdirSync(out, { recursive: true });
  return withLock(join(out, '.media-faces'), execute, { retries: 0 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const pipeline = ['--detect', '--match', '--label'].every((command) => args.includes(command));
  if (pipeline) {
    let options;
    try { options = parseFacePipelineArgs(args); } catch {
      console.error('usage: media-faces.mjs --detect --match --label [--limit=N] [--ids=a,b] [--dry-run]');
      process.exitCode = 2;
    }
    if (options) runFacePipeline(options).catch((error) => {
      console.error(`[media-faces] ${error.stack}`);
      process.exitCode = 1;
    });
  } else {
  const newCommands = ['--label', '--hold-sheet', '--family-cluster',
    ...args.filter((arg) => arg.startsWith('--hold=') || arg.startsWith('--family-confirm='))];
  const newSelected = newCommands.filter((command) => args.includes(command));
  if (newSelected.length) {
    const command = newSelected[0];
    const allNo = args.includes('--hold-all-no');
    if (newSelected.length !== 1 || args.length !== (allNo ? 2 : 1)
      || allNo && !command.startsWith('--hold=')) {
      console.error('usage: media-faces.mjs --label | --hold-sheet | --hold=hold-YYYY-MM.txt [--hold-all-no] | --family-cluster | --family-confirm="휘영:3,7;나:1"');
      process.exitCode = 2;
    } else (command === '--label' ? labelMediaFaces()
      : command === '--hold-sheet' ? holdSheetMediaFaces()
        : command === '--family-cluster' ? clusterFamilyFaces()
          : command.startsWith('--hold=') ? confirmHoldFaces(command.slice(7), { allNo })
            : confirmFamilyFaces(command.slice(17))).catch((error) => {
      console.error(`[media-faces] ${error.stack}`);
      process.exitCode = 1;
    });
  } else {
  const rawLimit = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
  const ids = args.find((arg) => arg.startsWith('--ids='))?.slice(6).split(',') ?? null;
  const limit = rawLimit === undefined ? 500 : Number(rawLimit);
  const commands = ['--detect', '--cluster', '--sheets', '--match', '--report', '--gold-sheet',
    ...args.filter((arg) => arg.startsWith('--confirm=') || arg.startsWith('--gold='))];
  const selected = commands.filter((command) => args.includes(command));
  const confirm = args.find((arg) => arg.startsWith('--confirm='))?.slice(10);
  const rawRemove = args.find((arg) => arg.startsWith('--remove='))?.slice(9);
  const removeNumbers = rawRemove === undefined || rawRemove === '' ? [] : rawRemove.split(',').map(Number);
  const validDetect = selected[0] === '--detect' && args.every((arg) => arg === '--detect'
    || arg === '--dry-run' || arg.startsWith('--limit=') || arg.startsWith('--ids='))
    && Number.isInteger(limit) && limit >= 0 && !ids?.some((id) => !id);
  const validConfirm = selected.length === 1 && confirm && FACE_BANDS.includes(confirm)
    && args.every((arg) => arg.startsWith('--confirm=') || arg.startsWith('--remove='))
    && removeNumbers.every((number) => Number.isInteger(number) && number > 0);
  const goldInput = args.find((arg) => arg.startsWith('--gold='))?.slice(7);
  const person = args.find((arg) => arg.startsWith('--person='))?.slice(9) ?? null;
  const rawGoldCount = args.find((arg) => arg.startsWith('--gold-size='))?.slice(12);
  const goldCount = rawGoldCount === undefined ? 200 : Number(rawGoldCount);
  const validGoldSheet = selected[0] === '--gold-sheet'
    && args.every((arg) => arg === '--gold-sheet' || arg.startsWith('--gold-size=') || arg.startsWith('--person='))
    && (!person || ['휘영', '나'].includes(person))
    && Number.isInteger(goldCount) && goldCount > 0;
  const validGold = selected.length === 1 && selected[0].startsWith('--gold=')
    && args.every((arg) => arg.startsWith('--gold=') || arg.startsWith('--person='))
    && (!person || ['휘영', '나'].includes(person)) && !!goldInput;
  if (selected.length !== 1 || !(validDetect || selected[0] === '--cluster' && args.length === 1
    || selected[0] === '--sheets' && args.length === 1 || validConfirm
    || selected[0] === '--match' && args.length === 1
    || selected[0] === '--report' && args.length === 1 || validGoldSheet || validGold)) {
    console.error('usage: media-faces.mjs --detect [--limit=N] [--ids=a,b] [--dry-run] | --cluster | --sheets | --confirm=BAND [--remove=1,2] | --match | --report | --gold-sheet [--gold-size=N] | --gold="미네가 아닌 번호: 3,7; 미네인데 아니라고 한 번호: 12"');
    process.exitCode = 2;
  } else (selected[0] === '--detect' ? runMediaFaces({ limit, ids, dryRun: args.includes('--dry-run') })
    : selected[0] === '--cluster' ? clusterMediaFaces()
      : selected[0] === '--sheets' ? sheetMediaFaces()
        : selected[0] === '--match' ? matchMediaFaces()
          : selected[0] === '--report' ? reportMediaFaces()
            : selected[0] === '--gold-sheet' ? goldSheetMediaFaces({ count: person ? 60 : goldCount, person })
              : validGold ? recordGoldLabels(goldInput, { person })
                : confirmMediaFaces(confirm, removeNumbers)).catch((error) => {
    console.error(`[media-faces] ${error.stack}`);
    process.exitCode = 1;
  });
  }
  }
}
