#!/usr/bin/env node
// 결정 미디어-삭제-판정 §4-2: 수동 리포트 전용. 원본과 볼트는 읽기만 한다.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS, MEDIA_RECORDINGS_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { resolveDecision } from '../lib/decision-resolver.mjs';
import { chooseRepresentative, classify, mediaKind } from '../lib/media-delete-core.mjs';
import { lines, sourcePath } from './media-quality-measure.mjs';

function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function loadNotes(root) {
  const notes = new Map();
  for (const rel of [VAULT_REL.mediaMomentsState, VAULT_REL.mediaImportMomentsState]) {
    for (const state of Object.values(json(join(root, rel)))) {
      const path = join(root, state.notePath);
      const content = readFileSync(path, 'utf8');
      const frontmatter = parseFrontmatter(content);
      const owner = content.match(/## 오너 메모\s*([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
      const note = { ...frontmatter, title: state.notePath, ownerMemo: Boolean(owner) };
      for (const id of state.mediaIds || []) notes.set(id, note);
    }
  }
  return notes;
}
// 얼굴 보호 데이터가 없으면 조용히 보호가 꺼지지 않도록 sourceError로 표시해 모든 행을 제외한다(리뷰 MEDIUM).
function faceMap(root) {
  const missing = [join(root, VAULT_REL.mediaFacePeople), MEDIA_FACES_PATHS.matches].filter((path) => !existsSync(path));
  if (missing.length) return { photos: {}, videos: new Map(), matches: new Map(), sourceError: `얼굴 데이터 없음: ${missing.join(', ')}` };
  const photos = json(join(root, VAULT_REL.mediaFacePeople)).photos || {};
  const videos = new Map(lines(join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl')).map((row) => [row.id, row]));
  const matches = new Map();
  for (const row of lines(MEDIA_FACES_PATHS.matches)) {
    if (!matches.has(row.id)) matches.set(row.id, []);
    matches.get(row.id).push(row);
  }
  return { photos, videos, matches };
}
export function makeItems({ archive, imports, vision, quality, notes, faces, mediaRoot }) {
  const byId = new Map(archive.map((record) => [record.id, record]));
  const visionById = new Map(vision.map((row) => [row.id, row]));
  const qualityById = new Map(quality.map((row) => [row.id, row]));
  const items = [...archive, ...imports].filter((record) => mediaKind(record)).map((record) => {
    const face = faces.photos[record.id] || faces.videos.get(record.id) || {};
    const raw = faces.matches.get(record.id) || [];
    const faceNames = [...new Set([...(face.people || []), ...(face.hold || []),
      ...raw.filter((entry) => entry.label === 'mine' || entry.person).map((entry) => entry.person || '미네')])];
    const duplicate = record.duplicateOf?.startsWith('archive:') ? byId.get(record.id) : null;
    let sameInode = false;
    if (duplicate) {
      try {
        const left = statSync(sourcePath(record, mediaRoot));
        const right = statSync(sourcePath(duplicate, mediaRoot));
        sameInode = left.dev === right.dev && left.ino === right.ino;
      } catch { sameInode = true; } // 원본 확인 실패는 후보로 보내지 않는다.
    }
    return { record, vision: visionById.get(record.id), quality: qualityById.get(record.id),
      note: notes.get(record.id) || { noteMissing: true }, face: { ...face, people: faceNames }, sameInode,
      mineFaceScore: Math.max(0, ...raw.filter((entry) => entry.label === 'mine').map((entry) => entry.score || 0)) };
  });
  const groups = new Map();
  for (const item of items) if (item.vision?.duplicateGroup) {
    const key = item.vision.duplicateGroup;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const representative = chooseRepresentative(group);
    const groupHasFace = group.some((item) => item.vision?.faces > 0 || item.face.people?.length || item.face.hold?.length);
    for (const item of group) {
      item.groupSize = group.length;
      item.representativeId = representative.record.id;
      item.isRepresentative = item === representative;
      item.groupHasFace = groupHasFace;
      item.groupVerified = true; // vision duplicateGroup은 지문 거리와 촬영 간격으로 생성됨 (§3).
    }
  }
  return items;
}
export function summarize(rows) {
  const signals = {}, candidates = {}, exclusions = {}, pendingBackup = {};
  let candidateBytes = 0;
  for (const row of rows) {
    for (const signal of row.signals) signals[signal.type] = (signals[signal.type] || 0) + 1;
    for (const signal of row.candidates) {
      const key = `${signal.type} ${signal.grade}`;
      candidates[key] ??= { count: 0, bytes: 0 };
      candidates[key].count += 1; candidates[key].bytes += row.size;
      candidateBytes += row.size;
    }
    for (const reason of row.exclusions) exclusions[reason] = (exclusions[reason] || 0) + 1;
    for (const signal of row.pendingBackupOnly || []) {
      const key = `${signal.type} ${signal.grade}`;
      pendingBackup[key] ??= { count: 0, bytes: 0 };
      pendingBackup[key].count += 1; pendingBackup[key].bytes += row.size;
    }
  }
  return { total: rows.length, candidateItems: rows.filter((row) => row.candidates.length).length,
    candidateBytes, signals, candidates, exclusions, pendingBackup,
    representatives: rows.filter((row) => row.role === '대표').length };
}
export function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== '--dry-run')) throw new Error('지원 옵션: --dry-run');
  const dryRun = argv.includes('--dry-run');
  const decision = resolveDecision('미디어-삭제-판정');
  resolveDecision('미디어-삭제-요청'); // §4: 두 결정의 범위를 함께 확인한다.
  const root = VAULT_PATHS.root;
  const faceSource = faceMap(root);
  const items = makeItems({ archive: lines(VAULT_PATHS.mediaArchiveIndex),
    imports: lines(join(root, VAULT_REL.mediaImportsIndex)),
    vision: lines(VAULT_PATHS.mediaVisionIndex),
    quality: lines(join(MEDIA_RECORDINGS_PATHS.mediaRoot, 'Quality', 'quality.jsonl')),
    notes: loadNotes(root), faces: faceSource, mediaRoot: MEDIA_RECORDINGS_PATHS.mediaRoot });
  const rows = items.map((item) => classify(item, { sourceError: faceSource.sourceError }));
  const summary = summarize(rows);
  if (dryRun) { console.log(JSON.stringify({ dryRun, ...summary })); return summary; }
  const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  const directory = join(MEDIA_RECORDINGS_PATHS.mediaRoot, 'DeleteReport');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const table = (object) => Object.entries(object).sort((a, b) => (b[1].count ?? b[1]) - (a[1].count ?? a[1]))
    .map(([key, value]) => `| ${key} | ${value.count ?? value} | ${value.bytes ?? ''} |`).join('\n');
  const markdown = `# 미디어 삭제 후보 측정 ${day}\n\n기준: ${decision.frontmatter.decisionKey} (${decision.frontmatter.appliesFrom})\n\n총 ${summary.total}건, 후보 ${summary.candidateItems}건, 후보 용량 ${summary.candidateBytes}바이트, 연사 대표 ${summary.representatives}건.\n\n## 유형·등급별 후보\n\n| 유형·등급 | 건수 | 바이트 |\n|---|---:|---:|\n${table(summary.candidates)}\n\n## 백업 확인만 남은 행(후보 아님)\n\n| 유형·등급 | 건수 | 바이트 |\n|---|---:|---:|\n${table(summary.pendingBackup)}\n\n## 감지 신호\n\n| 유형 | 건수 | |\n|---|---:|---|\n${table(summary.signals)}\n\n## 제외 사유\n\n| 사유 | 건수 | |\n|---|---:|---|\n${table(summary.exclusions)}\n\n개별 행과 연사 대표/나머지는 같은 날짜 JSONL에 기록했다.\n`;
  writeFileSync(join(directory, `${day}.md`), markdown, { mode: 0o600 });
  writeFileSync(join(directory, `${day}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
