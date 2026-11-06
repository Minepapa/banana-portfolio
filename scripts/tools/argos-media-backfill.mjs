#!/usr/bin/env node
// 아르고스 미디어 채우기(2026-11-07 전환): Media/Inbox-Argos에만 있고 미디어 파이프라인에 없는 파일을 Media/Inbox로 복사한다.
// 폰 Syncthing이 끊긴 뒤(카메라 10-25·통화 10-30) 아르고스로만 들어온 파일을 파이프라인 입구에 넣기 위한 것이다.
//   node scripts/tools/argos-media-backfill.mjs            # 미리보기(읽기 전용)
//   node scripts/tools/argos-media-backfill.mjs --apply    # 복사 + 해시 확인 + 기록
// 판정(이름보다 해시가 먼저):
// - 이미 있음: 같은 내용(sha256)이 Inbox, archive-index.jsonl(id = sha256 앞 16자), Trash 어디에든 있다.
//   11-03에 손으로 복사한 파일도 여기서 걸린다. Inbox-Argos 안의 같은 내용 사본도 한 번만 복사한다.
// - 이름 같고 내용 다름: 내용은 없는데 같은 종류·같은 이름이 Inbox·색인·Trash에 있다. 복사하지 않고 보여만 준다(사람이 본다).
// - 복사 대상: 나머지.
// 불변식:
// - 원본(Inbox-Argos)은 지우거나 바꾸지 않는다. Inbox의 기존 파일은 덮어쓰지 않는다(link로 생성, 있으면 실패).
// - 복사는 숨김 임시 이름(.…tmp, media-archive가 건너뜀)으로 한 뒤 해시를 확인하고 원래 이름으로 링크한다
//   (링크 뒤에는 다시 재지 않는다: 그 사이 media-archive가 옮겨 가면 성공을 실패로 적게 된다).
//   수정 시각을 원본과 같게 둔다(media-archive가 EXIF 없는 파일의 날짜를 mtime으로 정한다).
// - 결과는 Inbox-Argos/.backfill.jsonl에 한 줄씩 남긴다.
import { createHash } from 'node:crypto';
import {
  appendFileSync, constants, copyFileSync, createReadStream, existsSync, linkSync, lstatSync, readFileSync, readdirSync,
  mkdirSync, statSync, unlinkSync, utimesSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MEDIA_KINDS } from '../lib/argos-media.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 하위 폴더까지 일반 파일만. 숨김 이름(.parts, .trashed-, 임시 파일)은 건너뛴다. */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return out; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function readIndex(indexPath) {
  if (!existsSync(indexPath)) throw new Error(`색인 없음: ${indexPath}`);
  return readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Trash/{날짜}/{종류}/… 와 Trash/{날짜}/Argos/{종류}/… 를 종류별로 모은다. */
function trashFiles(mediaRoot, kind) {
  const trashRoot = join(mediaRoot, 'Trash');
  let days = [];
  try { days = readdirSync(trashRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return days.flatMap((day) => [...walk(join(trashRoot, day, kind)), ...walk(join(trashRoot, day, 'Argos', kind))]);
}

export async function planBackfill({ mediaRoot = join(homedir(), 'Pantheon', 'Media'), indexPath = VAULT_PATHS.mediaArchiveIndex } = {}) {
  const index = readIndex(indexPath);
  const indexIds = new Set(index.map((record) => record.id));
  const items = [];
  for (const kind of MEDIA_KINDS) {
    const argos = walk(join(mediaRoot, 'Inbox-Argos', kind));
    if (!argos.length) continue;
    const sizes = new Set(argos.map((path) => statSync(path).size));
    const pipelineFiles = [...walk(join(mediaRoot, 'Inbox', kind)), ...trashFiles(mediaRoot, kind)];
    const names = new Set([
      ...pipelineFiles.map((path) => basename(path).normalize('NFC')),
      ...index.filter((record) => record.kind === kind && typeof record.inboxPath === 'string')
        .map((record) => basename(record.inboxPath).normalize('NFC')),
    ]);
    // 크기가 같은 파일만 해시한다(Inbox에는 큰 영상이 많다).
    const hashes = new Set();
    for (const path of pipelineFiles) if (sizes.has(statSync(path).size)) hashes.add(await sha256Of(path));
    // 원래 이름을 " (n)" 충돌 사본보다 먼저 본다: 같은 내용이면 원래 이름으로 복사된다.
    const copyName = (path) => / \(\d+\)(\.[^.]+)?$/.test(basename(path));
    argos.sort((a, b) => copyName(a) - copyName(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const source of argos) {
      const sha256 = await sha256Of(source);
      const name = basename(source).normalize('NFC');
      const sub = relative(join(mediaRoot, 'Inbox-Argos', kind), source);
      const base = { kind, name, source: relative(mediaRoot, source), sha256, size: statSync(source).size };
      if (hashes.has(sha256) || indexIds.has(sha256.slice(0, 16))) items.push({ ...base, verdict: 'present' });
      else if (names.has(name)) items.push({ ...base, verdict: 'conflict' });
      else {
        items.push({ ...base, verdict: 'copy', target: join('Inbox', kind, sub) });
        // 같은 내용·같은 이름이 Inbox-Argos에 또 있으면(이름 (2) 사본 등) 한 번만 복사한다.
        hashes.add(sha256);
        names.add(name);
      }
    }
  }
  return items;
}

export async function applyBackfill(items, { mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  logPath = join(mediaRoot, 'Inbox-Argos', '.backfill.jsonl'), now = () => new Date() } = {}) {
  const results = [];
  for (const item of items.filter((i) => i.verdict === 'copy')) {
    const source = join(mediaRoot, item.source);
    const target = join(mediaRoot, item.target);
    const temp = join(dirname(target), `.argos-backfill-${item.sha256.slice(0, 16)}.tmp`);
    let outcome;
    try {
      const st = lstatSync(source);
      if (!st.isFile() || st.size !== item.size) throw new Error('원본이 미리보기 뒤 바뀜');
      mkdirSync(dirname(target), { recursive: true });
      // 임시 파일이 남아 있으면(직전 실행 중단) 지우고 다시 복사한다. 숨김 .tmp라 파이프라인은 본 적이 없다.
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      copyFileSync(source, temp, constants.COPYFILE_EXCL);
      utimesSync(temp, st.atime, st.mtime);
      if (await sha256Of(temp) !== item.sha256) throw new Error('복사본 해시 불일치');
      try { linkSync(temp, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 같은 내용이면 이미 들어간 것(직전 실행이 link 뒤 끊김). 다른 내용이면 덮어쓰지 않는다.
        if (await sha256Of(target) !== item.sha256) throw new Error('Inbox에 같은 이름 다른 내용이 생김');
      }
      unlinkSync(temp);
      outcome = 'copied';
    } catch (error) {
      try { unlinkSync(temp); } catch { /* 없음 */ }
      outcome = `failed: ${error.message}`;
    }
    const row = { at: now().toISOString(), kind: item.kind, name: item.name, source: item.source, target: item.target,
      sha256: item.sha256, size: item.size, outcome };
    appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    results.push(row);
  }
  return results;
}

export function formatPlan(items) {
  const lines = ['[아르고스 미디어 채우기] Inbox-Argos → Inbox'];
  for (const kind of MEDIA_KINDS) {
    const of = items.filter((item) => item.kind === kind);
    if (!of.length) continue;
    const count = (verdict) => of.filter((item) => item.verdict === verdict).length;
    lines.push(`- ${kind}: 이미 있음 ${count('present')} · 복사 대상 ${count('copy')} · 이름 같고 내용 다름 ${count('conflict')}`);
  }
  for (const item of items.filter((i) => i.verdict === 'conflict')) lines.push(`  내용 다름(복사 안 함): ${item.source}`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length) { console.error(`[argos-media-backfill] 모르는 인자 ${unknown.join(' ')}`); process.exit(2); }
  const items = await planBackfill();
  console.log(formatPlan(items));
  if (args.includes('--apply')) {
    const results = await applyBackfill(items);
    const failed = results.filter((row) => row.outcome !== 'copied');
    console.log(`적용: 복사 ${results.length - failed.length} · 실패 ${failed.length}`);
    for (const row of failed) console.log(`  실패 ${row.source}: ${row.outcome}`);
    if (failed.length) process.exitCode = 1;
  }
}
