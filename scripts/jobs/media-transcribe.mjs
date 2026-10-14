#!/usr/bin/env node
// Archive 색인의 통화·녹음을 로컬에서 전사하고, 전사 원본에서 대화 노트를 재생성한다.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseCallFilename, contactFromFilename, loadPeople, matchPeople } from '../lib/media-people.mjs';
export { parseCallFilename } from '../lib/media-people.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { renderDialogue, counterpartFromNote, shortenSegmentRepetition } from '../lib/media-dialogue.mjs';
import { recordingNoteTitle } from '../lib/media-recording-title.mjs';

const execFileAsync = promisify(execFile);
const START = '<!-- media-transcribe:start -->';
const END = '<!-- media-transcribe:end -->';
const QUIET_PHRASES = new Set([
  '시청해주셔서감사합니다', '구독과좋아요', '구독과좋아요부탁드립니다',
  '감사합니다', '자막제공', '영상편집',
]);
const KST_OFFSET_MS = 9 * 60 * 60_000;
// 2026-10-13 오너 결정: turbo보다 뜻을 바꾸는 오류가 적어 large-v3 사용(실측 실시간 약 3배)
const DEFAULT_MODEL = join(homedir(), 'Pantheon', 'Models', 'whisper', 'ggml-large-v3.bin');

function kstParts(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('시각 형식 오류');
  return new Date(timestamp + KST_OFFSET_MS).toISOString().slice(0, 19);
}

function cleanTitle(value) {
  return String(value).normalize('NFC').replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D/gu, '')
    .replace(/[\\/:*?"<>|\r\n#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
}

function safeArchivePath(mediaRoot, archivePath) {
  if (typeof archivePath !== 'string' || !archivePath.startsWith('Archive/')) throw new Error('보관 경로 오류');
  const archiveRoot = resolve(mediaRoot, 'Archive');
  const path = resolve(mediaRoot, archivePath);
  const inside = relative(archiveRoot, path);
  if (!inside || inside.startsWith('..') || inside.startsWith(sep)) throw new Error('보관 경로 오류');
  // 색인은 외부 입력이다. 심볼릭 링크를 따라 Media 밖 음성을 읽지 않는다.
  let current = archiveRoot;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('보관 경로 심볼릭 링크');
  }
  return path;
}

function readIndex(indexPath) {
  if (!existsSync(indexPath)) return [];
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  if (lines.at(-1) !== '') lines.pop();
  return lines.filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`미디어 색인 ${index + 1}줄 JSON 오류`); }
  });
}

function transcriptPath(root, record) {
  return join(root, VAULT_REL.mediaTranscripts, record.occurred.slice(0, 4), `${record.id}.json`);
}

function existingTranscriptPaths(root) {
  const directory = join(root, VAULT_REL.mediaTranscripts);
  const paths = new Map();
  if (!existsSync(directory)) return paths;
  for (const year of readdirSync(directory).filter((name) => /^\d{4}$/.test(name))) {
    for (const filename of readdirSync(join(directory, year)).filter((name) => /^[a-f0-9]{16}\.json$/i.test(name))) {
      const id = basename(filename, '.json');
      if (paths.has(id)) throw new Error(`중복 전사 원본 ID: ${id}`);
      paths.set(id, join(directory, year, filename));
    }
  }
  return paths;
}

function notePath(record) {
  if (record.kind === 'Recordings' && /^\d{4}-\d{2}-\d{2} \S/.test(record.stem)) {
    return `${VAULT_REL.mediaConversations}/${record.stem.slice(0, 4)}/${recordingNoteTitle(record.stem)}.md`;
  }
  const date = record.occurred.slice(0, 10);
  const suffix = record.kind === 'Calls' ? `${record.counterpart} 통화` : `${record.stem} 녹음`;
  const title = cleanTitle(suffix);
  if (!title) throw new Error('대화 노트 제목 없음');
  return `${VAULT_REL.mediaConversations}/${date.slice(0, 4)}/${date} ${title}.md`;
}

function recordingOwner(root, relPath) {
  const path = join(root, relPath);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start < 0 || end <= start) throw new Error('기존 녹음 노트 소유권 불명');
  const ids = [...content.slice(start, end).matchAll(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/gi)]
    .map((match) => match[1]);
  if (ids.length !== 1) throw new Error('기존 녹음 노트 ID 오류');
  return ids[0];
}

function existingRecordingNotes(root) {
  const base = join(root, VAULT_REL.mediaConversations);
  const found = new Map();
  if (!existsSync(base)) return found;
  for (const year of readdirSync(base).filter((name) => /^\d{4}$/.test(name))) {
    for (const filename of readdirSync(join(base, year)).filter((name) => name.endsWith('.md'))) {
      const rel = `${VAULT_REL.mediaConversations}/${year}/${filename}`;
      const content = readFileSync(join(root, rel), 'utf8');
      const start = content.indexOf(START);
      const end = content.indexOf(END);
      if (start < 0 || end <= start) continue;
      for (const match of content.slice(start, end).matchAll(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/gi)) {
        if (found.has(match[1]) && found.get(match[1]) !== rel) throw new Error(`중복 녹음 노트: ${match[1]}`);
        found.set(match[1], rel);
      }
    }
  }
  return found;
}

function assignNotePaths(records, root) {
  const byBase = new Map();
  for (const record of records) {
    if (!byBase.has(record.notePath)) byBase.set(record.notePath, []);
    byBase.get(record.notePath).push(record);
  }
  for (const [base, group] of byBase) {
    if (group[0].kind === 'Calls') {
      const identities = new Set(group.map((record) => record.people[0]
        ? `person:${record.people[0]}` : `contact:${record.contact}`));
      if (identities.size > 1) throw new Error('서로 다른 통화 상대의 노트 제목 충돌');
      continue;
    }
    const persistedOwner = recordingOwner(root, base);
    const owner = persistedOwner || [...group].sort((a, b) => a.id.localeCompare(b.id))[0].id;
    for (const record of group) {
      if (record.id === owner) continue;
      const legacySuffix = base.replace(/\.md$/, ` ${record.id.slice(0, 8)}.md`);
      const legacyOwner = recordingOwner(root, legacySuffix);
      const candidate = legacyOwner === record.id ? legacySuffix
        : base.replace(/\.md$/, ` ${record.id}.md`);
      const candidateOwner = recordingOwner(root, candidate);
      if (candidateOwner && candidateOwner !== record.id) throw new Error('녹음 노트 경로 충돌');
      record.notePath = candidate;
    }
  }
  const allPaths = records.filter((record) => record.kind === 'Recordings').map((record) => record.notePath);
  if (new Set(allPaths).size !== allPaths.length) throw new Error('녹음 노트 경로 충돌');
}

function prepareRecords(records, people, root, mediaRoot, persistedPaths, model, onTranscriptError) {
  const seen = new Set();
  let excludedCalls = 0;
  const prepared = records.filter((record) => record.kind === 'Calls' || record.kind === 'Recordings')
    .flatMap((record) => {
      if (!/^[a-f0-9]{16}$/i.test(record.id) || seen.has(record.id)) throw new Error('색인 ID 오류 또는 중복');
      seen.add(record.id);
      const path = safeArchivePath(mediaRoot, record.archivePath);
      const filename = basename(path);
      const call = record.kind === 'Calls' ? parseCallFilename(filename) : null;
      const contact = record.kind === 'Calls' ? call?.contact || contactFromFilename(filename) : null;
      if (!Number.isFinite(Date.parse(record.capturedAt))) throw new Error('색인 촬영 시각 오류');
      // Archive 파일명은 오너가 개명한다. 인물 판정에는 변경되지 않는 Inbox 이름을 쓴다.
      const linked = matchPeople(record.kind, record.kind === 'Recordings'
        ? basename(record.inboxPath || filename) : filename, contact, people);
      if (record.kind === 'Calls' && !linked.length) {
        excludedCalls += 1;
        return [];
      }
      const persisted = persistedPaths.get(record.id);
      let transcript = null;
      if (persisted) {
        try { transcript = JSON.parse(readFileSync(persisted, 'utf8')); }
        catch (error) {
          if (!onTranscriptError) throw error;
          onTranscriptError(record.id, error);
          return [];
        }
      }
      if (transcript && (transcript.id !== record.id || !Number.isFinite(Date.parse(transcript.occurred)))) {
        throw new Error(`전사 원본 형식 오류: ${record.id}`);
      }
      const occurred = transcript?.occurred || call?.occurred || record.capturedAt;
      const counterpart = record.kind === 'Calls' ? (linked[0]?.title || cleanTitle(contact)) : null;
      const item = {
        ...record, path, filename, occurred, contact,
        people: linked.map((person) => person.title), family: linked.some((person) => person.family),
        counterpart, stem: record.kind === 'Recordings' && /^\d{4}-\d{2}-\d{2} \S/.test(basename(filename, extname(filename)))
          ? basename(filename, extname(filename)).normalize('NFC') : cleanTitle(basename(filename, extname(filename))),
      };
      item.notePath = notePath(item);
      item.transcriptPath = persisted || transcriptPath(root, item);
      // 모델이 바뀌었거나 구간 시각이 없는 옛 전사 원본은 다시 전사한다.
      item.needsRetranscribe = Boolean(transcript) &&
        (basename(transcript.model || '') !== basename(model) || !Array.isArray(transcript.segments));
      return [item];
    });
  const existingNotes = existingRecordingNotes(root);
  for (const record of prepared) {
    if (record.kind === 'Recordings' && existingNotes.has(record.id)) record.notePath = existingNotes.get(record.id);
  }
  assignNotePaths(prepared, root);
  return { prepared, excludedCalls };
}

function priority(record, recentCutoff) {
  const recent = Date.parse(record.occurred) >= recentCutoff;
  return recent ? (record.people.length ? 0 : 1) : 2;
}

export function orderPending(records, now = new Date()) {
  const cutoff = now.getTime() - 365 * 24 * 60 * 60_000;
  // 녹음 내용을 확인해 파일명을 정리할 수 있도록 통화보다 먼저 전사한다.
  return [...records].sort((a, b) => Number(b.kind === 'Recordings') - Number(a.kind === 'Recordings')
    || priority(a, cutoff) - priority(b, cutoff)
    || Date.parse(b.occurred) - Date.parse(a.occurred) || a.id.localeCompare(b.id));
}

function normalizeSpeech(text) {
  const normalized = String(text).trim().replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  let remainder = normalized;
  for (const phrase of [...QUIET_PHRASES].sort((a, b) => b.length - a.length)) {
    remainder = remainder.split(phrase).join('');
  }
  return remainder.length > 0;
}

// 정규식의 중첩 반복은 긴 Whisper 환각에서 급격히 느려질 수 있어 길이를 제한해 직접 비교한다.
export function detectRepetition(text) {
  const source = String(text ?? '');
  for (let start = 0; start < source.length; start += 1) {
    if (/\s/u.test(source[start])) continue;
    for (let length = 2; length <= 60 && start + length * 8 <= source.length; length += 1) {
      const phrase = source.slice(start, start + length);
      if (/\s/u.test(phrase.at(-1))) continue;
      let cursor = start + length;
      let count = 1;
      while (cursor < source.length) {
        let next = cursor;
        while (next < source.length && /\s/u.test(source[next])) next += 1;
        if (!source.startsWith(phrase, next)) break;
        count += 1;
        cursor = next + length;
      }
      if (count >= 8 && cursor - start >= 80) {
        return { looped: true, phrase, count, span: { start, end: cursor, length: cursor - start } };
      }
    }
  }
  return { looped: false, phrase: null, count: 0, span: null };
}

function longestRepetitionSpan(text) {
  let offset = 0;
  let longest = 0;
  while (offset < text.length) {
    const repetition = detectRepetition(text.slice(offset));
    if (!repetition.looped) break;
    longest = Math.max(longest, repetition.span.length);
    offset += repetition.span.end;
  }
  return longest;
}

function shortenRepetition(text) {
  let offset = 0;
  let rendered = '';
  while (offset < text.length) {
    const repetition = detectRepetition(text.slice(offset));
    if (!repetition.looped) break;
    const { start, end } = repetition.span;
    const match = text.slice(offset + start, offset + end);
    let cursor = 0;
    for (let repeat = 0; repeat < 3; repeat += 1) {
      while (cursor < match.length && /\s/u.test(match[cursor])) cursor += 1;
      cursor += repetition.phrase.length;
    }
    rendered += `${text.slice(offset, offset + start)}${match.slice(0, cursor)} (같은 구절 ${repetition.count - 3}회 반복 — 전사 오류로 줄임)`;
    offset += end;
  }
  return rendered ? rendered + text.slice(offset) : text;
}

export async function durationSec(path, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (!stdout.trim()) throw new Error('오디오 길이 없음');
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) throw new Error('오디오 길이 오류');
  return duration;
}

export async function transcribe(record, { ffmpegPath, ffprobePath, whisperPath, model, temporaryRoot, now,
  directMc0 = false, output = console }) {
  const duration = await durationSec(record.path, ffprobePath);
  const directory = await fs.mkdtemp(join(temporaryRoot, 'media-transcribe-'));
  const wav = join(directory, `${randomUUID()}.wav`);
  try {
    await execFileAsync(ffmpegPath, ['-nostdin', '-loglevel', 'error', '-i', record.path,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { maxBuffer: 1024 * 1024 });
    // 구간별 시각(-oj, 최대 30자·단어 경계)을 남겨 나중에 화자 분리와 맞출 수 있게 한다(2026-10-12 오너 결정).
    const outPrefix = join(directory, 'out');
    const decode = async (maxContext = false) => {
      await fs.rm(`${outPrefix}.json`, { force: true });
      await execFileAsync(whisperPath,
        ['-m', model, '-l', 'ko', '-np', '-oj', '-ml', '30', '-sow',
          ...(maxContext ? ['-mc', '0'] : []), '-of', outPrefix, '-f', wav],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(await fs.readFile(`${outPrefix}.json`, 'utf8'));
      if (!Array.isArray(parsed?.transcription)) throw new Error('Whisper JSON 형식 오류');
      const segments = parsed.transcription.map((segment) => ({
        start: Number(segment?.offsets?.from), end: Number(segment?.offsets?.to), text: String(segment?.text ?? '').trim(),
      })).filter((segment) => segment.text);
      if (segments.some((segment) => !Number.isFinite(segment.start) || !Number.isFinite(segment.end))) {
        throw new Error('Whisper 구간 시각 오류');
      }
      return { segments, text: segments.map((segment) => segment.text).join(' ') };
    };
    let decoded = await decode(directMc0);
    let repetition = detectRepetition(decoded.text);
    let decodeRetry = directMc0 ? 'mc0' : undefined;
    let decodeRetryError;
    if (repetition.looped && !directMc0) {
      try {
        const retry = await decode(true);
        const retryRepetition = detectRepetition(retry.text);
        if (!retryRepetition.looped || longestRepetitionSpan(retry.text) < longestRepetitionSpan(decoded.text)) {
          decoded = retry;
          repetition = retryRepetition;
          decodeRetry = 'mc0';
        }
      } catch (error) {
        // 재시도 실패만으로 원래 전사 원문을 잃지 않는다. 반복 표시는 렌더에서 처리한다.
        decodeRetryError = String(error.message).split(/\r?\n/)[0];
        output.error(`[media-transcribe] -mc 0 재시도 실패 ${record.id}: ${decodeRetryError}`);
      }
    }
    return {
      id: record.id, kind: record.kind, ...(record.kind === 'Calls' ? { contact: record.contact } : {}),
      people: record.people, occurred: record.occurred, durationSec: duration,
      speech: normalizeSpeech(decoded.text), text: decoded.text, segments: decoded.segments, model, transcribedAt: now,
      ...(decodeRetry ? { decodeRetry } : {}), ...(decodeRetryError ? { decodeRetryError } : {}),
      ...(repetition.looped ? { repetition } : {}),
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function callParticle(label) {
  const last = [...label].at(-1);
  const code = last?.charCodeAt(0);
  return code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0 ? '과' : '와';
}

function conversationCategory(linkedPeople) {
  const subcategories = [...new Set(linkedPeople.flatMap((person) => person.subcategories || []))]
    .sort((a, b) => Number(a.match(/\/2(\d{2}) /)[1]) - Number(b.match(/\/2(\d{2}) /)[1]));
  if (subcategories.length) return [`[[${VAULT_REL.homeDir}/200 가족]]`, ...subcategories];
  return linkedPeople.some((person) => person.family)
    ? `[[${VAULT_REL.homeDir}/200 가족]]` : `[[${VAULT_REL.homeDir}/100 나]]`;
}

function linkedPeopleForNote(records, existing, knownPeople) {
  const prior = existing ? parseFrontmatter(existing) : {};
  const priorPeople = Array.isArray(prior.people) ? prior.people : prior.people ? [prior.people] : [];
  const links = new Set([
    ...records.flatMap((record) => record.people).map((person) => `[[${VAULT_REL.people}/${person}]]`),
    ...priorPeople,
  ]);
  return knownPeople.filter((person) => links.has(`[[${VAULT_REL.people}/${person.title}]]`));
}

function renderNote(records, transcripts, existing, now, knownPeople, root) {
  const sorted = [...records].sort((a, b) => Date.parse(a.occurred) - Date.parse(b.occurred) || a.id.localeCompare(b.id));
  const first = sorted[0];
  const prior = existing ? parseFrontmatter(existing) : {};
  const match = existing?.match(/^---\n[\s\S]*?\n---\n/);
  if (existing && (!match || !existing.includes(START) || !existing.includes(END)
    || existing.indexOf(START) !== existing.lastIndexOf(START)
    || existing.indexOf(END) !== existing.lastIndexOf(END)
    || existing.indexOf(START) < match[0].length
    || existing.indexOf(END) < existing.indexOf(START))) throw new Error('대화 노트 생성 표식 오류');
  if (existing && (prior.type !== 'conversation' || prior.origin !== 'media-transcribe')) throw new Error('기존 노트 소유권 오류');
  if (existing) {
    const generated = existing.slice(existing.indexOf(START), existing.indexOf(END));
    if (!sorted.some((record) => generated.includes(`<!-- media-transcribe:id ${record.id} -->`))) {
      throw new Error('기존 대화 노트 연결 불명');
    }
  }
  const before = existing ? existing.slice(match[0].length, existing.indexOf(START)) : '';
  const after = existing ? existing.slice(existing.indexOf(END) + END.length) : '\n\n## 오너 메모\n\n';
  const total = sorted.reduce((sum, record) => sum + transcripts.get(record.id).durationSec, 0);
  const label = first.kind === 'Calls' ? first.counterpart : first.stem;
  const datedRecording = first.kind === 'Recordings' && /^\d{4}-\d{2}-\d{2} \S/.test(first.stem);
  const description = first.kind === 'Calls'
    ? `${label}${callParticle(label)} 통화 ${sorted.length}건, 총 ${Math.ceil(total / 60)}분`
    : datedRecording ? `${label.slice(11)} ${Math.ceil(total / 60)}분`
      : `${label} 녹음 ${Math.ceil(total / 60)}분`;
  const recordingKind = /통화|전화/.test(first.stem) ? '통화' : '녹음';
  const convKind = first.kind === 'Calls' ? '통화'
    : prior.convKind && prior.convKind !== '대면' && prior.convKind !== '녹음'
      ? prior.convKind : recordingKind;
  const priorPeople = Array.isArray(prior.people) ? prior.people : prior.people ? [prior.people] : [];
  const people = [...new Set([
    ...sorted.flatMap((record) => record.people).map((person) => `[[${VAULT_REL.people}/${person}]]`),
    ...priorPeople,
  ])];
  const category = conversationCategory(linkedPeopleForNote(sorted, existing, knownPeople));
  const fields = {
    ...prior, type: 'conversation', category,
    description, sensitivity: '개인', created: prior.created || first.occurred.slice(0, 10),
    modified: now.slice(0, 10), occurred: first.occurred, people,
    origin: 'media-transcribe', convKind,
  };
  if (sorted.some((record) => record.kind === 'Recordings'
    && (record.capturedConfidence === 'review' || record.capturedFrom === 'mtime'))) fields.dateCheck = '의심';
  else delete fields.dateCheck;
  const body = sorted.map((record) => {
    const transcript = transcripts.get(record.id);
    const roundedDuration = Math.round(transcript.durationSec);
    const minutes = Math.floor(roundedDuration / 60);
    const seconds = roundedDuration % 60;
    const heading = record.kind === 'Calls'
      ? `### ${kstParts(record.occurred).slice(11, 16)} (${minutes}분 ${seconds}초)`
      : `### ${minutes}분 ${seconds}초`;
    const repetition = detectRepetition(transcript.text);
    const bodyText = !transcript.speech
      ? repetition.looped ? `(음성 없음 — 반복 환각 ${repetition.count}회)` : '(음성 없음)'
      : (() => {
        const speakerPath = join(root, VAULT_REL.mediaSpeakers, record.occurred.slice(0, 4), `${record.id}.json`);
        const speakers = record.kind === 'Calls' && existsSync(speakerPath)
          ? JSON.parse(readFileSync(speakerPath, 'utf8')) : null;
        if (speakers && speakers.id !== record.id) throw new Error(`화자 원본 ID 오류: ${record.id}`);
        return renderDialogue(transcript, speakers, counterpartFromNote(prior, record.counterpart),
          { looped: repetition.looped })
          || shortenRepetition(shortenSegmentRepetition(transcript.text, transcript.segments));
      })();
    return `<!-- media-transcribe:id ${record.id} -->\n${heading}\n\n${bodyText}\n\n원본: ${record.archivePath}`;
  }).join('\n\n');
  const title = datedRecording ? basename(first.notePath, '.md')
    : `${first.occurred.slice(0, 10)} ${label} ${first.kind === 'Calls' ? '통화' : '녹음'}`;
  return `${buildFrontmatter(fields)}${before}${START}\n# ${title}\n\n${body}\n${END}${after}`;
}

export async function runMediaTranscribe({ root = VAULT_PATHS.root,
  mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  indexPath = join(root, VAULT_REL.mediaArchiveIndex),
  statePath = join(root, VAULT_REL.mediaTranscribeState),
  model = DEFAULT_MODEL, ffmpegPath = '/opt/homebrew/bin/ffmpeg',
  ffprobePath = '/opt/homebrew/bin/ffprobe', whisperPath = '/opt/homebrew/bin/whisper-cli',
  temporaryRoot = tmpdir(), dryRun = false, rewriteNotes = false, fixLoops = false,
  limit = Infinity, maxMinutes = 50,
  now = new Date(), output = console, write = writeAtomic, registryRules } = {}) {
  if (fixLoops !== false && (!Number.isInteger(fixLoops) || fixLoops < 1)) throw new Error('--fix-loops 값 오류');
  if (fixLoops && rewriteNotes) throw new Error('--fix-loops와 --rewrite-notes 동시 사용 불가');
  if (!rewriteNotes && ((!Number.isInteger(limit) && limit !== Infinity) || limit < 0)) throw new Error('--limit 값 오류');
  if (!rewriteNotes && (!Number.isFinite(maxMinutes) || maxMinutes <= 0)) throw new Error('--max-minutes 값 오류');
  if (!existsSync(root)) throw new Error('볼트 경로 없음');
  const run = async () => {
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { failures: {} };
    if (!state || typeof state !== 'object' || !state.failures || typeof state.failures !== 'object') throw new Error('전사 상태 형식 오류');
    const persistedPaths = existingTranscriptPaths(root);
    const people = loadPeople(root);
    let invalidTranscript = 0;
    const { prepared: records, excludedCalls } = prepareRecords(readIndex(indexPath), people, root, mediaRoot,
      persistedPaths, model, fixLoops ? (id, error) => {
        invalidTranscript += 1;
        output.error(`[media-transcribe] 전사 JSON 건너뜀 ${id}: ${String(error.message).split(/\r?\n/)[0]}`);
      } : null);
    const rewritePaths = new Set(records.filter((record) => existsSync(record.transcriptPath))
      .map((record) => record.notePath));
    let missingAudio = 0;
    let excludedLoops = 0;
    const loopCandidates = fixLoops ? records.flatMap((record) => {
      if (!existsSync(record.transcriptPath)) return [];
      let transcript;
      try { transcript = JSON.parse(readFileSync(record.transcriptPath, 'utf8')); }
      catch (error) {
        invalidTranscript += 1;
        output.error(`[media-transcribe] 전사 JSON 건너뜀 ${record.id}: ${String(error.message).split(/\r?\n/)[0]}`);
        return [];
      }
      const repetition = detectRepetition(transcript.text);
      if (!repetition.looped) return [];
      if (!existsSync(record.path)) { missingAudio += 1; return []; }
      const sameModel = basename(transcript.model || '') === basename(model);
      if (sameModel && transcript.decodeRetry === 'mc0'
        || transcript.loopFixAttemptedAt && basename(transcript.loopFixAttemptedModel || '') === basename(model)) {
        excludedLoops += 1;
        return [];
      }
      return [{ record, repetition, transcript, sameModel,
        longestSpan: longestRepetitionSpan(transcript.text) }];
    }) : [];
    const selectedLoops = loopCandidates.slice(0, fixLoops || 0);
    const available = fixLoops ? selectedLoops.map(({ record }) => record)
      : orderPending(records.filter((record) => (!existsSync(record.transcriptPath) || record.needsRetranscribe)
        && (state.failures[record.id]?.length || 0) < 3), now);
    const done = new Set();
    const buckets = [0, 1, 2].map((group) => ({ group: group + 1, count: 0, durationSec: 0, expectedSec: 0 }));
    const durations = new Map();
    const summary = { transcribed: 0, silent: 0, failed: 0, created: 0, updated: 0, rewritten: 0,
      loopFixSkipped: 0, excludedLoops, missingAudio, invalidTranscript,
      remaining: available.length, excludedCalls, buckets, upcoming: [] };
    const start = Date.now();
    const cutoff = now.getTime() - 365 * 24 * 60 * 60_000;
    if (dryRun && fixLoops) {
      summary.upcoming = selectedLoops.map(({ record, repetition }) => ({ id: record.id,
        notePath: record.notePath, phrase: repetition.phrase, count: repetition.count,
        length: repetition.span.length }));
      output.log(`[media-transcribe] 반복 수정 dry-run ${JSON.stringify({ count: loopCandidates.length,
        excludedLoops, missingAudio, invalidTranscript,
        upcoming: summary.upcoming })}`);
    } else if (dryRun && rewriteNotes) {
      summary.remaining = 0;
      output.log(`[media-transcribe] 재작성 dry-run ${JSON.stringify({ count: rewritePaths.size,
        paths: [...rewritePaths].slice(0, 10) })}`);
    } else if (dryRun) {
      for (const record of available) {
        const bucket = buckets[priority(record, cutoff)];
        bucket.count += 1;
        try {
          const seconds = await durationSec(record.path, ffprobePath);
          bucket.durationSec += seconds;
          durations.set(record.id, seconds);
        }
        catch (error) { output.error(`[media-transcribe] 길이 확인 실패 ${record.id}: ${error.message}`); }
      }
      for (const bucket of buckets) bucket.expectedSec = Math.ceil(bucket.durationSec / 6);
      const planned = [];
      let plannedSec = 0;
      for (const record of available) {
        if (planned.length >= limit || plannedSec >= maxMinutes * 60) break;
        planned.push(record);
        plannedSec += (durations.get(record.id) || 0) / 6;
      }
      summary.upcoming = planned.map((record) => ({ id: record.id, kind: record.kind,
        date: record.occurred.slice(0, 10), counterpart: record.counterpart || record.people.join(', ') || '(미연결)',
        notePath: record.notePath }));
      output.log(`[media-transcribe] dry-run ${JSON.stringify({ buckets, upcoming: summary.upcoming })}`);
    } else {
      if (!rewriteNotes && !existsSync(model)) throw new Error('Whisper 모델 없음');
      const changedPaths = new Set(rewriteNotes ? rewritePaths : []);
      const allByPath = new Map();
      for (const record of records) {
        if (!allByPath.has(record.notePath)) allByPath.set(record.notePath, []);
        allByPath.get(record.notePath).push(record);
      }
      const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
      let processedAudioSec = 0;
      for (const record of rewriteNotes ? [] : available) {
        if (fixLoops ? processedAudioSec >= maxMinutes * 60 || Date.now() - start >= maxMinutes * 60_000
          : summary.transcribed + summary.failed >= limit || Date.now() - start >= maxMinutes * 60_000) break;
        try {
          const loopCandidate = fixLoops ? selectedLoops.find((item) => item.record.id === record.id) : null;
          if (fixLoops) {
            const seconds = await durationSec(record.path, ffprobePath);
            if (processedAudioSec + seconds > maxMinutes * 60) {
              output.log(`[media-transcribe] 반복 수정 길이 상한 건너뜀 ${record.id}: ${seconds}초`);
              continue;
            }
          }
          const transcript = await transcribe(record, { ffmpegPath, ffprobePath, whisperPath,
            model, temporaryRoot, now: now.toISOString(), directMc0: Boolean(loopCandidate?.sameModel), output });
          if (fixLoops) {
            processedAudioSec += transcript.durationSec;
            const newLongestSpan = longestRepetitionSpan(transcript.text);
            if (newLongestSpan >= loopCandidate.longestSpan) {
              const attempted = { ...loopCandidate.transcript, loopFixAttemptedAt: now.toISOString(),
                loopFixAttemptedModel: model };
              write(record.transcriptPath, `${JSON.stringify(attempted, null, 2)}\n`);
              summary.loopFixSkipped += 1;
              done.add(record.id);
              output.log(`[media-transcribe] 반복 수정 건너뜀 ${record.id}: 기존 ${loopCandidate.longestSpan}자, 새 ${newLongestSpan}자`);
              continue;
            }
          }
          mkdirSync(dirname(record.transcriptPath), { recursive: true });
          write(record.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
          changedPaths.add(record.notePath);
          summary.transcribed += 1;
          done.add(record.id);
          if (!transcript.speech) summary.silent += 1;
          if (state.failures[record.id]) { delete state.failures[record.id]; write(statePath, `${JSON.stringify(state, null, 2)}\n`); }
        } catch (error) {
          summary.failed += 1;
          state.failures[record.id] ||= [];
          state.failures[record.id].push({ id: record.id, error: error.message, at: now.toISOString() });
          mkdirSync(dirname(statePath), { recursive: true });
          write(statePath, `${JSON.stringify(state, null, 2)}\n`);
          output.error(`[media-transcribe] 실패 ${record.id}: ${error.message}`);
        }
      }
      // 전사 원본 저장 직후 또는 노트 갱신 중단 시, 생성 블록을 대조해 복구한다.
      for (const [path, grouped] of allByPath) {
        if (fixLoops && !changedPaths.has(path)) continue;
        const persisted = grouped.filter((record) => existsSync(record.transcriptPath));
        if (!persisted.length) continue;
        const absolute = join(root, path);
        const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
        const generated = existing.includes(START) && existing.includes(END)
          ? existing.slice(existing.indexOf(START), existing.indexOf(END)) : '';
        if (persisted.some((record) => !generated.includes(`<!-- media-transcribe:id ${record.id} -->`))) {
          changedPaths.add(path);
        }
        // 합친 people(수동 포함) 기준으로 category를 다시 계산한다. people 밖에서 손으로 바꾼
        // category는 이 재계산으로 바뀐다 — 의도된 한계(수동 people·convKind·아테나 필드·오너 메모는 보존).
        if (existing) {
          const fields = parseFrontmatter(existing);
          const currentCategory = fields.category;
          const expectedCategory = conversationCategory(linkedPeopleForNote(persisted, existing, people));
          if (JSON.stringify(currentCategory) !== JSON.stringify(expectedCategory)) changedPaths.add(path);
          const expectedDateCheck = persisted.some((record) => record.kind === 'Recordings'
            && (record.capturedConfidence === 'review' || record.capturedFrom === 'mtime')) ? '의심' : undefined;
          if (fields.dateCheck !== expectedDateCheck) changedPaths.add(path);
        }
      }
      for (const path of changedPaths) {
        try {
          const grouped = allByPath.get(path);
          const complete = grouped.filter((record) => existsSync(record.transcriptPath));
          const transcripts = new Map(complete.map((record) => [record.id,
            JSON.parse(readFileSync(record.transcriptPath, 'utf8'))]));
          const absolute = join(root, path);
          const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
          const next = renderNote(complete, transcripts, existing, now.toISOString(), people, root);
          const problems = rules ? checkNote(path, next, rules) : [];
          if (problems.length) throw new Error(`대화 노트 쓰기 관문: ${problems.join('; ')}`);
          mkdirSync(dirname(absolute), { recursive: true });
          await withLock(absolute, () => {
            const latest = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
            if (latest !== existing) throw new Error('쓰기 전 대화 노트 변경');
            write(absolute, next);
          });
          if (existing) summary.updated += 1;
          else summary.created += 1;
          if (rewriteNotes) summary.rewritten += 1;
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-transcribe] 노트 실패 ${path}: ${error.message}`);
        }
      }
      summary.remaining = rewriteNotes ? 0 : available.filter((record) => !done.has(record.id)).length;
    }
    output.log(`[media-transcribe] 전사 ${summary.transcribed}(음성없음 ${summary.silent}), 실패 ${summary.failed}, 노트 생성 ${summary.created}·갱신 ${summary.updated}, 재작성 ${summary.rewritten}, 반복 수정 건너뜀 ${summary.loopFixSkipped}·제외 ${summary.excludedLoops}·원본 없음 ${summary.missingAudio}·JSON 오류 ${summary.invalidTranscript}, 남은 대기 ${summary.remaining}, 미연결 통화 제외 ${summary.excludedCalls}`);
    return summary;
  };
  if (dryRun) return run();
  mkdirSync(dirname(statePath), { recursive: true });
  return withLock(statePath, run, { retries: 0 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const allowed = args.every((arg) => arg === '--dry-run' || arg === '--rewrite-notes' || arg === '--fix-loops'
    || /^--fix-loops=.+$/.test(arg)
    || /^--(?:limit|max-minutes|model)=.+$/.test(arg));
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!allowed) {
    console.error('usage: node scripts/jobs/media-transcribe.mjs [--dry-run] [--rewrite-notes] [--fix-loops[=N]] [--limit=N] [--max-minutes=M] [--model=PATH] (fix-loops는 낮에 실행 권장)');
    process.exitCode = 2;
  } else runMediaTranscribe({ dryRun: args.includes('--dry-run'), rewriteNotes: args.includes('--rewrite-notes'),
    fixLoops: option('fix-loops') === undefined ? (args.includes('--fix-loops') ? 10 : false) : Number(option('fix-loops')),
    limit: option('limit') === undefined ? Infinity : Number(option('limit')),
    maxMinutes: option('max-minutes') === undefined ? 50 : Number(option('max-minutes')),
    model: option('model') || DEFAULT_MODEL }).catch((error) => {
    console.error(`[media-transcribe] ${error.stack}`); process.exitCode = 1;
  });
}
