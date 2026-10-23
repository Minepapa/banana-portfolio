// 📎 메모는 Archive 순간 노트가 생성된 뒤에만 연결한다. 별도 잡으로 돌리면
// 사진 색인과 순간 상태 사이의 시차 때문에 새 사진의 연결을 놓치기 쉽다.
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { checkNote } from '../lib/vault-registry.mjs';
import { loadVisionConfig } from './media-vision.mjs';

const PRINTS = fileURLToPath(new URL('../.cache/vision-prints/', import.meta.url));
const DAY_MS = 86_400_000;
const IMAGE = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png']);

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function noteFiles(root, rel, output) {
  const path = join(root, rel);
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch (error) {
    // 메모가 모두 옮겨져 빈 Inbox 폴더가 사라진 경우는 '비어 있음'이다(2026-10-23).
    if (error.code === 'ENOENT') return [];
    output.log(`[media-photo-memos] 실패: ${rel} — ${String(error.message).split(/[\r\n]/, 1)[0]}`);
    return [];
  }
  return entries.flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return noteFiles(root, child, output);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

function pendingPhotoMemo(path) {
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(16_384);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const head = bytes.toString('utf8', 0, length);
    return /^---\n[\s\S]*?\nphotoLink:\s*['"]?대기['"]?\s*\n[\s\S]*?\n---\n/m.test(head)
      || /^photoMatchedId:\s*\S+/m.test(head);
  } finally { closeSync(descriptor); }
}

function vector(path, dimensions) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length !== dimensions * 4) return null;
  return Float32Array.from({ length: dimensions }, (_, index) => bytes.readFloatLE(index * 4));
}

function distance(a, b) {
  let squared = 0;
  for (let index = 0; index < a.length; index += 1) squared += (a[index] - b[index]) ** 2;
  return Math.sqrt(squared);
}

function removeMemoPrint(printsPath, photoPrint) {
  if (/^memo-[A-Za-z0-9-]+$/.test(photoPrint ?? '')) rmSync(join(printsPath, `${photoPrint}.f32`), { force: true });
}

export function matchPhotoMemo(fields, archive, vision, { printsPath = PRINTS, config = loadVisionConfig(''), momentByPhoto } = {}) {
  const captured = Date.parse(fields.capturedAt);
  if (!Number.isFinite(captured) || !/^memo-[A-Za-z0-9-]+$/.test(fields.photoPrint)) return null;
  const matches = [];
  const memoPrint = new Map();
  for (const record of archive) {
    const time = Date.parse(record.capturedAt);
    const row = vision.get(record.id);
    if (!/^[A-Za-z0-9_-]+$/.test(record.id) || !record.archivePath || !IMAGE.has(extname(record.archivePath).toLowerCase())
      || !Number.isFinite(time) || time > captured || captured - time > 30 * DAY_MS
      || !row || row.source !== 'archive' || row.schema !== 2 || row.error) continue;
    if (!memoPrint.has(row.printDims)) memoPrint.set(row.printDims, vector(join(printsPath, `${fields.photoPrint}.f32`), row.printDims));
    const reference = memoPrint.get(row.printDims);
    const original = vector(join(printsPath, `${record.id}.f32`), row.printDims);
    if (reference && original) matches.push({ id: record.id, duplicateGroup: row.duplicateGroup,
      distance: distance(reference, original) });
  }
  matches.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const [first, second] = matches;
  return first && first.distance <= config.memoMatchDistance
    && (!second || second.distance - first.distance >= config.memoMatchMargin
      || (first.duplicateGroup && first.duplicateGroup === second.duplicateGroup)
      || (momentByPhoto?.get(first.id) && momentByPhoto.get(first.id) === momentByPhoto.get(second.id))) ? first : null;
}

function replaceFields(content, updates) {
  return content.replace(/^---\n[\s\S]*?\n---\n/, () => updateFrontmatter(content, updates));
}

export async function linkPhotoMemos({ root, state, archive, dryRun = false, now = new Date().toISOString(),
  printsPath = PRINTS, write = writeAtomic, registryRules, output = console } = {}) {
  const candidates = [VAULT_REL.inboxRoot, VAULT_REL.recordsNotes]
    .flatMap((rel) => noteFiles(root, rel, output));
  if (!candidates.length) return { linked: 0, expired: 0, failed: 0 };
  let config;
  try { config = loadVisionConfig(join(root, VAULT_REL.mediaVisionLabels)); }
  catch (error) {
    output.log(`[media-moments] vision 설정 오류: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
  }
  const vision = new Map(jsonLines(join(root, VAULT_REL.mediaVisionIndex)).map((row) => [row.id, row]));
  const momentByPhoto = new Map();
  for (const entry of Object.values(state)) for (const id of entry.mediaIds ?? []) momentByPhoto.set(id, entry.notePath);
  const summary = { linked: 0, expired: 0, failed: 0 };
  const today = new Date(Date.parse(now) + 9 * 3_600_000).toISOString().slice(0, 10);
  for (const memoRel of candidates) {
    try {
    const memoPath = join(root, memoRel);
    if (!pendingPhotoMemo(memoPath)) continue;
    const memo = readFileSync(memoPath, 'utf8');
    const fields = parseFrontmatter(memo);
    // 제목 변경으로 순간 노트가 이동해도 이미 연결된 메모의 링크는 현재 상태를 따른다.
    if (fields.photoMatchedId && typeof fields.photoLink === 'string' && fields.photoLink.startsWith('[[')) {
      const currentRel = momentByPhoto.get(fields.photoMatchedId);
      if (currentRel && existsSync(join(root, currentRel))) {
        const momentPath = join(root, currentRel);
        const moment = readFileSync(momentPath, 'utf8');
        const current = parseFrontmatter(moment);
        const target = `[[${currentRel.replace(/\.md$/, '')}]]`;
        if ((current.mediaIds ?? []).includes(fields.photoMatchedId)) {
          const memoLink = `[[${memoRel.replace(/\.md$/, '')}]]`;
          const movedFrom = Array.isArray(fields.movedFrom) ? fields.movedFrom
            : fields.movedFrom ? [fields.movedFrom] : [];
          const oldLinks = new Set(movedFrom.map((path) => `[[${String(path).replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '')}]]`));
          const priorMemos = Array.isArray(current.memos) ? current.memos : [];
          const hasOldLink = priorMemos.some((link) => oldLinks.has(link));
          let updatedMoment = moment;
          if (hasOldLink) {
            const memos = [...new Set([...priorMemos.filter((link) => !oldLinks.has(link)), memoLink])];
            updatedMoment = replaceFields(moment, { memos });
            const start = '<!-- media-moments:start -->';
            const end = '<!-- media-moments:end -->';
            const startAt = updatedMoment.indexOf(start);
            const endAt = updatedMoment.indexOf(end);
            if (startAt < 0 || endAt < startAt) throw new Error(`순간 노트 생성 표식 없음: ${currentRel}`);
            const generated = updatedMoment.slice(startAt + start.length, endAt).split('\n')
              .filter((line) => !line.startsWith('- 📎 메모: ') || !oldLinks.has(line.slice('- 📎 메모: '.length)));
            const newLine = `- 📎 메모: ${memoLink}`;
            if (!generated.includes(newLine)) generated.splice(generated.at(-1) === '' ? -1 : generated.length, 0, newLine);
            updatedMoment = `${updatedMoment.slice(0, startAt + start.length)}${generated.join('\n')}${updatedMoment.slice(endAt)}`;
          }
          const updatedMemo = fields.photoLink === target ? memo : replaceFields(memo, { photoLink: target });
          for (const [rel, content] of [[currentRel, updatedMoment], [memoRel, updatedMemo]]) {
            if (content === (rel === currentRel ? moment : memo)) continue;
            const problems = registryRules ? checkNote(rel, content, registryRules) : [];
            if (problems.length) throw new Error(`사진 연결 쓰기 관문: ${problems.join('; ')}`);
          }
          if (!dryRun && updatedMoment !== moment) await withLock(momentPath, () => {
            if (readFileSync(momentPath, 'utf8') !== moment) throw new Error(`쓰기 전 순간 노트 변경: ${currentRel}`);
            write(momentPath, updatedMoment);
          });
          if (!dryRun && updatedMemo !== memo) await withLock(memoPath, () => {
            if (readFileSync(memoPath, 'utf8') !== memo) throw new Error(`쓰기 전 메모 변경: ${memoRel}`);
            write(memoPath, updatedMemo);
          });
          if (updatedMoment !== moment || updatedMemo !== memo) summary.linked += 1;
        }
      }
      continue;
    }
    if (fields.photoLink !== '대기') continue;
    // KST 만료일 다음 날부터는 뒤늦게 색인이 들어와도 자동 연결하지 않는다.
    if (fields.photoMatchUntil && today > fields.photoMatchUntil) {
      const expired = replaceFields(memo, { photoLink: '못 찾음' });
      const problems = registryRules ? checkNote(memoRel, expired, registryRules) : [];
      if (problems.length) throw new Error(`사진 메모 쓰기 관문: ${problems.join('; ')}`);
      if (!dryRun) await withLock(memoPath, () => {
        if (readFileSync(memoPath, 'utf8') !== memo) throw new Error(`쓰기 전 메모 변경: ${memoRel}`);
        write(memoPath, expired);
      });
      if (!dryRun) removeMemoPrint(printsPath, fields.photoPrint);
      summary.expired += 1;
      continue;
    }
    if (!fields.photoPrint) continue;
    if (!config) continue;
    const match = matchPhotoMemo(fields, archive, vision, { printsPath, config, momentByPhoto });
    const momentRel = match && momentByPhoto.get(match.id);
    if (!momentRel || !existsSync(join(root, momentRel))) {
      continue;
    }
    const momentPath = join(root, momentRel);
    const moment = readFileSync(momentPath, 'utf8');
    const momentFields = parseFrontmatter(moment);
    if (!(momentFields.mediaIds ?? []).includes(match.id)) continue;
    const memoLink = `[[${memoRel.replace(/\.md$/, '')}]]`;
    const momentLink = `[[${momentRel.replace(/\.md$/, '')}]]`;
    const memos = [...new Set([...(Array.isArray(momentFields.memos) ? momentFields.memos : []), memoLink])];
    let updatedMoment = replaceFields(moment, { memos });
    if (!updatedMoment.includes(`- 📎 메모: ${memoLink}`)) {
      const end = '<!-- media-moments:end -->';
      if (!updatedMoment.includes(end)) throw new Error(`순간 노트 생성 표식 없음: ${momentRel}`);
      updatedMoment = updatedMoment.replace(end, () => `\n- 📎 메모: ${memoLink}\n${end}`);
    }
    const updatedMemo = replaceFields(memo, { photoLink: momentLink,
      photoMatchedId: match.id, photoMatchDistance: Number(match.distance.toFixed(6)) });
    for (const [rel, content] of [[momentRel, updatedMoment], [memoRel, updatedMemo]]) {
      const problems = registryRules ? checkNote(rel, content, registryRules) : [];
      if (problems.length) throw new Error(`사진 연결 쓰기 관문: ${problems.join('; ')}`);
    }
    if (!dryRun) {
      await withLock(momentPath, () => {
        if (readFileSync(momentPath, 'utf8') !== moment) throw new Error(`쓰기 전 순간 노트 변경: ${momentRel}`);
        write(momentPath, updatedMoment);
      });
      await withLock(memoPath, () => {
        if (readFileSync(memoPath, 'utf8') !== memo) throw new Error(`쓰기 전 메모 변경: ${memoRel}`);
        write(memoPath, updatedMemo);
      });
      removeMemoPrint(printsPath, fields.photoPrint);
    }
    summary.linked += 1;
    } catch (error) {
      summary.failed += 1;
      output.log(`[media-photo-memos] 실패: ${memoRel} — ${String(error.message).split(/[\r\n]/, 1)[0]}`);
    }
  }
  if (summary.linked || summary.expired) output.log(`[media-moments] 사진 메모 ${summary.linked}개 연결, ${summary.expired}개 만료`);
  return summary;
}
