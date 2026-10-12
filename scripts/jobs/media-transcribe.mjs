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

const execFileAsync = promisify(execFile);
const START = '<!-- media-transcribe:start -->';
const END = '<!-- media-transcribe:end -->';
const QUIET_PHRASES = new Set([
  '시청해주셔서감사합니다', '구독과좋아요', '구독과좋아요부탁드립니다',
  '감사합니다', '자막제공', '영상편집',
]);
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DEFAULT_MODEL = join(homedir(), 'Pantheon', 'Models', 'whisper', 'ggml-large-v3-turbo.bin');

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

function prepareRecords(records, people, root, mediaRoot, persistedPaths) {
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
      const linked = matchPeople(record.kind, filename, contact, people);
      if (record.kind === 'Calls' && !linked.length) {
        excludedCalls += 1;
        return [];
      }
      const persisted = persistedPaths.get(record.id);
      const transcript = persisted ? JSON.parse(readFileSync(persisted, 'utf8')) : null;
      if (transcript && (transcript.id !== record.id || !Number.isFinite(Date.parse(transcript.occurred)))) {
        throw new Error(`전사 원본 형식 오류: ${record.id}`);
      }
      const occurred = transcript?.occurred || call?.occurred || record.capturedAt;
      const counterpart = record.kind === 'Calls' ? (linked[0]?.title || cleanTitle(contact)) : null;
      const item = {
        ...record, path, filename, occurred, contact,
        people: linked.map((person) => person.title), family: linked.some((person) => person.family),
        counterpart, stem: cleanTitle(basename(filename, extname(filename))),
      };
      item.notePath = notePath(item);
      item.transcriptPath = persisted || transcriptPath(root, item);
      // 구간 시각이 없는 옛 전사 원본은 다시 전사한다.
      item.needsSegments = Boolean(transcript) && !Array.isArray(transcript.segments);
      return [item];
    });
  assignNotePaths(prepared, root);
  return { prepared, excludedCalls };
}

function priority(record, recentCutoff) {
  const recent = Date.parse(record.occurred) >= recentCutoff;
  return recent ? (record.people.length ? 0 : 1) : 2;
}

export function orderPending(records, now = new Date()) {
  const cutoff = now.getTime() - 365 * 24 * 60 * 60_000;
  return [...records].sort((a, b) => priority(a, cutoff) - priority(b, cutoff)
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

async function durationSec(path, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (!stdout.trim()) throw new Error('오디오 길이 없음');
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) throw new Error('오디오 길이 오류');
  return duration;
}

async function transcribe(record, { ffmpegPath, ffprobePath, whisperPath, model, temporaryRoot, now }) {
  const duration = await durationSec(record.path, ffprobePath);
  const directory = await fs.mkdtemp(join(temporaryRoot, 'media-transcribe-'));
  const wav = join(directory, `${randomUUID()}.wav`);
  try {
    await execFileAsync(ffmpegPath, ['-nostdin', '-loglevel', 'error', '-i', record.path,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { maxBuffer: 1024 * 1024 });
    // 구간별 시각(-oj, 최대 30자·단어 경계)을 남겨 나중에 화자 분리와 맞출 수 있게 한다(2026-10-12 오너 결정).
    const outPrefix = join(directory, 'out');
    await execFileAsync(whisperPath,
      ['-m', model, '-l', 'ko', '-np', '-oj', '-ml', '30', '-sow', '-of', outPrefix, '-f', wav],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(await fs.readFile(`${outPrefix}.json`, 'utf8'));
    if (!Array.isArray(parsed?.transcription)) throw new Error('Whisper JSON 형식 오류');
    const segments = parsed.transcription.map((segment) => ({
      start: Number(segment?.offsets?.from), end: Number(segment?.offsets?.to), text: String(segment?.text ?? '').trim(),
    })).filter((segment) => segment.text);
    if (segments.some((segment) => !Number.isFinite(segment.start) || !Number.isFinite(segment.end))) {
      throw new Error('Whisper 구간 시각 오류');
    }
    const text = segments.map((segment) => segment.text).join(' ');
    return {
      id: record.id, kind: record.kind, ...(record.kind === 'Calls' ? { contact: record.contact } : {}),
      people: record.people, occurred: record.occurred, durationSec: duration,
      speech: normalizeSpeech(text), text, segments, model, transcribedAt: now,
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

function renderNote(records, transcripts, existing, now) {
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
  const description = first.kind === 'Calls'
    ? `${label}${callParticle(label)} 통화 ${sorted.length}건, 총 ${Math.ceil(total / 60)}분`
    : `${label} 녹음 ${Math.ceil(total / 60)}분`;
  const people = [...new Set(sorted.flatMap((record) => record.people))]
    .map((person) => `[[${VAULT_REL.people}/${person}]]`);
  const fields = {
    ...prior, type: 'conversation', category: sorted.some((record) => record.family)
      ? `[[${VAULT_REL.homeDir}/200 가족]]` : `[[${VAULT_REL.homeDir}/100 나]]`,
    description, sensitivity: '개인', created: prior.created || first.occurred.slice(0, 10),
    modified: now.slice(0, 10), occurred: first.occurred, people,
    origin: 'media-transcribe', convKind: first.kind === 'Calls' ? '통화' : '대면',
  };
  const body = sorted.map((record) => {
    const transcript = transcripts.get(record.id);
    const roundedDuration = Math.round(transcript.durationSec);
    const minutes = Math.floor(roundedDuration / 60);
    const seconds = roundedDuration % 60;
    const heading = record.kind === 'Calls'
      ? `### ${kstParts(record.occurred).slice(11, 16)} (${minutes}분 ${seconds}초)`
      : `### ${minutes}분 ${seconds}초`;
    return `<!-- media-transcribe:id ${record.id} -->\n${heading}\n\n${transcript.speech ? transcript.text : '(음성 없음)'}\n\n원본: ${record.archivePath}`;
  }).join('\n\n');
  return `${buildFrontmatter(fields)}${before}${START}\n# ${first.occurred.slice(0, 10)} ${label} ${first.kind === 'Calls' ? '통화' : '녹음'}\n\n${body}\n${END}${after}`;
}

export async function runMediaTranscribe({ root = VAULT_PATHS.root,
  mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  indexPath = join(root, VAULT_REL.mediaArchiveIndex),
  statePath = join(root, VAULT_REL.mediaTranscribeState),
  model = DEFAULT_MODEL, ffmpegPath = '/opt/homebrew/bin/ffmpeg',
  ffprobePath = '/opt/homebrew/bin/ffprobe', whisperPath = '/opt/homebrew/bin/whisper-cli',
  temporaryRoot = tmpdir(), dryRun = false, limit = Infinity, maxMinutes = 50,
  now = new Date(), output = console, write = writeAtomic, registryRules } = {}) {
  if (!Number.isInteger(limit) && limit !== Infinity || limit < 0) throw new Error('--limit 값 오류');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes 값 오류');
  if (!existsSync(root)) throw new Error('볼트 경로 없음');
  const run = async () => {
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { failures: {} };
    if (!state || typeof state !== 'object' || !state.failures || typeof state.failures !== 'object') throw new Error('전사 상태 형식 오류');
    const persistedPaths = existingTranscriptPaths(root);
    const people = loadPeople(root);
    const { prepared: records, excludedCalls } = prepareRecords(readIndex(indexPath), people, root, mediaRoot, persistedPaths);
    const available = orderPending(records.filter((record) => (!existsSync(record.transcriptPath) || record.needsSegments)
      && (state.failures[record.id]?.length || 0) < 3), now);
    const done = new Set();
    const buckets = [0, 1, 2].map((group) => ({ group: group + 1, count: 0, durationSec: 0, expectedSec: 0 }));
    const durations = new Map();
    const summary = { transcribed: 0, silent: 0, failed: 0, created: 0, updated: 0,
      remaining: available.length, excludedCalls, buckets, upcoming: [] };
    const start = Date.now();
    const cutoff = now.getTime() - 365 * 24 * 60 * 60_000;
    if (dryRun) {
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
      if (!existsSync(model)) throw new Error('Whisper 모델 없음');
      const changedPaths = new Set();
      const allByPath = new Map();
      for (const record of records) {
        if (!allByPath.has(record.notePath)) allByPath.set(record.notePath, []);
        allByPath.get(record.notePath).push(record);
      }
      const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
      for (const record of available) {
        if (summary.transcribed + summary.failed >= limit || Date.now() - start >= maxMinutes * 60_000) break;
        try {
          const transcript = await transcribe(record, { ffmpegPath, ffprobePath, whisperPath,
            model, temporaryRoot, now: now.toISOString() });
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
        const persisted = grouped.filter((record) => existsSync(record.transcriptPath));
        if (!persisted.length) continue;
        const absolute = join(root, path);
        const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
        const generated = existing.includes(START) && existing.includes(END)
          ? existing.slice(existing.indexOf(START), existing.indexOf(END)) : '';
        if (persisted.some((record) => !generated.includes(`<!-- media-transcribe:id ${record.id} -->`))) {
          changedPaths.add(path);
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
          const next = renderNote(complete, transcripts, existing, now.toISOString());
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
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-transcribe] 노트 실패 ${path}: ${error.message}`);
        }
      }
      summary.remaining = available.filter((record) => !done.has(record.id)).length;
    }
    output.log(`[media-transcribe] 전사 ${summary.transcribed}(음성없음 ${summary.silent}), 실패 ${summary.failed}, 노트 생성 ${summary.created}·갱신 ${summary.updated}, 남은 대기 ${summary.remaining}, 미연결 통화 제외 ${summary.excludedCalls}`);
    return summary;
  };
  if (dryRun) return run();
  mkdirSync(dirname(statePath), { recursive: true });
  return withLock(statePath, run, { retries: 0 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const allowed = args.every((arg) => arg === '--dry-run' || /^--(?:limit|max-minutes|model)=.+$/.test(arg));
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!allowed) {
    console.error('usage: node scripts/jobs/media-transcribe.mjs [--dry-run] [--limit=N] [--max-minutes=M] [--model=PATH]');
    process.exitCode = 2;
  } else runMediaTranscribe({ dryRun: args.includes('--dry-run'),
    limit: option('limit') === undefined ? Infinity : Number(option('limit')),
    maxMinutes: option('max-minutes') === undefined ? 50 : Number(option('max-minutes')),
    model: option('model') || DEFAULT_MODEL }).catch((error) => {
    console.error(`[media-transcribe] ${error.stack}`); process.exitCode = 1;
  });
}
