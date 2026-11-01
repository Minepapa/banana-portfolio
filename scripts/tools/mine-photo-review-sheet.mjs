#!/usr/bin/env node
/**
 * 미네 사진 검수 시트(기억 판단 체계 §16.2, 2026-11-01 오너 "사진 검수 시트부터").
 *
 * 왜: 사진 기준 예시가 6장뿐이라 로컬 이미지 모델(qwen3-vl)이 3/6(답이 모두 기쁨 2)인지, 사진 종류 문턱(멀리서 = 사본 얼굴
 * 48px 미만, 잠정)이 맞는지 가를 오너 정답이 없다. 사진 종류별·얼굴 크기 구간별로 약 80장을 뽑아 오너가 직접 답하고(평가 세트),
 * 같은 사진에 대한 모델 답(밖에서 만든 jsonl)과 견준다.
 *
 * 하는 일(볼트·노트·판단 기록은 쓰지 않는다 — 결과는 볼트 밖 `Media/MemoryOrb/review/photo-<분>/`에만. 사진은 이 맥 밖으로
 * 보내지 않는다 — 이 도구는 어떤 모델도 부르지 않는다):
 *   1. 표본: 사진 구슬 잡의 후보 순간에서 잡과 같은 대표 사진 고르기(측정 도구 chooseCandidatePhotos)로 나온 사진을
 *      정해진 씨앗으로 섞어, 종류별(얼굴 가까이 15·멀리서 15·여럿이 함께 10·가려짐 10) + 멀리서 문턱용 사본 얼굴 px 구간별
 *      5장씩(20~30·30~40·40~50·50~60·60~80·80~120, 앞에서 뽑은 사진과 겹치면 다음 사진으로 채움). 기준 예시 사진(#33~38)과
 *      그 사진들과 같은 날 순간은 뺀다(정답이 이미 프롬프트에 있다).
 *   2. 시트: 세운 사진(메타데이터 지운 JPEG, 긴 변 1024px)을 HTML 하나에 넣는다. 오너는 표정이 읽히는지·감정 상태·감정·강도·
 *      메모를 고른다. 사진 종류와 모델 답은 시트에 넣지 않는다(답을 끌어당기지 않게). 답은 브라우저에 남고 JSON으로 내려받는다.
 *   3. --compare: 오너 답 + 모델 답 → 종류별 일치(상태·감정·강도), 얼굴 px 구간별 '표정 읽힘' 비율(멀리서 문턱),
 *      가려짐 사진에 실제로 미네가 보이는 수. 모델 답은 엔진과 무관한 카드 번호별 jsonl이다 — 한 줄에
 *      { no, state: 있음|감정 없음|모름, primaryEmotion, intensity } (photoId·title을 넣으면 번호표와 대조한다).
 *      2026-11-01 오너 결정으로 사진 감정은 로컬 모델이 장면 낱말만 뽑고 Claude가 그 글로 판단한다(그 경로는 아테나가 따로).
 *      그래서 qwen3-vl이 감정을 직접 답하는 실행은 이 도구에 두지 않는다.
 *
 * 사용:
 *   node scripts/tools/mine-photo-review-sheet.mjs --dry-run            # 표본만 보여 줌(파일 쓰기 없음)
 *   node scripts/tools/mine-photo-review-sheet.mjs                      # 시트 + 번호표(photo-cards-*.json)
 *   node scripts/tools/mine-photo-review-sheet.mjs --compare <photo-review-answers-*.json> <photo-cards-*.json> [<모델 답.jsonl>]
 *     (모델 답을 빼면 오너 답만 센다)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { VAULT_PATHS, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { loadEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { loadCandidates } from '../lib/mine-memory-candidates.mjs';
import { loadMineFaces } from '../lib/mine-record-input.mjs';
import { PHOTO_KINDS, loadPhotoFaces } from '../lib/mine-photo-kind.mjs';
import { EMOTION_STATES } from '../lib/mine-judgment-prompt.mjs';
import { mineAge } from '../jobs/mine-athena-fields.mjs';
import { verifyStripped } from './media-memory-orb-trial.mjs';
import { ANCHOR_ROOT, ANCHOR_SET } from './mine-anchor-trial.mjs';
import { chooseCandidatePhotos, measurePhoto, uprightSizes } from './mine-photo-kind-measure.mjs';
import { REVIEW_ROOT } from './mine-review-sheet.mjs';

export const PHOTO_REVIEW_SEED = 'photo-review-2026-11-01';
export const KIND_QUOTAS = Object.freeze({ [PHOTO_KINDS.close]: 15, [PHOTO_KINDS.far]: 15, [PHOTO_KINDS.group]: 10, [PHOTO_KINDS.hidden]: 10 });
// 멀리서 문턱(지금 48px)을 정할 구간. 오너 정답은 32px 모름·204px 읽힘뿐이라 그 사이를 고르게 본다.
export const FACE_PX_BUCKETS = Object.freeze([[20, 30], [30, 40], [40, 50], [50, 60], [60, 80], [80, 120]]);
export const BUCKET_COUNT = 5;
// 비교 보고서 구간: 표본 구간 앞뒤(20 미만·120 이상)도 세어 종류 표본 사진이 버려지지 않게.
export const REPORT_BUCKETS = Object.freeze([0, 20, 30, 40, 50, 60, 80, 120, Infinity]);
// 오너 화면용 사본. 모델 사본(768px)보다 크게 — 오너가 작은 얼굴의 표정을 읽을 수 있는지가 곧 재려는 값이다.
// 품질은 80장이 HTML 한 장(16MB 상한)에 넉넉히 들어가도록 정했다.
export const SHEET_LONG_SIDE = 1024;
export const SHEET_JPEG_QUALITY = 72;
export const SHEET_WARN_BYTES = 12 * 1024 * 1024;
export const READ_CHOICES = Object.freeze(['예', '아니오', '미네가 안 보임']);
export const MINE_NOT_VISIBLE = READ_CHOICES[2];

const hash = (value) => createHash('sha256').update(value).digest('hex');

// 경보 전 다섯 감정(결정 문서 §2 표의 1편). 이름은 결정 문서에서 읽는다.
export const sheetEmotions = (criteria) => criteria.emotions.filter((emotion) => emotion.part === 1).map((emotion) => emotion.name);

// 기준 예시 사진(시트 항목의 photo: 참조)과 그 날짜. 같은 날 순간 사진은 비슷한 장면이라 함께 뺀다.
export function anchorExclusions(items) {
  const photos = items.filter((item) => /^photo:[a-f0-9]{16}$/.test(item.ref ?? ''));
  return { ids: new Set(photos.map((item) => item.ref.slice(6))), dates: new Set(photos.map((item) => item.date).filter(Boolean)) };
}

// 후보 순간의 대표 사진 → 측정 행(종류·수치) + 순간 정보·미네 얼굴 상자. 측정 도구와 같은 고르기·같은 종류 계산.
export function collectPhotoRows({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, candidates, sizes = uprightSizes,
  faces, mine } = {}) {
  const chosen = chooseCandidatePhotos({ root, candidates: candidates ?? loadCandidates({ root, mediaRoot }) });
  const ids = chosen.flatMap((entry) => entry.photos.map((photo) => photo.id));
  const allFaces = faces ?? loadPhotoFaces({ ids });
  const mineFaces = mine ?? loadMineFaces({ ids });
  const absolute = (path) => resolve(mediaRoot, path);
  const sizeByPath = sizes([...new Set(chosen.flatMap((entry) => entry.photos.map((photo) => absolute(photo.path))))]);
  const rows = [];
  for (const { item, photos } of chosen) {
    for (const photo of photos) {
      const sized = sizeByPath.get(absolute(photo.path));
      const size = sized && !sized.error ? { width: sized.width, height: sized.height } : undefined;
      rows.push({ ...measurePhoto({ id: photo.id, path: photo.path, faces: allFaces.get(photo.id), mine: mineFaces.get(photo.id), size }),
        momentId: item.id, momentRel: item.rel, momentDate: item.date, chooseReason: photo.reason, mineBox: mineFaces.get(photo.id)?.bbox ?? null, item });
    }
  }
  return rows;
}

// 표본. rows는 collectPhotoRows 행. 정해진 씨앗으로 섞은 순서에서 앞부터 고르되, 한 순간에서는 먼저 한 장씩만
// (같은 자리 사진이 몰리지 않게) — 모자라면 같은 순간 사진으로 채운다. 같은 사진은 두 번 뽑지 않는다.
export function samplePhotos(rows, { exclude = { ids: new Set(), dates: new Set() }, seed = PHOTO_REVIEW_SEED,
  kindQuotas = KIND_QUOTAS, buckets = FACE_PX_BUCKETS, bucketCount = BUCKET_COUNT } = {}) {
  const seen = new Set();
  const pool = rows.filter((row) => row.kind && !exclude.ids.has(row.id) && !exclude.dates.has(row.momentDate))
    .sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`)) || a.momentId.localeCompare(b.momentId))
    .filter((row) => !seen.has(row.id) && seen.add(row.id));
  const picked = [];
  const usedMoments = new Set();
  const shortfalls = [];
  const take = (list, count, pickedFor) => {
    const before = picked.length;
    for (const freshMomentOnly of [true, false]) {
      for (const row of list) {
        if (picked.length - before >= count) break;
        if (picked.some((prior) => prior.id === row.id) || (freshMomentOnly && usedMoments.has(row.momentId))) continue;
        picked.push({ ...row, pickedFor });
        usedMoments.add(row.momentId);
      }
    }
    if (picked.length - before < count) shortfalls.push({ pickedFor, want: count, got: picked.length - before });
  };
  for (const [kind, count] of Object.entries(kindQuotas)) take(pool.filter((row) => row.kind === kind), count, `종류 ${kind}`);
  // 얼굴 크기만 다르게 보려고 얼굴 가까이·멀리서만 쓴다(여럿이 함께는 종류 규칙이 먼저라 크기와 섞인다).
  const sized = pool.filter((row) => (row.kind === PHOTO_KINDS.close || row.kind === PHOTO_KINDS.far) && Number.isFinite(row.metrics?.copyFacePx));
  for (const [low, high] of buckets) {
    take(sized.filter((row) => row.metrics.copyFacePx >= low && row.metrics.copyFacePx < high), bucketCount, `얼굴 ${low}~${high}px`);
  }
  // 시트 순서는 따로 섞는다 — 종류끼리 몰려 있으면 순서가 답을 끌어당긴다.
  const order = picked.sort((a, b) => hash(`${seed}:order:${a.id}`).localeCompare(hash(`${seed}:order:${b.id}`)));
  return { picked: order, shortfalls, poolSize: pool.length };
}

export const countBy = (rows, key) => rows.reduce((counts, row) => ({ ...counts, [key(row)]: (counts[key(row)] ?? 0) + 1 }), {});

// 오너 화면 사본: 잡 사본(makeCopy)과 같은 길 — faces-venv 파이썬으로 HEIC·EXIF 방향을 세우고, exiftool로 메타데이터를
// 지운 뒤 남은 태그가 없는지 확인한다. 크기·품질만 다르다(SHEET_LONG_SIDE). 사본 파일은 읽고 바로 지운다.
export const SHEET_COPY_SCRIPT = `from PIL import Image, ImageOps\nfrom pillow_heif import register_heif_opener\nimport sys, json\nregister_heif_opener()\nwith Image.open(sys.argv[1]) as source:\n    photo = ImageOps.exif_transpose(source).convert('RGB')\n    upright = {'width': photo.width, 'height': photo.height}\n    side = int(sys.argv[3])\n    photo.thumbnail((side, side))\n    photo.save(sys.argv[2], 'JPEG', quality=int(sys.argv[4]))\nprint(json.dumps({'upright': upright, 'copy': {'width': photo.width, 'height': photo.height}}))\n`;

function runTool(command, args, timeoutMs = 60_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  if (result.status !== 0) throw new Error(`${command}: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  return result.stdout;
}

export function sheetPhoto(source, { python = MEDIA_FACES_PATHS.python, tool = runTool, longSide = SHEET_LONG_SIDE, quality = SHEET_JPEG_QUALITY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mine-photo-review-'));
  try {
    const target = join(dir, 'photo.jpg');
    const sizes = JSON.parse(tool(python, ['-c', SHEET_COPY_SCRIPT, source, target, String(longSide), String(quality)]));
    if (!(sizes?.upright?.width > 0 && sizes?.upright?.height > 0)) throw new Error('세운 원본 크기 읽기 실패');
    if (Math.max(sizes.copy.width, sizes.copy.height) > longSide) throw new Error(`사본 크기 ${longSide}px 초과`);
    tool('exiftool', ['-all=', '-overwrite_original', target]);
    verifyStripped(target, tool);
    const bytes = readFileSync(target);
    return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, upright: sizes.upright, bytes: bytes.length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 미네 얼굴 상자(세운 원본 픽셀) → 사진 위 % 위치. 상자가 없거나 어긋나면 null.
export function boxPercent(bbox, size) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) || !(size?.width > 0 && size?.height > 0)) return null;
  const pct = (value, length) => Math.min(100, Math.max(0, (value / length) * 100));
  const [x1, y1, x2, y2] = [pct(bbox[0], size.width), pct(bbox[1], size.height), pct(bbox[2], size.width), pct(bbox[3], size.height)];
  if (x2 <= x1 || y2 <= y1) return null;
  const f = (value) => Number(value.toFixed(2));
  return { left: f(x1), top: f(y1), width: f(x2 - x1), height: f(y2 - y1) };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// 시트 HTML. cards: [{ no, title, photoId, date, age, image(data URL), box(boxPercent|null) }].
// 사진 종류·얼굴 크기·모델 답은 넣지 않는다(카드에 없는 값은 화면에 나올 수 없다). 미네 상자가 없는 카드(대개 가려짐)도
// 기본 화면은 같게 둔다 — 눌렀을 때만 '표시할 상자 없음'. 미리 글로 알리면 종류가 드러나고 '안 보임' 쪽으로 끌린다.
export function renderPhotoSheet(cards, { title, storageKey, downloadName, emotions }) {
  const buttons = (key, values, labels = values) => values.map((value, index) => `<button data-k="${key}" data-v="${escapeHtml(value)}">${escapeHtml(labels[index])}</button>`).join('');
  const card = (c) => `<section class="card" data-no="${c.no}" data-title="${escapeHtml(c.title)}" data-id="${escapeHtml(c.photoId)}">
<h2>${c.no}. ${escapeHtml(c.title)}</h2>
<p class="meta">${escapeHtml(c.date)}${c.age ? ` · 미네 ${escapeHtml(c.age)}` : ''}</p>
<div class="photo"><img src="${c.image}" alt="">${c.box ? `<div class="box" hidden style="left:${c.box.left}%;top:${c.box.top}%;width:${c.box.width}%;height:${c.box.height}%"></div>` : ''}</div>
<button class="toggle">미네 얼굴 표시</button><span class="none" hidden>표시할 상자 없음</span>
<div class="q"><b>① 미네 표정이 읽히나요?</b><div class="row">${buttons('read', READ_CHOICES)}</div></div>
<div class="q"><b>② 미네 감정</b><div class="row">${buttons('state', EMOTION_STATES)}</div>
<div class="row emo">${buttons('emo', emotions)}</div>
<div class="row int">${buttons('int', ['1', '2', '3'], ['옅음 1', '보통 2', '짙음 3'])}</div></div>
<textarea data-k="memo" maxlength="300" placeholder="메모(선택)"></textarea>
</section>`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin:auto;background:#fafafa;color:#222}header{position:sticky;top:0;background:#fafafa;padding:8px 0;border-bottom:1px solid #ddd;z-index:2}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px 14px;margin:14px 0}.card.done{border-color:#2a8a4a}h2{font-size:1.05rem;margin:0 0 4px}.meta{color:#666;margin:0 0 6px;font-size:.9rem}
.photo{position:relative;display:inline-block;max-width:100%;line-height:0}.photo img{max-width:100%;max-height:80vh;border-radius:6px}.box{position:absolute;border:3px solid #ff2d55;border-radius:4px;box-sizing:border-box;pointer-events:none}
.row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}button{font:inherit;padding:6px 10px;border:1px solid #bbb;border-radius:16px;background:#fff}button.on{background:#2a6fd6;color:#fff;border-color:#2a6fd6}button:disabled{opacity:.35}
.q{margin-top:8px}textarea{width:100%;box-sizing:border-box;margin-top:6px;min-height:2.4rem}.none{color:#999;font-size:.9rem}</style>
<header><b>${escapeHtml(title)}</b><br><span id="progress"></span> <button id="dl">답 내려받기</button> <button id="all">얼굴 표시 모두</button>
<p style="font-size:.85rem;color:#555;margin:4px 0">① 표정이 읽히는지, ② 감정 상태를 고르세요. '있음'이면 감정과 강도도 고릅니다. 답은 이 브라우저에 남고, 끝나면 내려받기를 누르세요.</p></header>
${cards.map(card).join('\n')}
<script>
const KEY=${JSON.stringify(storageKey)};let A={};try{A=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){A={}}
const cards=[...document.querySelectorAll('.card')];
for(const c of cards){const a=A[c.dataset.no];if(a&&(a.t!==c.dataset.title||a.id!==c.dataset.id))delete A[c.dataset.no]}
function store(){try{localStorage.setItem(KEY,JSON.stringify(A))}catch(e){}}
function ready(a){return a&&a.read&&a.state&&(a.state!=='있음'||(a.emo&&a.int))}
function render(){let done=0;for(const c of cards){const a=A[c.dataset.no]||{};
for(const b of c.querySelectorAll('button[data-k]'))b.classList.toggle('on',String(a[b.dataset.k])===b.dataset.v);
for(const b of c.querySelectorAll('.emo button,.int button'))b.disabled=a.state!=='있음';
const t=c.querySelector('textarea');if(document.activeElement!==t)t.value=a.memo||'';
c.classList.toggle('done',!!ready(a));if(ready(a))done++}
document.getElementById('progress').textContent='끝낸 사진 '+done+' / '+cards.length}
function entry(c){const no=c.dataset.no;return A[no]=Object.assign(A[no]||{},{t:c.dataset.title,id:c.dataset.id})}
for(const c of cards){
for(const b of c.querySelectorAll('button[data-k]'))b.onclick=()=>{const a=entry(c);a[b.dataset.k]=b.dataset.k==='int'?Number(b.dataset.v):b.dataset.v;if(a.state!=='있음'){delete a.emo;delete a.int}store();render()};
c.querySelector('textarea').oninput=(e)=>{entry(c).memo=e.target.value;store()};
const box=c.querySelector('.box'),none=c.querySelector('.none');c.querySelector('.toggle').onclick=()=>{if(box)box.hidden=!box.hidden;else none.hidden=!none.hidden}}
let shown=false;document.getElementById('all').onclick=()=>{shown=!shown;for(const box of document.querySelectorAll('.box'))box.hidden=!shown};
document.getElementById('dl').onclick=()=>{const b=new Blob([JSON.stringify(A,null,1)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=${JSON.stringify(downloadName)};a.click();setTimeout(()=>URL.revokeObjectURL(u),0)};
render();
</script></html>
`;
}

// 시트 파일 이름의 분 단위 판 이름: photo-cards-<판>.json ↔ photo-review-answers-<판>.json (브라우저가 붙인 " (1)"은 허용).
export function fileStamp(path, prefix, extension = 'json') {
  return basename(path).match(new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2})(?: \\(\\d+\\))?\\.${extension}$`))?.[1] ?? null;
}

const kstStamp = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace(/[T:]/g, '-');

export function buildSheet({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot, anchorRoot = ANCHOR_ROOT, out = REVIEW_ROOT,
  now = new Date(), criteria = loadEmotionCriteria(), seed = PHOTO_REVIEW_SEED, dryRun = false, photo = sheetPhoto, output = console,
  candidates, sizes, faces, mine } = {}) {
  const exclude = anchorExclusions(JSON.parse(readFileSync(join(anchorRoot, `items-${ANCHOR_SET}.json`), 'utf8')));
  const rows = collectPhotoRows({ root, mediaRoot, candidates, ...(sizes ? { sizes } : {}), faces, mine });
  const { picked, shortfalls, poolSize } = samplePhotos(rows, { exclude, seed });
  output.log(`대표 사진 ${rows.length}장 → 고를 수 있는 사진 ${poolSize}장(종류 없음·기준 예시 사진과 그 날 제외) → 표본 ${picked.length}장, 씨앗 ${seed}`);
  output.log(`  뽑은 까닭별: ${Object.entries(countBy(picked, (row) => row.pickedFor)).map(([key, value]) => `${key} ${value}`).join(' · ')}`);
  output.log(`  사진 종류별(표본 전체): ${Object.entries(countBy(picked, (row) => row.kind)).map(([key, value]) => `${key} ${value}`).join(' · ')}`);
  for (const gap of shortfalls) output.error(`  모자람: ${gap.pickedFor} ${gap.got}/${gap.want}`);
  if (dryRun) return { picked, shortfalls };

  // 만들 때마다 다른 폴더(KST 분 단위, 한 번에 만들기) — 앞 시트의 답·번호표와 섞이지 않는다.
  const stamp = kstStamp(now);
  const dir = join(out, `photo-${stamp}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`이미 있는 시트 폴더(1분 뒤 다시): ${dir}`);
    throw error;
  }
  const made = [];
  let imageBytes = 0;
  for (const row of picked) {
    try {
      const image = photo(resolve(mediaRoot, row.path));
      imageBytes += image.bytes;
      made.push({ row, image });
    } catch (error) { output.error(`사진 사본 실패, 시트에서 뺌: ${row.path} — ${error.message}`); }
  }
  const cards = made.map(({ row, image }, index) => ({
    no: index + 1, title: `${row.momentDate} ${basename(row.path)}`, photoId: row.id, momentId: row.momentId, momentRel: row.momentRel,
    date: row.momentDate, path: row.path, pickedFor: row.pickedFor, kind: row.kind, kindReason: row.reason, chooseReason: row.chooseReason,
    copyFacePx: row.metrics?.copyFacePx ?? null, faceCount: row.metrics?.faceCount ?? null, comparableFaces: row.metrics?.comparableFaces ?? null,
    mineBox: row.mineBox, size: image.upright, image: image.dataUrl, box: boxPercent(row.mineBox, image.upright),
    age: mineAge(row.item.fields.occurred) == null ? null : `만 ${mineAge(row.item.fields.occurred)}세`,
  }));
  const sheetPath = join(dir, `photo-review-sheet-${stamp}.html`);
  const html = renderPhotoSheet(cards, { title: '미네 사진 검수', storageKey: `mine-photo-review-${stamp}`,
    downloadName: `photo-review-answers-${stamp}.json`, emotions: sheetEmotions(criteria) });
  writeFileSync(sheetPath, html, { mode: 0o600, flag: 'wx' });
  // 번호표: --compare(와 모델 답을 만드는 쪽)가 이 표로 사진·순간을 잇고, 제목·사진 id로 어긋남을 막는다. 덮지 않는다.
  const cardsPath = join(dir, `photo-cards-${stamp}.json`);
  writeFileSync(cardsPath, `${JSON.stringify(cards.map(({ image, box, age, ...rest }) => rest), null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  // 순간 정보 사본: 모델 답을 만드는 쪽이 시트를 만든 때의 순간 노트를 쓰게(그사이 구슬이 써져 후보에서 빠져도 같은 입력).
  const moments = Object.fromEntries(made.map(({ row }) => [row.momentId, { id: row.item.id, rel: row.item.rel, date: row.item.date,
    title: row.item.title, fields: row.item.fields, memo: row.item.memo ?? '', album: row.item.album ?? null }]));
  const momentsPath = join(dir, `photo-moments-${stamp}.json`);
  writeFileSync(momentsPath, `${JSON.stringify(moments, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  // 표본 기록: 씨앗·고를 수 있던 사진 수·모자람 — 콘솔이 사라져도 표본을 다시 만들고 근거로 쓸 수 있게.
  writeFileSync(join(dir, `photo-sample-${stamp}.json`), `${JSON.stringify({ seed, kindQuotas: KIND_QUOTAS, buckets: FACE_PX_BUCKETS, bucketCount: BUCKET_COUNT,
    photoRows: rows.length, poolSize, picked: picked.length, cards: cards.length, shortfalls, byPickedFor: countBy(picked, (row) => row.pickedFor),
    byKind: countBy(cards, (row) => row.kind), anchorSet: ANCHOR_SET }, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  const htmlBytes = Buffer.byteLength(html);
  output.log(`시트: ${sheetPath} (${(htmlBytes / 1024 / 1024).toFixed(1)}MB, 사진 ${cards.length}장 평균 ${Math.round(imageBytes / Math.max(1, cards.length) / 1024)}KB)`);
  output.log(`번호표: ${cardsPath}`);
  if (htmlBytes > SHEET_WARN_BYTES) output.error(`시트가 큼(${(htmlBytes / 1024 / 1024).toFixed(1)}MB) — SHEET_JPEG_QUALITY를 낮출 것`);
  return { sheetPath, cardsPath, momentsPath, cards, htmlBytes, shortfalls, stamp };
}

// 모델 답 파일 읽기: 잘린 끝 줄·깨진 줄은 건너뛰고, 카드 번호마다 마지막 줄이 이긴다.
export function readModelRows(path, output = console) {
  const latest = new Map();
  if (!existsSync(path)) return latest;
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { output.error(`모델 답 깨진 줄 건너뜀: ${line.slice(0, 80)}`); continue; }
    if (Number.isInteger(row?.no)) latest.set(row.no, row);
    else output.error(`모델 답 번호(no)가 정수가 아님, 건너뜀: ${line.slice(0, 80)}`);
  }
  return latest;
}

export const ownerReady = (answer) => Boolean(answer?.read && answer?.state && (answer.state !== '있음' || (answer.emo && answer.int)));

// 모델 답 한 줄의 모양: 있음이면 대표 감정과 강도 1~3, 아니면 감정 칸이 비어 있다.
export const modelReady = (row) => EMOTION_STATES.includes(row?.state) && (row.state === '있음'
  ? typeof row.primaryEmotion === 'string' && [1, 2, 3].includes(row.intensity) : row.primaryEmotion == null);

export function bucketLabel(value, edges = REPORT_BUCKETS) {
  if (!Number.isFinite(value)) return null;
  const index = edges.findIndex((edge, at) => at > 0 && value < edge);
  return `${edges[index - 1]}~${edges[index] === Infinity ? '' : edges[index]}`;
}

// 오너 답·모델 답 대조. 카드와 답의 제목·사진 id가 다르면 그 답은 쓰지 않고 mismatches에 남긴다.
export function compareAnswers({ cards, answers, modelRows = new Map() }) {
  const mismatches = [];
  const rows = cards.map((card) => {
    let owner = answers[String(card.no)];
    if (owner && (owner.t !== card.title || owner.id !== card.photoId)) { mismatches.push(`${card.no}번 오너 답의 사진이 번호표와 다름(${owner.t ?? '제목 없음'})`); owner = undefined; }
    let model = modelRows.get(card.no);
    if (model && ((model.photoId !== undefined && model.photoId !== card.photoId) || (model.title !== undefined && model.title !== card.title))) {
      mismatches.push(`${card.no}번 모델 답의 사진이 번호표와 다름`); model = undefined;
    }
    if (model && !model.error && !modelReady(model)) { mismatches.push(`${card.no}번 모델 답 모양이 틀림(state·primaryEmotion·intensity)`); model = undefined; }
    if (owner?.read === MINE_NOT_VISIBLE && owner.state === '있음') mismatches.push(`${card.no}번 오너 답: 미네가 안 보이는데 감정 있음(그대로 셈)`);
    return { card, read: owner?.read ?? null, owner: ownerReady(owner) ? owner : null, model: model && !model.error ? model : null };
  });
  const tally = (list) => {
    const both = list.filter((row) => row.owner && row.model);
    const stateSame = both.filter((row) => row.owner.state === row.model.state);
    const emotionSame = stateSame.filter((row) => row.owner.state !== '있음' || row.owner.emo === row.model.primaryEmotion);
    const intensityBase = both.filter((row) => row.owner.state === '있음' && row.model.state === '있음' && row.owner.emo === row.model.primaryEmotion);
    return { cards: list.length, owner: list.filter((row) => row.owner).length, both: both.length, stateSame: stateSame.length,
      emotionSame: emotionSame.length, intensityBase: intensityBase.length,
      intensitySame: intensityBase.filter((row) => row.owner.int === row.model.intensity).length,
      read: countBy(list.filter((row) => row.owner), (row) => row.owner.read),
      ownerStates: countBy(list.filter((row) => row.owner), (row) => row.owner.state === '있음' ? `${row.owner.emo} ${row.owner.int}` : row.owner.state),
      modelStates: countBy(list.filter((row) => row.model), (row) => row.model.state === '있음' ? `${row.model.primaryEmotion} ${row.model.intensity}` : row.model.state) };
  };
  const kinds = [...Object.values(PHOTO_KINDS), null];
  const byKind = kinds.map((kind) => [kind, tally(rows.filter((row) => (row.card.kind ?? null) === kind))]).filter(([, stats]) => stats.cards);
  const labels = REPORT_BUCKETS.slice(1).map((edge, index) => bucketLabel(REPORT_BUCKETS[index], REPORT_BUCKETS));
  const byBucket = labels.map((label) => [label, tally(rows.filter((row) => bucketLabel(row.card.copyFacePx) === label))]).filter(([, stats]) => stats.cards);
  // 가려짐 집계는 읽힘 답만 있어도 센다(감정 상태를 비워 둔 카드가 분모에서 조용히 빠지지 않게).
  const hidden = rows.filter((row) => row.card.kind === PHOTO_KINDS.hidden && row.read);
  return { rows, all: tally(rows), byKind, byBucket, mismatches,
    hidden: { answered: hidden.length, mineVisible: hidden.filter((row) => row.read !== MINE_NOT_VISIBLE).length,
      readable: hidden.filter((row) => row.read === '예').length },
    modelUsed: rows.filter((row) => row.model).length, modelById: rows.filter((row) => row.model?.photoId !== undefined).length };
}

const rate = (part, whole) => whole ? `${part}/${whole} (${Math.round((part / whole) * 100)}%)` : '-';
const counts = (map) => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join(' · ') || '-';

export function renderCompare(stats, { stamp, modelRowCount }) {
  const kindRow = ([kind, s]) => `| ${kind ?? '종류 없음'} | ${s.cards} | ${s.owner} | ${s.both} | ${rate(s.stateSame, s.both)} | ${rate(s.emotionSame, s.both)} | ${rate(s.intensitySame, s.intensityBase)} | ${rate(s.read['예'] ?? 0, s.owner)} |`;
  const bucketRow = ([label, s]) => `| ${label} | ${s.owner} | ${s.read['예'] ?? 0} | ${s.read['아니오'] ?? 0} | ${s.read[MINE_NOT_VISIBLE] ?? 0} | ${rate(s.read['예'] ?? 0, s.owner)} | ${rate(s.read['예'] ?? 0, (s.read['예'] ?? 0) + (s.read['아니오'] ?? 0))} | ${rate(s.emotionSame, s.both)} |`;
  return [`# 미네 사진 검수 대조 ${stamp}`, '',
    `- 카드 ${stats.all.cards}장 · 오너가 끝낸 카드 ${stats.all.owner}장 · 모델 답 줄 ${modelRowCount}개 중 대조에 쓴 ${stats.modelUsed}장(사진 id로 대조 ${stats.modelById}장) · 둘 다 있는 카드 ${stats.all.both}장`,
    `- 전체 일치: 상태 ${rate(stats.all.stateSame, stats.all.both)} · 감정(상태+대표 감정) ${rate(stats.all.emotionSame, stats.all.both)} · 강도(감정이 같을 때) ${rate(stats.all.intensitySame, stats.all.intensityBase)}`,
    `- 오너 답 분포: ${counts(stats.all.ownerStates)}`, `- 모델 답 분포: ${counts(stats.all.modelStates)}`,
    ...(stats.mismatches.length ? ['', '## 쓰지 않은 답(번호표와 다름)', '', ...stats.mismatches.map((line) => `- ${line}`)] : []),
    '', '## 사진 종류별 일치', '', '감정 = 상태가 같고, 있음이면 대표 감정도 같음. 강도 = 둘 다 같은 감정일 때만 센다. 가려짐은 잡이 감정을 모름으로 두는 종류다(모델 답이 그 규칙을 따랐는지는 답을 만든 쪽 몫).', '',
    '| 종류 | 카드 | 오너 답 | 둘 다 | 상태 | 감정 | 강도 | 표정 읽힘(예) |', '|---|---|---|---|---|---|---|---|', ...stats.byKind.map(kindRow),
    '', '## 사본 얼굴 px 구간별 표정 읽힘 (멀리서 문턱, 지금 48px)', '',
    '모델이 보는 사본(긴 변 768px)에서 미네 얼굴 짧은 변. 종류 표본·구간 표본 모두 센다.', '',
    '| 구간 px | 오너 답 | 예 | 아니오 | 안 보임 | 읽힘(전체) | 읽힘(예+아니오 중) | 모델 감정 일치 |', '|---|---|---|---|---|---|---|---|', ...stats.byBucket.map(bucketRow),
    '', '## 가려짐 사진에 실제로 미네가 보이나', '',
    `- 오너가 답한 가려짐 ${stats.hidden.answered}장 중 미네가 보임 ${stats.hidden.mineVisible}장(그중 표정 읽힘 ${stats.hidden.readable}장) — 얼굴 인식이 미네를 놓친 사진 후보`,
    ''].join('\n');
}

export function compareFiles({ answersPath, cardsPath, modelPath, output = console }) {
  const stamp = fileStamp(cardsPath, 'photo-cards');
  if (!stamp || stamp !== fileStamp(answersPath, 'photo-review-answers')) {
    throw new Error(`답 파일과 번호표가 같은 시트가 아님(내려받은 이름이 바뀌었으면 photo-review-answers-<판>.json으로 고쳐서 다시): ${basename(answersPath)} ↔ ${basename(cardsPath)}`);
  }
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
  const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
  if (modelPath && !existsSync(modelPath)) throw new Error(`모델 답 파일 없음: ${modelPath}`);
  // 모델 답 이름에 판이 들어 있으면 번호표 판과 같아야 한다 — 카드 번호는 판마다 다른 사진이라 다른 판 답이 조용히 섞인다.
  const modelStamp = modelPath && basename(modelPath).match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})/)?.[1];
  if (modelStamp && modelStamp !== stamp) throw new Error(`모델 답이 다른 시트 판(${modelStamp})이다: ${basename(modelPath)} ↔ ${basename(cardsPath)}`);
  const modelRows = modelPath ? readModelRows(modelPath, output) : new Map();
  const stats = compareAnswers({ cards, answers, modelRows });
  for (const no of modelRows.keys()) if (!cards.some((card) => card.no === no)) output.error(`모델 답 ${no}번은 번호표에 없는 카드 — 건너뜀`);
  const report = renderCompare(stats, { stamp, modelRowCount: modelRows.size });
  // 다시 돌리면 덮는다 — 원본은 답·번호표·모델 답이고 보고서는 그 파생물이다.
  const reportPath = join(dirname(cardsPath), `photo-compare-${stamp}.md`);
  writeFileSync(reportPath, report, { mode: 0o600 });
  output.log(report);
  output.log(`보고서: ${reportPath}`);
  return { stats, reportPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const usage = '사용: node scripts/tools/mine-photo-review-sheet.mjs [--dry-run | --compare <photo-review-answers-*.json> <photo-cards-*.json> [<모델 답.jsonl>]]';
  const fail = (error) => { console.error(`❌ ${error.message}`); process.exit(1); };
  if (args[0] === '--compare') {
    if (![3, 4].includes(args.length) || args.slice(1).some((arg) => arg.startsWith('--'))) { console.error(usage); process.exit(2); }
    try { compareFiles({ answersPath: args[1], cardsPath: args[2], modelPath: args[3] }); } catch (error) { fail(error); }
  } else {
    if (args.some((arg) => arg !== '--dry-run')) { console.error(usage); process.exit(2); }
    try { buildSheet({ dryRun: args.includes('--dry-run') }); } catch (error) { fail(error); }
  }
}
