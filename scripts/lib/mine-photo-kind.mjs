/**
 * 미네 사진 종류(기억 판단 체계 §16.2, 2026-11-01 오너 "사진 감정은 로컬 이미지 모델, 종류부터 코드로").
 *
 * 왜: 2026-10-30 사진 기준 예시 6개 시험에서 프롬프트에 "가려지거나 멀면 모름" 줄을 넣어도 로컬 이미지 모델(qwen3-vl 8B)의
 * 답이 하나도 바뀌지 않았다(6개 모두 기쁨 2 — 마스크 #33·멀리 작은 얼굴 #38 포함). 그래서 표정을 읽을 수 있는 사진인지는
 * 모델에 묻지 않고, 얼굴 인식 결과(Media/Faces — 세운 원본 픽셀 기준 상자·검출 점수·흐림)로 코드가 가른다.
 *
 * 종류:
 *   - 얼굴 가까이 — 표정으로 감정을 읽는다(지금 프롬프트와 같음).
 *   - 여럿이 함께 — 미네 얼굴과 비슷한 크기의 얼굴이 여럿. 표정보다 무슨 자리인가(행사·참여).
 *   - 멀리서 — 미네 얼굴이 사진에서 작다. 장면·활동·분위기.
 *   - 가려짐 — 미네 얼굴을 찾지 못함(뒷모습·가려짐·얼굴 인식 안 됨). 감정은 코드가 '모름'으로 둔다.
 *
 * 마스크는 상자·검출 점수로 가르지 못한다(2026-11-01 실측: 마스크 #33 검출 점수 0.848, 맨얼굴 기준 예시 0.741~0.912).
 * 그래서 마스크 얼굴은 크기에 따라 '얼굴 가까이'나 '멀리서'가 된다 — 프롬프트의 종류별 안내가 가려진 얼굴을 다루고,
 * 오너 검수 표본으로 다시 본다(문턱 근거와 분포: scripts/tools/mine-photo-kind-measure.mjs 보고서).
 *
 * 순서: 가려짐(미네 얼굴 없음) → 여럿이 함께 → 멀리서 → 얼굴 가까이. 단체 사진은 얼굴이 작아도 '무슨 자리인가'가 먼저다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { MEDIA_FACES_PATHS } from './vault-paths.mjs';

export const PHOTO_KINDS = Object.freeze({ close: '얼굴 가까이', group: '여럿이 함께', far: '멀리서', hidden: '가려짐' });

// 문턱(2026-11-01 실측, 사진 구슬 후보 558순간의 대표 사진 1,205장 + 기준 예시 사진 6장).
// - copyFacePx: 모델이 실제로 보는 사본(긴 변 768px)에서 미네 얼굴 짧은 변의 픽셀 수. 오너가 '표정을 읽을 수 없음'으로
//   답한 #38은 32px, 표정으로 답한 다섯 장은 204~285px — 오너 정답으로는 32~204 사이 어디인지 정할 수 없다.
//   그래서 표정 인식 자료의 관례적 얼굴 크기(48×48px)를 잠정 문턱으로 둔다. 미네 얼굴이 보이는 1,087장 가운데
//   48px 미만이 약 30%다. 오너 검수 표본(px 구간별 '표정이 읽히나')으로 다시 정할 값이다.
// - 여럿이 함께: 미네 얼굴 짧은 변의 절반 이상인 얼굴이 미네 포함 3개 이상. 아빠와 셀카(#37, 얼굴 2개)는 오너가
//   표정으로 답했으므로 2개는 '여럿'이 아니다. 1,087장 중 3개 이상 123장(약 11%).
// - 검출 점수·흐림은 문턱으로 쓰지 않는다: 마스크 #33의 검출 0.848은 맨얼굴 예시(0.741~0.912) 안이고,
//   흐림을 가를 오너 정답이 없다. 보고서에는 수치를 남긴다.
export const PHOTO_KIND_RULES = Object.freeze({
  copyLongSide: 768,
  farCopyFacePx: 48,
  groupMinFaces: 3,
  groupFaceRatio: 0.5,
});

// 사진 하나의 얼굴 색인 행(faces 전부) + 미네 얼굴 번호 + 세운 원본 크기 → 판단에 쓰는 수치.
export function photoKindMetrics({ faces = [], mineIndex, size }, rules = PHOTO_KIND_RULES) {
  const validBox = (face) => Array.isArray(face?.bbox) && face.bbox.length === 4 && face.bbox.every(Number.isFinite);
  const mine = Number.isInteger(mineIndex) ? faces.find((face) => face.i === mineIndex) : undefined;
  if (!validBox(mine)) return { faceCount: faces.length, mineFound: false };
  // 미네 얼굴은 있는데 사진 크기를 모르면 비율을 잴 수 없다 — 가려짐이 아니라 '종류 모름'(photoKind가 null).
  if (!(size?.width > 0 && size?.height > 0)) return { faceCount: faces.length, mineFound: true, sizeMissing: true };
  const side = (face) => Math.max(0, Math.min(face.bbox[2] - face.bbox[0], face.bbox[3] - face.bbox[1]));
  const mineSide = side(mine);
  const scale = rules.copyLongSide / Math.max(size.width, size.height);
  const comparable = faces.filter((face) => validBox(face) && side(face) >= mineSide * rules.groupFaceRatio).length;
  return {
    faceCount: faces.length, mineFound: true, comparableFaces: comparable,
    mineWidthRatio: (mine.bbox[2] - mine.bbox[0]) / size.width, mineHeightRatio: (mine.bbox[3] - mine.bbox[1]) / size.height,
    copyFacePx: mineSide * scale, det: Number(mine.det), blur: Number(mine.blur),
  };
}

// 사진 종류 하나와 그 이유. analyzed = 얼굴 색인에 이 사진이 있는가(없으면 아직 얼굴 분석 전이라 종류를 정하지 않는다 → null).
// 미네 얼굴은 있는데 사진 크기를 모를 때도 null — 모름 강제(가려짐)로 떨어지지 않고 모델에 맡긴다.
export function photoKind({ analyzed = true, faces, mineIndex, size }, rules = PHOTO_KIND_RULES) {
  if (!analyzed) return null;
  const metrics = photoKindMetrics({ faces, mineIndex, size }, rules);
  if (metrics.sizeMissing) return null;
  if (!metrics.mineFound) {
    return { kind: PHOTO_KINDS.hidden, metrics,
      reason: metrics.faceCount ? '사진에 얼굴은 있으나 미네 얼굴로 확인된 것이 없음' : '사진에서 얼굴을 찾지 못함' };
  }
  if (metrics.comparableFaces >= rules.groupMinFaces) {
    return { kind: PHOTO_KINDS.group, metrics, reason: `미네 얼굴과 비슷한 크기의 얼굴 ${metrics.comparableFaces}개` };
  }
  if (metrics.copyFacePx < rules.farCopyFacePx) {
    return { kind: PHOTO_KINDS.far, metrics, reason: `미네 얼굴이 작음(사본에서 ${Math.round(metrics.copyFacePx)}px)` };
  }
  return { kind: PHOTO_KINDS.close, metrics, reason: `미네 얼굴이 크게 보임(사본에서 ${Math.round(metrics.copyFacePx)}px)` };
}

// 순간(사진 최대 3장)의 종류들 → 감정을 코드가 '모름'으로 정하는가. 표정을 읽을 사진이 한 장도 없을 때만(모두 가려짐).
// 종류를 모르는 사진(얼굴 분석 전)이 하나라도 있으면 모델에 맡긴다.
export function momentForcesUnknown(kinds) {
  return kinds.length > 0 && kinds.every((entry) => entry?.kind === PHOTO_KINDS.hidden);
}

// 얼굴 색인(faces-index.jsonl)에서 사진마다 얼굴 전부. 색인에 있는 사진 = 얼굴 분석을 마친 사진(얼굴 0개여도 있음).
export function loadPhotoFaces({ indexPath = MEDIA_FACES_PATHS.index, ids } = {}) {
  const wanted = ids ? new Set(ids) : null;
  const found = new Map();
  if (!existsSync(indexPath)) return found;
  // 끝 줄이 덜 쓰였으면(추가 중) 버린다 — loadMineFaces와 같은 규칙.
  for (const line of readFileSync(indexPath, 'utf8').split('\n').slice(0, -1)) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.error || (wanted && !wanted.has(entry.id))) continue;
    found.set(entry.id, Array.isArray(entry.faces) ? entry.faces : []);
  }
  return found;
}
