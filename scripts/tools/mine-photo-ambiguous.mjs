#!/usr/bin/env node
/**
 * 미네 사진 순간 애매함 → 오너 검수 시트·반영(2026-11-06, 요청 [[40_Projects/Memory_World/Requests/2026-11-01 사진 구슬 잡 재가동 전 할 일]] 4번).
 *
 * 사진 구슬 잡(media-memory-orb, 사진 글 판)이 같은 순간에 Claude 두 답이 갈리면 노트에 쓰지 않고 판단 기록
 * (Media/MemoryOrb/photo-text-judgments.jsonl)에 status 'ambiguous'와 대표 사진(원본 경로·얼굴 상자)을 남긴다.
 * 통화·녹음 애매함(mine-review-sheet --ambiguous)과 같은 모양으로:
 *   --sheet: 오너 확인을 기다리는 순간을 모아 시트(대표 사진 최대 3장, 메타데이터 지운 사본을 HTML에 넣음) + 번호표.
 *            시트는 이 맥 안에서만 연다(사진은 맥 밖으로 보내지 않는다 — Claude도 부르지 않는다).
 *   --apply <답.json> <번호표.json> [--dry-run]: 오너 답 → 순간 노트 감정 다섯 필드(중요도·장면은 그대로). 사전 상태를 백업하고
 *            판단 기록에 오너 줄(mode orb, engine owner)을 남긴다. 감정이 써진 순간은 구슬이 있는 것으로 보여 잡이 다시 묻지 않는다.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { loadEmotionCriteria, validateEmotionResult } from '../lib/mine-emotion-criteria.mjs';
import { OWNER_ENGINE, appendJudgment, ownerDecided, readJudgments } from '../lib/mine-judgment.mjs';
import { assertFrontmatterRoundTrip, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { PHOTO_TEXT_JUDGMENTS_FILE, PHOTO_TEXT_PROMPT_VERSION } from '../lib/mine-photo-scene.mjs';
import { EMOTION_KEYS, mineAge, occurredDate, replaceEmotionFields } from '../jobs/mine-athena-fields.mjs';
import { RUN_ROOT } from '../jobs/media-memory-orb.mjs';
import { REVIEW_ROOT, ownerFields } from './mine-review-sheet.mjs';
import { boxPercent, renderPhotoSheet, sheetEmotions, sheetPhoto } from './mine-photo-review-sheet.mjs';

const MEDIA_REL = '20_Records/24_Media';
const kstStamp = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace(/[T:]/g, '-');
const kstDay = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

// 순간(id)마다 마지막 줄: 오너 줄이거나 지금 Claude 사진 글 판 줄. 그 줄이 애매함이고 대표 사진이 있으면 대기.
export function pendingPhotoAmbiguous(rows, promptVersion = PHOTO_TEXT_PROMPT_VERSION) {
  const latest = new Map();
  for (const row of rows) {
    if (row?.mode !== 'orb' || typeof row.id !== 'string' || typeof row.rel !== 'string') continue;
    if (row.engine === OWNER_ENGINE || (row.engine === 'claude' && row.promptVersion === promptVersion)) latest.set(row.id, row);
  }
  return [...latest.values()].filter((row) => row.status === 'ambiguous' && Array.isArray(row.photos) && row.photos.length);
}

// 시트 사진 크기(세운 원본)로 얼굴 상자 위치를 표시. 사본 실패한 사진은 빼고, 한 장도 없으면 그 순간을 뺀다.
export function buildAmbiguousSheet({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, ledgerPath = join(RUN_ROOT, PHOTO_TEXT_JUDGMENTS_FILE),
  out = REVIEW_ROOT, now = new Date(), criteria = loadEmotionCriteria(), photo = sheetPhoto, output = console } = {}) {
  const pending = pendingPhotoAmbiguous(readJudgments(ledgerPath));
  const items = pending.flatMap((row) => {
    const path = join(root, row.rel);
    if (!existsSync(path)) { output.error(`순간 노트 없음(옮겨졌으면 잡이 다시 판단): ${row.rel}`); return []; }
    const fields = parseFrontmatter(readFileSync(path, 'utf8'));
    if (ownerDecided(fields)) return [];
    const images = row.photos.flatMap((p) => {
      const source = resolve(mediaRoot, String(p.path ?? ''));
      if (!source.startsWith(`${resolve(mediaRoot)}/`)) { output.error(`미디어 폴더 밖 경로, 뺌: ${p.path}`); return []; }
      try { const image = photo(source); return [{ image: image.dataUrl, box: boxPercent(p.faceBox, image.upright) }]; }
      catch (error) { output.error(`사진 사본 실패, 뺌: ${p.path} — ${error.message}`); return []; }
    });
    if (!images.length) return [];
    const date = occurredDate(fields.occurred) ?? '';
    const age = mineAge(fields.occurred);
    return [{ rel: row.rel, id: row.id, date, age: age == null ? null : `만 ${age}세`, images, answers: row.answers ?? [] }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.rel.localeCompare(b.rel, 'ko'));
  if (!items.length) { output.log('오너 확인을 기다리는 사진 애매함 없음'); return { cards: [] }; }
  const stamp = kstStamp(now);
  const dir = join(out, `photo-ambiguous-${stamp}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const cards = items.map((item, index) => ({ no: index + 1, title: basename(item.rel, '.md'), photoId: item.id, rel: item.rel, id: item.id,
    date: item.date, age: item.age, images: item.images }));
  const sheetPath = join(dir, `photo-ambiguous-sheet-${stamp}.html`);
  writeFileSync(sheetPath, renderPhotoSheet(cards, { title: '미네 사진 애매함 검수', storageKey: `mine-photo-ambiguous-${stamp}`,
    downloadName: `photo-answers-ambiguous-${stamp}.json`, emotions: sheetEmotions(criteria) }),
  { mode: 0o600, flag: 'wx' });
  const cardsPath = join(dir, `cards-photo-ambiguous-${stamp}.json`);
  writeFileSync(cardsPath, `${JSON.stringify(cards.map(({ images, ...rest }) => rest), null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  output.log(`시트: ${sheetPath}\n번호표: ${cardsPath}\n사진 애매함 ${cards.length}개`);
  return { sheetPath, cardsPath, cards, stamp };
}

// 시트 답({ read, state, emo, int, memo }) → 통화·녹음과 같은 오너 필드.
export const photoOwnerFields = (answer) => ownerFields(answer && { emo: answer.state === '있음' ? answer.emo : answer.state, int: Number(answer.int), memo: answer.memo });

const stemOf = (path, prefix) => basename(path).match(new RegExp(`^${prefix}-photo-ambiguous-(\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2})(?: \\(\\d+\\))?\\.json$`))?.[1]
  ?? basename(path).match(new RegExp(`^${prefix}-ambiguous-(\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2})(?: \\(\\d+\\))?\\.json$`))?.[1] ?? null;

export async function applyPhotoAnswers({ answersPath, cardsPath, root = VAULT_PATHS.root, ledgerPath = join(RUN_ROOT, PHOTO_TEXT_JUDGMENTS_FILE),
  out = REVIEW_ROOT, now = new Date(), dryRun = false, criteria = loadEmotionCriteria(), rules, write = writeAtomic, output = console } = {}) {
  const stamp = stemOf(cardsPath, 'cards');
  if (!stamp || stamp !== stemOf(answersPath, 'photo-answers')) throw new Error(`답 파일과 번호표가 같은 시트가 아님: ${basename(answersPath)} ↔ ${basename(cardsPath)}`);
  const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
  const today = kstDay(now);
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const backupPath = join(out, `owner-apply-backup-${today}.jsonl`);
  const summary = { applied: [], same: [], unanswered: [], errors: [] };
  for (const { no, rel, id, title } of cards) {
    const answer = answers[String(no)];
    const fields = photoOwnerFields(answer);
    if (!fields) { summary.unanswered.push(rel); continue; }
    try {
      if (!rel.startsWith(`${MEDIA_REL}/`) || !rel.endsWith('.md') || rel.split('/').includes('..')) throw new Error('순간 노트 경로가 아님');
      if (basename(rel, '.md') !== title || answer.t !== title) throw new Error(`답·번호표·노트 제목이 다름(${answer.t ?? '없음'})`);
      const absolute = join(root, rel);
      const outcome = await withLock(absolute, () => {
        const content = readFileSync(absolute, 'utf8');
        const end = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
        if (end < 0) throw new Error('머리말 없음');
        const head = content.slice(4, end);
        // 들여쓴 줄·블록 목록(폰 속성 편집기 모양)은 줄 단위 교체가 깨뜨릴 수 있다 — 손으로 정리한 뒤 다시(통화·녹음 도구와 같은 규칙).
        if (/^([ \t]+\S|- )/m.test(head)) throw new Error('머리말에 블록 목록·들여쓴 줄이 있음');
        const before = parseFrontmatter(content);
        validateEmotionResult(fields, { recordDate: occurredDate(before.occurred), criteria });
        const next = replaceEmotionFields(content, fields, today);
        if (next === content) return 'same';
        assertFrontmatterRoundTrip(next, fields);
        const problems = checkNote(rel, next, activeRules);
        if (problems.length) throw new Error(`쓰기 관문: ${problems.join('; ')}`);
        if (dryRun) return 'applied';
        mkdirSync(out, { recursive: true, mode: 0o700 });
        appendFileSync(backupPath, `${JSON.stringify({ rel, frontmatter: head, fields: Object.fromEntries([...EMOTION_KEYS, 'modified', 'mineAge'].map((key) => [key, before[key] ?? null])) })}\n`, { mode: 0o600 });
        chmodSync(backupPath, 0o600);
        write(absolute, next);
        return 'applied';
      });
      if (!dryRun && outcome === 'applied') {
        try { appendJudgment(ledgerPath, { mode: 'orb', id, rel, at: today, engine: OWNER_ENGINE, status: 'applied', source: basename(answersPath), fields }); }
        catch (error) { throw new Error(`노트는 썼으나 판단 기록 실패(노트의 오너 표식으로 다시 묻지 않음): ${error.message}`); }
      }
      if (dryRun) output.log(`  ${no}. ${title} → ${fields.primaryEmotion ? `${fields.primaryEmotion} ${fields.emotionIntensity}` : answer.state}`);
      summary[outcome].push(rel);
    } catch (error) { summary.errors.push({ rel, reason: error.message }); }
  }
  output.log(`사진 오너 답 ${dryRun ? '미리보기' : '반영'}: 씀 ${summary.applied.length} · 같음 ${summary.same.length} · 안 고름 ${summary.unanswered.length} · 오류 ${summary.errors.length}`);
  for (const { rel, reason } of summary.errors) output.error(`  오류 ${rel}: ${reason}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const usage = '사용: node scripts/tools/mine-photo-ambiguous.mjs --sheet | --apply <photo-answers-ambiguous-*.json> <cards-photo-ambiguous-*.json> [--dry-run]';
  const fail = (error) => { console.error(`❌ ${error.message}`); process.exitCode = 1; };
  if (args[0] === '--sheet' && args.length === 1) { try { buildAmbiguousSheet(); } catch (error) { fail(error); } }
  else if (args[0] === '--apply' && args.length >= 3 && args.slice(3).every((arg) => arg === '--dry-run')) {
    applyPhotoAnswers({ answersPath: args[1], cardsPath: args[2], dryRun: args.includes('--dry-run') }).catch(fail);
  } else { console.error(usage); process.exitCode = 2; }
}
