#!/usr/bin/env node
/**
 * 미네 사진 종류(§16.2) 문턱 재기 — 읽기 전용. 볼트·노트·판단 기록은 쓰지 않고 보고서는 볼트 밖
 * `Media/MemoryOrb/photo-kind/`에만 남긴다. 모델 호출 없음(얼굴 색인·사진 머리 정보만 읽는다).
 *
 * 왜(2026-11-01 오너 "사진 종류부터 코드로"): 종류 문턱을 짐작으로 정하지 않고, 사진 구슬 잡의 실제 후보 순간에서
 * 잡이 고르는 대표 사진(choosePhotos, 순간당 최대 3장)과 기준 예시 사진 6장(#33~38)의 수치로 정한다.
 *
 * 사진 크기: 얼굴 상자는 세운 원본 픽셀 기준이다(media_faces.py가 exif_transpose 뒤 검출). 여기서는 사진을 풀지 않고
 * EXIF 방향 태그(5~8이면 가로세로 바뀜)로 세운 크기를 얻는다 — exif_transpose와 같은 태그를 읽으므로 같은 크기다.
 *
 * 사용: node scripts/tools/mine-photo-kind-measure.mjs [--out=<폴더>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { loadCandidates } from '../lib/mine-memory-candidates.mjs';
import { loadMineFaces } from '../lib/mine-record-input.mjs';
import { PHOTO_KINDS, PHOTO_KIND_RULES, loadPhotoFaces, momentForcesUnknown, photoKind } from '../lib/mine-photo-kind.mjs';
import { choosePhotos } from './media-memory-orb-trial.mjs';
import { ANCHOR_ROOT, ANCHOR_SET } from './mine-anchor-trial.mjs';

export const PHOTO_KIND_ROOT = join(homedir(), 'Pantheon', 'Media', 'MemoryOrb', 'photo-kind');

// 세운 크기만 읽는다(사진을 풀지 않음). 한 줄에 경로 하나 → 한 줄에 {path, width, height} 또는 {path, error}.
export const UPRIGHT_SIZE_SCRIPT = `from PIL import Image\nfrom pillow_heif import register_heif_opener\nimport sys, json\nregister_heif_opener()\nfor path in json.load(sys.stdin):\n    try:\n        with Image.open(path) as source:\n            width, height = source.size\n            if source.getexif().get(0x0112) in (5, 6, 7, 8):\n                width, height = height, width\n        print(json.dumps({'path': path, 'width': width, 'height': height}))\n    except Exception as error:\n        print(json.dumps({'path': path, 'error': str(error)}))\n`;

export function uprightSizes(paths, { python = MEDIA_FACES_PATHS.python, execute = spawnSync } = {}) {
  if (!paths.length) return new Map();
  const result = execute(python, ['-c', UPRIGHT_SIZE_SCRIPT], { input: JSON.stringify(paths), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  if (result.status !== 0) throw new Error(`사진 크기 읽기 실패: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  return new Map(result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((row) => [row.path, row]));
}

const jsonLines = (path) => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)) : [];

// 분위수(정렬된 수치에서 가까운 순위) → [[분위, 값], …]. 빈 목록이면 null.
export function quantiles(values, points = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return points.map((point) => [point, sorted[Math.min(sorted.length - 1, Math.round(point * (sorted.length - 1)))]]);
}

// 사진 한 장 → 측정 행. faces = 얼굴 색인의 그 사진 얼굴들(없으면 얼굴 분석 전), mine = loadMineFaces 값.
export function measurePhoto({ id, path, faces, mine, size }) {
  const result = photoKind({ analyzed: faces !== undefined, faces: faces ?? [], mineIndex: mine?.i, size });
  return { id, path, analyzed: faces !== undefined, size: size ?? null, kind: result?.kind ?? null, reason: result?.reason ?? (faces === undefined ? '얼굴 분석 전' : '사진 크기 못 읽음'),
    metrics: result?.metrics ?? null };
}

export function count(rows, key) {
  const counts = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}

const fixed = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '-';

export function renderReport({ startedAt, anchors, photos, moments }) {
  const kindOrder = [...Object.values(PHOTO_KINDS), 'null'];
  const counts = count(photos, (row) => String(row.kind));
  const visible = photos.filter((row) => row.metrics?.mineFound);
  const q = (values, digits) => {
    const result = quantiles(values);
    return result ? result.map(([point, value]) => `${Math.round(Number(point) * 100)}%=${fixed(value, digits)}`).join(' · ') : '-';
  };
  const momentKinds = count(moments, (row) => row.kinds.map((kind) => kind ?? '종류 없음').sort().join('+'));
  const forced = moments.filter((row) => row.forcesUnknown).length;
  return [`# 미네 사진 종류 측정 ${startedAt.slice(0, 16).replace('T', ' ')}`, '',
    `- 문턱: ${JSON.stringify(PHOTO_KIND_RULES)}`,
    `- 후보 순간 ${moments.length}개(사진 구슬 잡 후보, 잡과 같은 대표 사진 고르기) · 대표 사진 ${photos.length}장`,
    `- 사진 종류: ${kindOrder.map((kind) => `${kind === 'null' ? '종류 없음(얼굴 분석 전·크기 못 읽음)' : kind} ${counts[kind] ?? 0}`).join(' · ')}`,
    `- 감정을 코드가 '모름'으로 두는 순간(대표 사진 모두 가려짐): ${forced}개`,
    '', '## 기준 예시 사진(#33~38)', '',
    '| # | 오너 답 | 종류 | 얼굴 수 | 비슷한 크기 | 미네 가로×세로(비율) | 사본 얼굴 px | 검출 | 흐림 | 크기 |', '|---|---|---|---|---|---|---|---|---|---|',
    ...anchors.map((row) => `| ${row.no} | ${row.answer} | ${row.kind ?? '-'} | ${row.metrics?.faceCount ?? '-'} | ${row.metrics?.comparableFaces ?? '-'} | ${
      fixed(row.metrics?.mineWidthRatio, 3)}×${fixed(row.metrics?.mineHeightRatio, 3)} | ${fixed(row.metrics?.copyFacePx, 0)} | ${
      fixed(row.metrics?.det, 3)} | ${fixed(row.metrics?.blur, 0)} | ${row.size ? `${row.size.width}×${row.size.height}` : '-'} |`),
    '', '## 미네 얼굴이 보이는 대표 사진의 분포', '',
    `- 사진 ${visible.length}장`,
    `- 사본 얼굴 px(짧은 변): ${q(visible.map((row) => row.metrics.copyFacePx), 0)}`,
    `- 미네 얼굴 가로 비율: ${q(visible.map((row) => row.metrics.mineWidthRatio), 3)}`,
    `- 비슷한 크기 얼굴 수: ${q(visible.map((row) => row.metrics.comparableFaces), 0)}`,
    `- 전체 얼굴 수: ${q(visible.map((row) => row.metrics.faceCount), 0)}`,
    `- 검출 점수: ${q(visible.map((row) => row.metrics.det), 3)}`,
    `- 흐림(라플라시안 분산, 원본 얼굴): ${q(visible.map((row) => row.metrics.blur), 0)}`,
    `- 사본 얼굴 px 구간: ${[0, 20, 30, 40, 50, 60, 80, 100, 150, 200, Infinity].reduce((parts, edge, index, edges) => index === 0 ? parts
      : [...parts, `${edges[index - 1]}~${edge === Infinity ? '' : edge} ${visible.filter((row) => row.metrics.copyFacePx >= edges[index - 1] && row.metrics.copyFacePx < edge).length}`], []).join(' · ')}`,
    `- 비슷한 크기 얼굴 수별: ${Object.entries(count(visible, (row) => row.metrics.comparableFaces)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([key, value]) => `${key}개 ${value}`).join(' · ')}`,
    '', '## 순간별 종류 조합', '',
    ...Object.entries(momentKinds).sort((a, b) => b[1] - a[1]).map(([key, value]) => `- ${key}: ${value}`),
    ''].join('\n');
}

// 후보 순간마다 잡(media-memory-orb run)과 같은 대표 사진 고르기 → [{ item, photos }]. 재료: 미네 얼굴 점수·Vision 장면.
// 사진 검수 시트(mine-photo-review-sheet)도 같은 고르기를 써서 시트 사진이 잡이 실제로 볼 사진과 같다.
export function chooseCandidatePhotos({ root = VAULT_PATHS.root, candidates, matchesPath = MEDIA_FACES_PATHS.matches }) {
  const scoreById = new Map();
  for (const face of jsonLines(matchesPath)) {
    if (face.person === '미네' || face.label === 'mine' && !face.person) scoreById.set(face.id, Math.max(scoreById.get(face.id) ?? 0, Number(face.score) || 0));
  }
  const visionById = new Map(jsonLines(join(root, VAULT_REL.mediaVisionIndex)).map((row) => [row.id, row]));
  return candidates.map((item) => ({ item, photos: choosePhotos(item, scoreById, visionById) }));
}

export function run({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, anchorRoot = ANCHOR_ROOT, out = PHOTO_KIND_ROOT,
  candidates, sizes = uprightSizes, now = () => Date.now(), output = console } = {}) {
  const startedAt = new Date(now()).toISOString();
  const chosen = chooseCandidatePhotos({ root, candidates: candidates ?? loadCandidates({ root, mediaRoot }) });
  // 기준 예시 사진(오너가 감정 답을 단 사진만): 시트 항목 + 미디어 색인 경로.
  const items = JSON.parse(readFileSync(join(anchorRoot, `items-${ANCHOR_SET}.json`), 'utf8'));
  const answers = JSON.parse(readFileSync(join(anchorRoot, `anchor-answers-${ANCHOR_SET}.json`), 'utf8'));
  const mediaById = new Map([...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)), ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))].map((row) => [row.id, row]));
  const anchorPhotos = items.filter((item) => /^photo:[a-f0-9]{16}$/.test(item.ref ?? '') && answers[String(item.no)]?.emo)
    .map((item) => { const id = item.ref.slice(6); const source = mediaById.get(id);
      const answer = answers[String(item.no)];
      return { no: item.no, id, path: source?.archivePath ?? source?.importPath ?? null, answer: `${answer.emo}${answer.int ? ` ${answer.int}` : ''}` }; });
  const ids = [...chosen.flatMap((entry) => entry.photos.map((photo) => photo.id)), ...anchorPhotos.map((row) => row.id)];
  const faces = loadPhotoFaces({ ids });
  const mine = loadMineFaces({ ids });
  const absolute = (path) => resolve(mediaRoot, path);
  const sizeByPath = sizes([...new Set([...chosen.flatMap((entry) => entry.photos.map((photo) => absolute(photo.path))),
    ...anchorPhotos.filter((row) => row.path).map((row) => absolute(row.path))])]);
  const sizeOf = (path) => { const row = path && sizeByPath.get(absolute(path)); return row && !row.error ? { width: row.width, height: row.height } : undefined; };
  const photos = []; const moments = [];
  for (const { item, photos: picked } of chosen) {
    const rows = picked.map((photo) => measurePhoto({ id: photo.id, path: photo.path, faces: faces.get(photo.id), mine: mine.get(photo.id), size: sizeOf(photo.path) }));
    photos.push(...rows.map((row) => ({ ...row, momentId: item.id })));
    moments.push({ id: item.id, rel: item.rel, kinds: rows.map((row) => row.kind), forcesUnknown: momentForcesUnknown(rows) });
  }
  const anchors = anchorPhotos.map((row) => ({ ...row, ...measurePhoto({ id: row.id, path: row.path, faces: faces.get(row.id), mine: mine.get(row.id), size: sizeOf(row.path) }) }));
  const runDir = join(out, startedAt.replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDir, 'photos.jsonl'), photos.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(runDir, 'anchors.json'), `${JSON.stringify(anchors, null, 2)}\n`, { mode: 0o600 });
  const report = renderReport({ startedAt, anchors, photos, moments });
  writeFileSync(join(runDir, 'report.md'), report, { mode: 0o600 });
  output.log(report);
  output.log(`결과: ${runDir}/report.md`);
  return { anchors, photos, moments, runDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const unknown = args.filter((value) => !/^--out=.+/.test(value));
  if (unknown.length) { console.error(`모르는 인자: ${unknown.join(' ')}\n사용: node scripts/tools/mine-photo-kind-measure.mjs [--out=<폴더>]`); process.exit(2); }
  const out = args.find((value) => value.startsWith('--out='))?.slice(6);
  try { run(out ? { out } : {}); }
  catch (error) { console.error(`❌ ${error.message}`); process.exit(1); }
}
