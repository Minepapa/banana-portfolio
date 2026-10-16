// 과거 앨범의 불확실한 날짜를 로컬 HTML에서 묶음으로 판정한다.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { capturedTime, kstIso } from './media-archive.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';

const exec = promisify(execFile);
const video = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
const isoDay = (date) => kstIso(date).slice(0, 10);
const validDay = (day) => {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === date;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fingerprint = (record) => [record.id, record.importPath, record.size, record.mtime,
  record.capturedAt, record.capturedConfidence].join('\0');
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function candidateDates(record, tags = {}, album = {}) {
  const filename = basename(record.importPath);
  const stat = { mtimeMs: record.mtime };
  const base = { path: filename, stat };
  const sources = [
    ['EXIF DateTimeOriginal', tags.DateTimeOriginal], ['EXIF CreateDate', tags.CreateDate],
    ['EXIF MediaCreateDate', tags.MediaCreateDate],
  ];
  const result = [];
  for (const [source, value] of sources) {
    if (!value) continue;
    const selected = capturedTime(base, { DateTimeOriginal: source === 'EXIF DateTimeOriginal' ? value : undefined,
      CreateDate: source === 'EXIF CreateDate' ? value : undefined,
      MediaCreateDate: source === 'EXIF MediaCreateDate' ? value : undefined });
    if (selected.from === 'exif') result.push({ date: isoDay(selected.date), source });
    else {
      const rawDay = typeof value === 'string' ? value.slice(0, 10).replace(/:/g, '-') : null;
      if (validDay(rawDay)) result.push({ date: rawDay, source: `${source} (카메라 시계 의심)` });
    }
  }
  const filenameOnly = capturedTime(base, {});
  if (filenameOnly.from === 'filename') result.push({ date: isoDay(filenameOnly.date),
    source: filenameOnly.confidence === 'estimated' ? '파일명 (저장 시각 상한)' : '파일명' });
  if (Number.isFinite(record.mtime)) result.push({ date: isoDay(new Date(record.mtime)), source: '파일 수정 시각 (약한 근거)' });
  for (const year of album.years ?? []) if (Number.isInteger(year) && year >= 1900 && year <= 2100)
    result.push({ date: String(year), source: '앨범 연도 이름표 (연도만)' });
  return [...new Map(result.map((item) => [`${item.date}\0${item.source}`, item])).values()];
}

function safeSource(record, mediaRoot) {
  if (record.kind !== 'Import' || typeof record.id !== 'string'
    || !/^Imports\/[^/]+\/.+/.test(record.importPath ?? '') || record.importPath.split('/').includes('..')
    || !record.importPath.startsWith(`Imports/${record.album}/`)) throw new Error('색인 Imports 경로 오류');
  const path = resolve(mediaRoot, record.importPath);
  if (!path.startsWith(resolve(mediaRoot, 'Imports') + sep)) throw new Error('색인 경로 범위 오류');
  if (!realpathSync(path).startsWith(realpathSync(join(mediaRoot, 'Imports')) + sep))
    throw new Error('원본 심링크 범위 오류');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size !== record.size || stat.mtimeMs !== record.mtime)
    throw new Error(`원본 변경: ${record.importPath}`);
  return path;
}

async function metadata(records, mediaRoot, exiftoolPath) {
  const found = new Map();
  for (let start = 0; start < records.length; start += 200) {
    const batch = records.slice(start, start + 200).map((record) => safeSource(record, mediaRoot));
    const { stdout } = await exec(exiftoolPath, ['-json', '-n', '-DateTimeOriginal', '-CreateDate',
      '-MediaCreateDate', '-Model', ...batch], { maxBuffer: 32 * 1024 * 1024 });
    for (const row of JSON.parse(stdout)) found.set(row.SourceFile, row);
  }
  return found;
}

export function groupReviewRecords(records, albums, tagsByPath = new Map(), { includeEstimated = false } = {}) {
  const pending = records.filter((record) => record.kind === 'Import'
    && !record.reviewDecision && (record.capturedConfidence === 'review'
      || (includeEstimated && record.capturedConfidence === 'estimated')));
  const byAlbum = new Map();
  for (const record of pending) {
    const candidates = candidateDates(record, tagsByPath.get(record.importPath) ?? {}, albums[record.album] ?? {});
    const preferred = candidates.find((item) => item.source === '파일명')
      ?? candidates.find((item) => item.source === '파일명 (저장 시각 상한)')
      ?? candidates.find((item) => item.source === 'EXIF DateTimeOriginal')
      ?? candidates.find((item) => item.date.length === 10);
    const date = preferred?.date ?? record.capturedAt.slice(0, 10);
    const device = tagsByPath.get(record.importPath)?.Model || basename(record.importPath).split(/[_\d]/)[0];
    const key = `${record.album}\0${date}\0${device}`;
    if (!byAlbum.has(key)) byAlbum.set(key, []);
    byAlbum.get(key).push({ record, candidates, date, device });
  }
  const groups = [];
  for (const rows of byAlbum.values()) {
    rows.sort((a, b) => Date.parse(a.record.capturedAt) - Date.parse(b.record.capturedAt)
      || a.record.importPath.localeCompare(b.record.importPath));
    let current = [];
    for (const row of rows) {
      if (current.length && Date.parse(row.record.capturedAt) - Date.parse(current.at(-1).record.capturedAt) > 10 * 60_000) {
        groups.push(current); current = [];
      }
      current.push(row);
    }
    if (current.length) groups.push(current);
  }
  return groups.map((rows) => ({ id: digest(rows.map((row) => fingerprint(row.record)).sort().join('\n')),
    album: rows[0].record.album, label: albums[rows[0].record.album]?.label || rows[0].record.album,
    records: rows.map((row) => row.record),
    candidates: [...new Map(rows.flatMap((row) => row.candidates)
      .map((item) => [`${item.date}\0${item.source}`, item])).values()],
    device: rows[0].device }));
}

export function confirmedNeighbors(group, allRecords) {
  const near = allRecords.filter((record) => record.album === group.album
    && ['confirmed', 'single'].includes(record.capturedConfidence))
    .sort((a, b) => Math.abs(Date.parse(a.capturedAt) - Date.parse(group.records[0].capturedAt))
      - Math.abs(Date.parse(b.capturedAt) - Date.parse(group.records[0].capturedAt)));
  return near.slice(0, 2).map((record) => ({ date: record.capturedAt.slice(0, 10),
    name: basename(record.importPath) }));
}

export async function thumbnail(record, mediaRoot, ffmpegPath = '/opt/homebrew/bin/ffmpeg') {
  const path = safeSource(record, mediaRoot);
  const args = ['-nostdin', '-loglevel', 'error', '-i', path];
  if (video.has(extname(path).toLowerCase())) args.push('-frames:v', '1');
  args.push('-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-map_metadata', '-1',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-');
  const { stdout } = await exec(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
}

export function renderReviewHtml(groups, includeEstimated = false) {
  const cards = groups.map((group) => {
    const choices = [...new Set(group.candidates.filter((item) => item.date.length === 10).map((item) => item.date))];
    const candidates = group.candidates.map((item) => `<li>${escapeHtml(item.date)} — ${escapeHtml(item.source)}</li>`).join('');
    const neighbors = group.neighbors.map((item) => `${escapeHtml(item.date)} ${escapeHtml(item.name)}`).join(' · ');
    return `<section class="card" data-id="${group.id}"><h2>${escapeHtml(group.label)} · ${group.records.length}개</h2>
      <div class="thumbs">${group.thumbnails.map((src) => `<img src="${src}" alt="대표 사진">`).join('')}</div>
      <p>기종: ${escapeHtml(group.device)} · 이웃 확정 사진: ${neighbors || '없음'}</p><ul>${candidates}</ul>
      <div class="actions">${choices.map((date) => `<button type="button" data-action="date" data-date="${date}">${date} 선택</button>`).join('')}
      <input type="date" aria-label="날짜 직접 입력"><button type="button" data-action="custom">직접 입력 날짜 선택</button>
      <button type="button" data-action="album">날짜 모름 — 앨범 기준</button>
      <button type="button" data-action="exclude">제외 유지</button></div><strong class="result">미판정</strong></section>`;
  }).join('\n');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>과거 앨범 날짜 판정</title>
<style>body{font:16px system-ui;max-width:1100px;margin:auto;padding:24px;background:#f7f5f0;color:#1d2522}.card{background:white;border:1px solid #ddd;border-radius:16px;padding:20px;margin:18px 0}.thumbs{display:flex;gap:8px;flex-wrap:wrap}.thumbs img{max-width:180px;max-height:180px;object-fit:contain}button{padding:8px;margin:4px;border:1px solid #395;border-radius:7px;background:#edf6ef;cursor:pointer}button.selected{background:#174;color:white}.result{display:block;margin-top:8px}</style>
<h1>과거 앨범 날짜 판정</h1><p>묶음 전체에 같은 결정을 적용합니다. 날짜 모름은 원래 시각을 촬영 확정일로 승격하지 않습니다.</p>
<p id="progress"></p><button id="export" type="button">JSON 내보내기</button>${cards}
<script>const answers={};const cards=[...document.querySelectorAll('.card')];
function progress(){document.querySelector('#progress').textContent='진행률 '+Object.keys(answers).length+' / '+cards.length+' 묶음';}
for(const card of cards){card.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button)return;
const action=button.dataset.action;const date=action==='date'?button.dataset.date:action==='custom'?card.querySelector('input').value:null;
if((action==='date'||action==='custom')&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(date||'')){alert('YYYY-MM-DD 날짜를 입력하세요.');return;}
answers[card.dataset.id]={action,date};card.querySelectorAll('button').forEach(item=>item.classList.toggle('selected',item===button));
card.querySelector('.result').textContent=action==='album'?'날짜 모름 — 앨범 기준':action==='exclude'?'제외 유지':date+' 선택';progress();});}
document.querySelector('#export').onclick=()=>{const blob=new Blob([JSON.stringify({version:1,includeEstimated:${includeEstimated},answers},null,2)],{type:'application/json'});
const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='import-review-answers.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);};progress();</script></html>`;
}

export async function reviewGroups({ root = VAULT_PATHS.root, mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  includeEstimated = false, metadataForRecords = metadata, exiftoolPath = '/opt/homebrew/bin/exiftool' } = {}) {
  const records = readFileSync(join(root, VAULT_REL.mediaImportsIndex), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const albums = JSON.parse(readFileSync(join(root, VAULT_REL.mediaImportAlbums), 'utf8')).albums;
  const pending = records.filter((record) => record.kind === 'Import'
    && !record.reviewDecision && (record.capturedConfidence === 'review'
    || (includeEstimated && record.capturedConfidence === 'estimated')));
  const rawTags = await metadataForRecords(pending, mediaRoot, exiftoolPath);
  const tags = new Map(pending.map((record) => [record.importPath,
    rawTags.get(join(mediaRoot, record.importPath)) ?? rawTags.get(record.importPath) ?? {}]));
  return { records, groups: groupReviewRecords(records, albums, tags, { includeEstimated }) };
}

export async function writeReviewSheet(options = {}) {
  const { mediaRoot = join(homedir(), 'Pantheon', 'Media'), outputDir = join(mediaRoot, 'ImportReview'),
    thumbnailFor = thumbnail, output = console } = options;
  const { records, groups } = await reviewGroups(options);
  for (const group of groups) {
    group.neighbors = confirmedNeighbors(group, records);
    group.thumbnails = [];
    for (const record of group.records.slice(0, 3)) group.thumbnails.push(await thumbnailFor(record, mediaRoot));
  }
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (realpathSync(outputDir) !== join(realpathSync(mediaRoot), 'ImportReview'))
    throw new Error('판정 시트 출력 폴더가 Media/ImportReview 밖을 가리킴');
  chmodSync(outputDir, 0o700);
  const path = join(outputDir, 'import-review.html');
  const temporaryPath = join(outputDir, `.import-review-${randomBytes(12).toString('hex')}.tmp`);
  try {
    // 기존 시트가 다른 파일과 하드링크여도 그 inode를 수정하지 않는다.
    const fd = openSync(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, renderReviewHtml(groups, options.includeEstimated ?? false)); }
    finally { closeSync(fd); }
    chmodSync(temporaryPath, 0o600);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('판정 시트 출력 파일 symbolic link 거부');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    renameSync(temporaryPath, path);
  } finally {
    try { unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  output.log(`[media-imports] 판정 시트 ${groups.length}묶음, ${groups.reduce((sum, group) => sum + group.records.length, 0)}개: ${path}`);
  return { path, groups: groups.length };
}

export async function applyReview({ answersPath, dryRun = false, root = VAULT_PATHS.root,
  write = writeAtomic, output = console, runMoments, ...options } = {}) {
  const document = JSON.parse(readFileSync(answersPath, 'utf8'));
  if (document.version !== 1 || typeof document.includeEstimated !== 'boolean'
    || !document.answers || typeof document.answers !== 'object'
    || Array.isArray(document.answers)) throw new Error('판정 JSON 형식 오류');
  const { records, groups } = await reviewGroups({ root, ...options, includeEstimated: document.includeEstimated });
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const appliedById = new Map();
  for (const record of records) if (record.reviewGroupId) {
    if (!appliedById.has(record.reviewGroupId)) appliedById.set(record.reviewGroupId, []);
    appliedById.get(record.reviewGroupId).push(record);
  }
  const changed = new Map();
  const reviewIds = new Set();
  for (const [id, answer] of Object.entries(document.answers)) {
    if (!answer || typeof answer !== 'object' || !['date', 'custom', 'album', 'exclude'].includes(answer.action))
      throw new Error('판정 선택 오류');
    if (['date', 'custom'].includes(answer.action) && (!validDay(answer.date)
      || answer.date > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })))
      throw new Error('판정 날짜 오류');
    const group = groupById.get(id);
    if (!group) {
      const applied = appliedById.get(id);
      if (applied && applied.every((record) => record.reviewDecision === answer.action
        && (answer.action === 'album' || answer.action === 'exclude'
          || record.capturedAt.slice(0, 10) === answer.date))) {
        if (answer.action !== 'exclude') for (const record of applied) reviewIds.add(record.id);
        continue;
      }
      throw new Error(`판정 묶음 불일치/색인 변경: ${id}`);
    }
    if (answer.action === 'date' && !group.candidates.some((item) => item.date === answer.date))
      throw new Error('후보 날짜 불일치');
    if (answer.action === 'custom') {
      const albums = JSON.parse(readFileSync(join(root, VAULT_REL.mediaImportAlbums), 'utf8')).albums;
      const years = (albums[group.album]?.years ?? []).filter(Number.isInteger);
      if (years.length && (Number(answer.date.slice(0, 4)) < Math.min(...years) - 1
        || Number(answer.date.slice(0, 4)) > Math.max(...years) + 1))
        (output.warn ?? output.log).call(output, `[media-imports] 판정 연도 경고: ${group.album} ${answer.date} (앨범 ${years.join('–')})`);
    }
    for (const record of group.records) {
      if (changed.has(record.importPath)) throw new Error('중복 판정');
      if (answer.action === 'exclude') {
        changed.set(record.importPath, { ...record, reviewDecision: 'exclude', reviewGroupId: id });
        continue;
      }
      const next = { ...record, reviewDecision: answer.action, reviewGroupId: id,
        capturedConfidence: answer.action === 'album' ? 'album' : 'single',
        capturedReason: answer.action === 'album' ? '날짜 미상: 앨범 기준' : '오너 날짜 판정',
        ...(answer.action === 'album' ? {} : { capturedAt: `${answer.date}${record.capturedAt.slice(10)}`, capturedFrom: 'owner' }) };
      changed.set(record.importPath, next);
      reviewIds.add(record.id);
    }
  }
  const nextRecords = records.map((record) => changed.get(record.importPath) ?? record);
  const edits = nextRecords.filter((record, index) => JSON.stringify(record) !== JSON.stringify(records[index]));
  const summary = { changed: edits.length, selected: Object.keys(document.answers).length, moments: null };
  if (runMoments && reviewIds.size) {
    // 모든 쓰기 관문을 먼저 확인한다. 중단 후 같은 답안을 재실행해 남은 노트를 처리할 수 있다.
    summary.moments = await runMoments({ root, dryRun: true, limit: 300,
      noCalendar: true, noPoi: true, indexRecords: nextRecords, reviewIds });
  }
  if (!dryRun && edits.length) {
    const indexPath = join(root, VAULT_REL.mediaImportsIndex);
    await withLock(indexPath, () => {
      const current = readFileSync(indexPath, 'utf8');
      if (current !== records.map((record) => JSON.stringify(record)).join('\n') + '\n') throw new Error('색인이 판정 중 변경됨');
      write(indexPath, nextRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
    });
  }
  if (!dryRun && runMoments && reviewIds.size) summary.moments = await runMoments({ root, dryRun: false, limit: 300,
    indexRecords: nextRecords, reviewIds });
  output.log(`[media-imports] ${dryRun ? 'dry-run ' : ''}판정 ${JSON.stringify(summary)}`);
  return summary;
}
