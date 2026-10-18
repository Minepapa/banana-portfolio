#!/usr/bin/env node
// 미네 혼자 녹음(혼잣말·동화·노래 등 비대화형)으로 연도별 '녹음·영상용' 미네 목소리 기준을 만든다.
// 통화로 만든 기준(person-미네, 2024~2026)은 어린 시절이 없고 전화 음질이라 영상 소리와 어긋난다(2026-10-18 실측:
// 2026 영상에서도 미네 유사도 0.1~0.2). 결과는 볼트 밖 voices/person-미네-rec.{npy,json}이고, 통화 판정에는 쓰지 않는다.
// 오너 방향(2026-10-17 목소리 인식 지속 강화)의 첫 단계: 고정 등록이 아니라 쌓인 녹음으로 다시 만들 수 있다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { MEDIA_DIARIZE_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { readNpy, runPython } from '../jobs/media-diarize.mjs';

// 화자 분리를 하지 않는 녹음 종류 중 미네 목소리가 아닌 것(악기·알람)은 뺀다.
export const EXCLUDED_KINDS = Object.freeze(['키보드', '알람', '연주']);
// 한 녹음에서 쓰는 소리 길이(초). 긴 동화 녹음도 앞부분만으로 충분하고 메모리를 아낀다.
export const CLIP_SECONDS = 60;
// 다른 등록 인물과 이만큼 닮으면 그 녹음은 기준에서 뺀다(통화 후보 관문과 같은 하한).
export const OTHER_PERSON_FLOOR = 0.45;

const norm = (v) => { const n = Math.hypot(...v); return n ? v.map((x) => x / n) : v; };
const cosine = (a, b) => norm(a).reduce((s, x, i) => s + x * norm(b)[i], 0);

export function mineSoloRecordings(root = VAULT_PATHS.root) {
  const base = join(root, VAULT_REL.mediaConversations);
  const rows = [];
  for (const year of readdirSync(base).filter((name) => /^\d{4}$/.test(name))) {
    for (const name of readdirSync(join(base, year)).filter((n) => n.endsWith(' 녹음.md'))) {
      const content = readFileSync(join(base, year, name), 'utf8');
      const fm = parseFrontmatter(content);
      if (fm.convKind !== '녹음') continue;
      const category = Array.isArray(fm.category) ? fm.category.join(' ') : String(fm.category ?? '');
      if (!category.includes('201 미네')) continue;
      const parts = name.replace(/\.md$/, '').split(' ');
      if (parts[1] !== '미네') continue;
      const kind = parts[2];
      if (['대화', '통화', '말하기', '상담', '수업', '병원', ...EXCLUDED_KINDS].includes(kind)) continue;
      const id = content.match(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/)?.[1];
      const archive = content.match(/^원본: (Archive\/.+)$/m)?.[1];
      if (!id || !archive) continue;
      rows.push({ id, year: Number(String(fm.occurred).slice(0, 4)), occurred: String(fm.occurred), kind, archive, note: name });
    }
  }
  return rows.sort((a, b) => a.occurred.localeCompare(b.occurred));
}

export function buildYearlyReference(samples, others = {}) {
  const kept = []; const excluded = [];
  for (const sample of samples) {
    const close = Object.entries(others).map(([name, mean]) => ({ name, score: cosine(sample.vector, mean) }))
      .filter(({ score }) => score >= OTHER_PERSON_FLOOR);
    if (close.length) excluded.push({ ...sample, vector: undefined, reason: close.map((c) => `${c.name} ${c.score.toFixed(3)}`).join(', ') });
    else kept.push(sample);
  }
  const byYear = new Map();
  for (const sample of kept) byYear.set(sample.year, [...(byYear.get(sample.year) ?? []), sample]);
  const vectors = []; const years = [];
  for (const [year, list] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const dim = list[0].vector.length;
    const mean = norm(Array.from({ length: dim }, (_, i) => list.reduce((s, x) => s + norm(x.vector)[i], 0) / list.length));
    const cohesion = list.reduce((s, x) => s + cosine(x.vector, mean), 0) / list.length;
    vectors.push(mean);
    years.push({ year, count: list.length, index: vectors.length - 1, cohesion: Number(cohesion.toFixed(3)) });
  }
  return { vectors, years, excluded, kept };
}

function writeNpy(path, rows) {
  const dim = rows[0].length;
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows.length}, ${dim}), }`;
  const pad = 16 - ((10 + header.length + 1) % 16);
  const head = Buffer.from(`${header}${' '.repeat(pad)}\n`, 'latin1');
  const pre = Buffer.alloc(10); pre.write('\x93NUMPY', 0, 'latin1'); pre[6] = 1; pre[7] = 0; pre.writeUInt16LE(head.length, 8);
  const body = Buffer.alloc(rows.length * dim * 4);
  rows.flat().forEach((x, i) => body.writeFloatLE(x, i * 4));
  writeFileSync(path, Buffer.concat([pre, head, body]), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function buildMineRecordingVoice({ root = VAULT_PATHS.root, mediaRoot = MEDIA_DIARIZE_PATHS.mediaRoot,
  paths = MEDIA_DIARIZE_PATHS, dryRun = false, output = console } = {}) {
  const recordings = mineSoloRecordings(root);
  output.log(`[mine-voice-rec] 미네 혼자 녹음 ${recordings.length}개 (연도: ${[...new Set(recordings.map((r) => r.year))].join(', ')})`);
  if (dryRun) return { recordings: recordings.length };
  const work = mkdtempSync(join(tmpdir(), 'mine-voice-rec-'));
  try {
    const items = [];
    for (const row of recordings) {
      const source = join(mediaRoot, row.archive);
      if (!existsSync(source)) { output.error?.(`[mine-voice-rec] 원본 없음 ${row.id}`); continue; }
      const wav = join(work, `${row.id}.wav`);
      execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', source,
        '-t', String(CLIP_SECONDS), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      items.push({ id: row.id, wav });
    }
    const results = await runPython('pyannote-single', items, { recordings: true });
    const samples = [];
    for (const result of results) {
      if (result.error) { output.error?.(`[mine-voice-rec] ${result.id}: ${result.error}`); continue; }
      const npy = join(paths.voices, 'pyannote-rec', `${result.id}.npy`);
      const vector = readNpy(npy)[0];
      const row = recordings.find((r) => r.id === result.id);
      samples.push({ ...row, vector: Array.from(vector) });
    }
    const others = {};
    if (existsSync(paths.ownerVoice)) others.나 = Array.from(readNpy(paths.ownerVoice)[0]);
    if (paths.personVoice && existsSync(paths.personVoice)) others.휘영 = Array.from(readNpy(paths.personVoice)[0]);
    const built = buildYearlyReference(samples, others);
    if (!built.vectors.length) throw new Error('기준을 만들 녹음이 없음');
    mkdirSync(paths.voices, { recursive: true });
    const voicePath = join(paths.voices, 'person-미네-rec.npy');
    const metaPath = join(paths.voices, 'person-미네-rec.json');
    writeNpy(voicePath, built.vectors);
    const kept = built.kept.map((s) => s.occurred.slice(0, 10)).sort();
    writeFileSync(metaPath, `${JSON.stringify({ name: '미네', source: 'recordings', createdAt: new Date().toISOString(),
      minSimilarity: OTHER_PERSON_FLOOR, period: { first: kept[0], last: kept.at(-1) }, years: built.years,
      samples: built.kept.map(({ id, occurred, kind }) => ({ id, occurred, kind })),
      excluded: built.excluded.map(({ id, occurred, kind, reason }) => ({ id, occurred, kind, reason })) }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(metaPath, 0o600);
    output.log(`[mine-voice-rec] 기준 ${built.years.length}개 연도, 표본 ${built.kept.length}개, 제외 ${built.excluded.length}개`);
    for (const y of built.years) output.log(`  ${y.year}: ${y.count}개, 응집 ${y.cohesion}`);
    for (const e of built.excluded) output.log(`  제외 ${e.occurred.slice(0, 10)} ${e.kind}: ${e.reason}`);
    return { years: built.years, kept: built.kept.length, excluded: built.excluded.length };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMineRecordingVoice({ dryRun: process.argv.includes('--dry-run') }).catch((error) => { console.error(error); process.exitCode = 1; });
}
