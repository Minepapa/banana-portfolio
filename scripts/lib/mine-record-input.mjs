// 미네 기록 판단의 입력 정리(기억 판단 체계 §15.3 1단계 ④). 로컬 모델은 문맥이 16k라
// 기록 전체를 넣지 않고, 판단 근거가 되는 것만 추린다.
// - 통화·녹음: 전사 구간(### 머리)마다 따로 본다. 화자가 표시된 구간은 미네 발화는 모두, 다른 화자 말은
//   미네 말 바로 앞 한 줄만(맥락용, 짧게). 화자 표시가 없는 구간(한 사람 녹음·화자 분리 전)은 그 구간 전체.
//   `[화자 확인 필요]`(화자 배정이 불확실함, media-dialogue) 표시는 남긴다. 파일 경로(원본: …)와 오너 메모 절은
//   뺀다 — 오너 메모는 프롬프트가 따로 넣는다.
// - 사진: 미네 얼굴 상자(faces-index bbox, 세운 원본 픽셀 기준)를 0~1 비율로 바꿔 사진마다 붙인다.
import { existsSync, readFileSync } from 'node:fs';
import { MEDIA_FACES_PATHS } from './vault-paths.mjs';

export const MINE_SPEAKER = '미네';
export const SPEAKER_CHECK = '[화자 확인 필요]';
export const MAX_INPUT_CHARS = 2_500;
export const CONTEXT_LINE_CHARS = 80;

const SPEAKER_LINE = /^([^:\s]{1,6}): /;
const clip = (text, max) => text.length > max ? `${text.slice(0, max)}…` : text;

// 머리말·HTML 주석·오너 메모 절·파일 경로 줄을 뺀 전사 본문의 줄.
function transcriptLines(content) {
  const end = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
  const body = (end === -1 ? content : content.slice(end + 4)).split(/^## 오너 메모\s*$/m)[0];
  return body.replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^원본: /.test(line) && !/^# /.test(line));
}

// 전사 구간: ### 머리마다 나눈다(머리 앞 줄은 첫 구간).
function sections(lines) {
  const groups = [[]];
  for (const line of lines) {
    if (/^#{2,4} /.test(line) && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(line);
  }
  return groups;
}

// 돌려주는 값: { text, mode: 'mine'|'whole'|'mixed', mineLines, contextLines, truncated }.
// mode — mine: 모든 구간에 화자 표시 · whole: 화자 표시 없음 · mixed: 섞임.
export function mineConversation(content, { maxChars = MAX_INPUT_CHARS, contextChars = CONTEXT_LINE_CHARS } = {}) {
  const isMine = (line) => line?.startsWith(`${MINE_SPEAKER}: `);
  const kinds = new Set();
  // 줄마다 역할: mine(미네 발화·화자 없는 구간의 줄) · context(미네 말 바로 앞 다른 화자 한 줄) · keep(머리·화자 확인 표시).
  const picked = sections(transcriptLines(content)).flatMap((lines) => {
    const labelled = lines.some(isMine);
    if (lines.some((line) => !/^#{2,4} /.test(line))) kinds.add(labelled ? 'mine' : 'whole');
    return lines.map((line, index) => {
      if (/^#{2,4} /.test(line) || line.trim() === SPEAKER_CHECK) return { line, role: 'keep' };
      if (!labelled || isMine(line)) return { line, role: 'mine' };
      if (SPEAKER_LINE.test(line) && isMine(lines[index + 1])) return { line: clip(line, contextChars), role: 'context' };
      return null;
    }).filter(Boolean);
  });
  const mode = kinds.size === 2 ? 'mixed' : kinds.has('mine') ? 'mine' : 'whole';
  const total = (rows) => rows.reduce((sum, row) => sum + row.line.length + 1, 0);
  let rows = picked;
  // 넘치면 맥락 줄부터 뺀다. 그래도 넘치면 미네 말을 뒤에서 자른다(앞부분이 대화의 시작이라 남긴다).
  if (total(rows) > maxChars) rows = rows.filter((row) => row.role !== 'context');
  let truncated = total(picked) > maxChars;
  let text = rows.map((row) => row.line).join('\n');
  if (text.length > maxChars) { text = `${text.slice(0, maxChars)}…(이하 생략)`; truncated = true; }
  return { text, mode, mineLines: rows.filter((row) => row.role === 'mine' && isMine(row.line)).length,
    contextLines: rows.filter((row) => row.role === 'context').length, truncated };
}

// 미네로 확인된 얼굴(matches.jsonl) 중 사진마다 점수가 가장 높은 하나의 상자. 색인에 없으면 빠진다.
export function loadMineFaces({ matchesPath = MEDIA_FACES_PATHS.matches, indexPath = MEDIA_FACES_PATHS.index, ids } = {}) {
  const wanted = ids ? new Set(ids) : null;
  const best = new Map();
  const rows = (path) => existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)) : [];
  for (const match of rows(matchesPath)) {
    // 미네 판정: person이 미네이거나, 이름이 없고 label이 mine(media-memory-orb의 얼굴 점수와 같은 규칙).
    if (!(match.person === MINE_SPEAKER || match.label === 'mine' && !match.person)) continue;
    if (wanted && !wanted.has(match.id)) continue;
    const score = Number(match.score) || 0;
    if (!best.has(match.id) || best.get(match.id).score < score) best.set(match.id, { i: match.i, score });
  }
  const faces = new Map();
  for (const entry of rows(indexPath)) {
    const mine = best.get(entry.id);
    const bbox = mine && entry.faces?.find((face) => face.i === mine.i)?.bbox;
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) faces.set(entry.id, { ...mine, bbox });
  }
  return faces;
}

// 픽셀 상자 → 0~1 비율 상자와 위치 말(이미지 모델에 글로 준다). size = 세운 원본 크기(makeCopy가 돌려줌).
export function faceBoxText(bbox, size) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !(size?.width > 0 && size?.height > 0)) return null;
  const ratio = (value, length) => Math.min(1, Math.max(0, value / length));
  const [x1, y1, x2, y2] = [ratio(bbox[0], size.width), ratio(bbox[1], size.height), ratio(bbox[2], size.width), ratio(bbox[3], size.height)];
  if (x2 <= x1 || y2 <= y1) return null;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;
  const horizontal = centerX < 1 / 3 ? '왼쪽' : centerX > 2 / 3 ? '오른쪽' : '가운데';
  const vertical = centerY < 1 / 3 ? '위' : centerY > 2 / 3 ? '아래' : '중간';
  const where = horizontal === '가운데' && vertical === '중간' ? '한가운데' : `${horizontal} ${vertical}`;
  const f = (value) => value.toFixed(2);
  return `미네 얼굴: ${where} (가로 ${f(x1)}~${f(x2)}, 세로 ${f(y1)}~${f(y2)}, 사진 전체 0~1 기준)`;
}
