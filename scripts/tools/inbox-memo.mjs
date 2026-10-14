#!/usr/bin/env node
// 텔레그램 📜 글 메모·사진 판독·📎 사진 메모를 00_Inbox에 남긴다(D97, 2026-10-12 — D40의 사진 첨부 방식 대체).
//   echo '{"text":"…"}' | node scripts/tools/inbox-memo.mjs --json=- [--dry-run]
//   사진판독: {"kind":"사진판독","decoded":"…","caption":"…"}
//   사진메모: {"kind":"사진메모","text":"…","photoDescription":"…"}
//   음성: {"kind":"음성","audioPath":"/다운로드/음성.oga","caption":"…"} → 기록 줄 + JSON 줄
//   --json-out: 음성 결과 JSON만 출력(전사 실패도 error와 노트 경로를 포함한다).
//   --note="00_Inbox/…md" --confirm=등록|미등록|확인대기미등록 또는 --correction="…": 기존 음성 노트 갱신.
// - 메모 1건 = 노트 1개. 해석·요약·분류는 하지 않는다(클리오 ingest가 나중에 21_Notes로 옮기며 채운다).
// - 개인 메모일 수 있으니 sensitivity는 "개인"으로 둔다(데일리 요약에는 일반과 같이 제목·설명이 들어간다, D96).
// - created는 KST 날짜 — 데일리 노트 "오늘 들어온 기록"에 그날 기록으로 잡힌다.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { buildFrontmatter, parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { durationSec, transcribe } from '../jobs/media-transcribe.mjs';
import { runSwiftVision } from '../jobs/media-vision.mjs';

const VOICE_MODEL = join(homedir(), 'Pantheon', 'Models', 'whisper', 'ggml-large-v3.bin');
const VOICE_CONFIRM = { 등록: '등록', 미등록: '미등록', 확인대기미등록: '확인 대기 → 미등록' };
const PHOTO_PRINTS = fileURLToPath(new URL('../.cache/vision-prints/', import.meta.url));

const kst = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString();

// 제목: "YYYY-MM-DD HHmm 첫 말". 파일명 금지 문자(등록부 3절)·이모지·줄바꿈은 뺀다.
export function memoTitle(text, now) {
  const stamp = kst(now);
  const head = String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\\/:*?"<>|#^[\]·$]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 24).trim().replace(/[. ]+$/, '');
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)}${head ? ` ${head}` : ' 메모'}`;
}

export function buildMemo(text, { now = new Date(), kind = null, decoded, caption, photoDescription, photoPrint,
  photoMatchUntil, voiceDurationSec, transcriptModel } = {}) {
  let body;
  let origin = '텔레그램 📜';
  const extra = {};
  if (kind === null) {
    body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new Error('빈 메모');
  } else if (kind === '사진판독') {
    if (!String(decoded ?? '').trim()) throw new Error('빈 사진 판독');
    body = `${String(caption ?? '').trim() ? `## 캡션\n${caption}\n\n` : ''}## 판독\n${decoded}`;
    origin = '텔레그램 사진';
    extra.attachment = '사진(파일 저장 안 함)';
  } else if (kind === '사진메모') {
    if (!String(text ?? '').trim()) throw new Error('빈 메모');
    body = `${text}\n\n${String(photoDescription ?? '').trim() ? `(사진: ${photoDescription})` : '(사진 첨부)'}`;
    origin = '텔레그램 📎';
    extra.photoLink = '대기';
    if (photoPrint) extra.photoPrint = photoPrint;
    if (photoMatchUntil) extra.photoMatchUntil = photoMatchUntil;
  } else if (kind === '음성') {
    body = `${String(caption ?? '').trim() ? `## 캡션\n${caption}\n\n` : ''}## 전사\n${String(text ?? '').trim()}`;
    origin = '텔레그램 음성';
    extra.kind = '음성';
    extra.voiceDurationSec = voiceDurationSec ?? null;
    if (transcriptModel) extra.transcriptModel = basename(transcriptModel);
  } else {
    throw new Error(`알 수 없는 kind: ${kind}`);
  }
  if (body.length > 20_000) throw new Error('메모가 너무 김(2만 자 이하)');
  const stamp = kst(now);
  const fm = buildFrontmatter({
    type: 'inbox', origin, created: stamp.slice(0, 10), capturedAt: `${stamp.slice(0, 16)}+09:00`, sensitivity: '개인',
    ...extra,
  });
  return `${fm}${body}\n`;
}

export function saveMemo(input, { now = new Date(), dryRun = false, dir = vaultAbs(VAULT_REL.inboxRoot) } = {}) {
  const kind = input?.kind ?? null;
  const content = buildMemo(input?.text, { now, kind, decoded: input?.decoded, caption: input?.caption,
    photoDescription: input?.photoDescription, photoPrint: input?.photoPrint, photoMatchUntil: input?.photoMatchUntil,
    voiceDurationSec: input?.voiceDurationSec, transcriptModel: input?.transcriptModel });
  const titleText = kind === '사진판독'
    ? `사진 ${String(input?.caption ?? '').trim() || String(input.decoded).split(/\r?\n/)[0]}`
    : kind === '음성' ? `음성 ${String(input?.text ?? '').split(/\r?\n/)[0]}` : input?.text ?? '';
  const base = memoTitle(titleText, now);
  let name = `${base}.md`;
  for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${base} (${n}).md`;
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, { flag: 'wx', mode: 0o644 });
  }
  const label = kind === '사진판독' ? '🖼️ 판독 기록함' : kind === '사진메모' ? '📎 기록함' : kind === '음성' ? '🎙️ 기록함' : '📜 기록함';
  return `${label}: ${VAULT_REL.inboxRoot}/${name.replace(/\.md$/, '')}${dryRun ? ' (dry-run)' : ''}`;
}

export async function savePhotoMemo(input, { now = new Date(), dryRun = false, dir = vaultAbs(VAULT_REL.inboxRoot),
  printsPath = PHOTO_PRINTS, runner = runSwiftVision, output = console } = {}) {
  if (input?.kind !== '사진메모') throw new Error('사진메모 kind 필요');
  if (!input.photoPath) {
    output.log('[inbox-memo] 사진 경로 없음: 원본 연결 대기');
    return saveMemo({ ...input, photoMatchUntil: kst(new Date(now.getTime() + 30 * 86_400_000)).slice(0, 10) }, { now, dryRun, dir });
  }
  if (dryRun) return saveMemo({ ...input, photoMatchUntil: kst(new Date(now.getTime() + 30 * 86_400_000)).slice(0, 10) }, { now, dryRun, dir });
  const printId = `memo-${randomUUID()}`;
  const printPath = join(printsPath, `${printId}.f32`);
  let analyzed = false;
  try {
    mkdirSync(printsPath, { recursive: true });
    const response = await runner([{ id: printId, path: input.photoPath, kind: 'image', printPath }]);
    const line = (Array.isArray(response) ? response : response.lines)?.[0];
    const result = typeof line === 'string' ? JSON.parse(line) : line;
    if (!result || result.id !== printId || result.error || !Number.isInteger(result.printDims)
      || result.printDims < 1 || !existsSync(printPath) || lstatSync(printPath).size !== result.printDims * 4) {
      throw new Error(result?.error || 'Vision 지문 없음');
    }
    analyzed = true;
  } catch (error) {
    rmSync(printPath, { force: true });
    output.log(`[inbox-memo] 사진 지문 실패: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
  }
  const until = new Date(now.getTime() + 30 * 86_400_000);
  return saveMemo({ ...input, ...(analyzed ? { photoPrint: printId } : {}), photoMatchUntil: kst(until).slice(0, 10) },
    { now, dir });
}

export async function saveVoiceMemo(input, { now = new Date(), dryRun = false, dir = vaultAbs(VAULT_REL.inboxRoot),
  probe = durationSec, transcribeAudio = transcribe, ffprobePath = '/opt/homebrew/bin/ffprobe',
  ffmpegPath = '/opt/homebrew/bin/ffmpeg', whisperPath = '/opt/homebrew/bin/whisper-cli',
  model = VOICE_MODEL, temporaryRoot = tmpdir() } = {}) {
  if (input?.kind !== '음성' || typeof input.audioPath !== 'string' || !input.audioPath.trim()) throw new Error('음성 audioPath 필요');
  let duration;
  let error;
  let text = '';
  try {
    duration = await probe(input.audioPath, ffprobePath);
    if (!Number.isFinite(duration) || duration < 0) throw new Error('오디오 길이 오류');
    if (duration > 600) throw new RangeError('음성 길이 10분 초과');
    const result = await transcribeAudio({ path: input.audioPath, id: 'telegram-voice', kind: 'voice', people: [], occurred: now.toISOString() },
      { ffmpegPath, ffprobePath, whisperPath, model, temporaryRoot, now: now.toISOString() });
    text = String(result.text ?? '').trim();
    if (result.speech === false || !text) { text = '(음성 없음)'; error = '음성 없음'; }
  } catch (caught) {
    const firstLine = String(caught?.message ?? caught).split(/[\r\n]/, 1)[0];
    // execFile 오류 첫 줄에는 명령 전체와 모델·입력 경로가 들어갈 수 있다.
    error = caught?.cmd || caught?.stderr !== undefined || /^Command failed:|^spawn\s+\//.test(firstLine)
      ? '전사 명령 실행 실패' : firstLine.replace(/\/(?:[^\s/]+\/)*[^\s/]+/g, '[경로]').slice(0, 200);
    text = `(전사 실패: ${error})`;
  }
  const label = saveMemo({ kind: '음성', text, caption: input.caption, voiceDurationSec: duration,
    ...(!error ? { transcriptModel: basename(model) } : {}) },
    { now, dryRun, dir });
  const note = `${VAULT_REL.inboxRoot}/${label.split(`${VAULT_REL.inboxRoot}/`)[1].replace(/ \(dry-run\)$/, '')}.md`;
  return { label, note, text, durationSec: duration ?? null, ...(error ? { error } : {}) };
}

export async function updateVoiceMemo({ note, confirm, correction }, { now = new Date(), dir = vaultAbs(VAULT_REL.inboxRoot) } = {}) {
  const prefix = `${VAULT_REL.inboxRoot}/`;
  if (typeof note !== 'string' || !note.startsWith(prefix) || basename(note) !== note.slice(prefix.length)
    || !note.endsWith('.md') || note.includes('..') || note.includes('\\')) throw new Error('음성 노트 경로 오류');
  if ((confirm === undefined) === (correction === undefined)) throw new Error('confirm 또는 correction 하나 필요');
  if (confirm !== undefined && !Object.hasOwn(VOICE_CONFIRM, confirm)) throw new Error('확인 상태 오류');
  if (correction !== undefined && (!String(correction).trim() || /[\r\n]/.test(correction))) throw new Error('정정 문구 오류');
  const path = join(dir, basename(note));
  if (!existsSync(path)) throw new Error(`이미 정리됨(옮겨짐): ${note}`);
  try { return await withLock(path, () => {
    if (!lstatSync(path).isFile()) throw new Error('음성 노트 파일 오류');
    const content = readFileSync(path, 'utf8');
    if (parseFrontmatter(content).kind !== '음성') throw new Error('음성 노트가 아님');
    const updated = confirm === undefined
      ? `${content.replace(/\n*$/, '\n')}정정: ${correction.trim()}\n`
      : `${updateFrontmatter(content, { voiceConfirm: VOICE_CONFIRM[confirm], voiceConfirmAt: `${kst(now).slice(0, 19)}+09:00` })}${content.slice(content.indexOf('\n---\n') + 5)}`;
    if (updated !== content) {
      if (readFileSync(path, 'utf8') !== content) throw new Error(`쓰기 전 음성 노트 변경: ${note}`);
      writeAtomic(path, updated);
    }
    return `🎙️ 음성 노트 갱신: ${note}`;
  }); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`이미 정리됨(옮겨짐): ${note}`);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), { input = () => readFileSync(0, 'utf8'), output = console.log,
  voiceOptions = {}, photoOptions = {}, updateOptions = {} } = {}) {
  const note = argv.find((arg) => arg.startsWith('--note='))?.slice(7);
  if (note) {
    const confirm = argv.find((arg) => arg.startsWith('--confirm='))?.slice(10);
    const correction = argv.find((arg) => arg.startsWith('--correction='))?.slice(13);
    output(await updateVoiceMemo({ note, confirm, correction }, updateOptions));
  } else {
    if (!argv.includes('--json=-')) throw new Error('--json=- 필요');
    const memo = JSON.parse(input());
    if (memo.kind === '음성') {
      const result = await saveVoiceMemo(memo, { ...voiceOptions, dryRun: argv.includes('--dry-run') });
      if (!argv.includes('--json-out')) output(result.label);
      output(JSON.stringify({ note: result.note, text: result.text, durationSec: result.durationSec,
        ...(result.error ? { error: result.error } : {}) }));
    } else if (memo.kind === '사진메모') output(await savePhotoMemo(memo, { ...photoOptions, dryRun: argv.includes('--dry-run') }));
    else output(saveMemo(memo, { dryRun: argv.includes('--dry-run') }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
