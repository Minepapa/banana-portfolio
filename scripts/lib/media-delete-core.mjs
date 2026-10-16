// 미디어 삭제 판정 기준 §2·§3·§5: 이 모듈은 표시와 리포트만 만든다.
import { extname } from 'node:path';

export const SHORT_VIDEO_SECONDS = 3; // 결정 §3; 결정 문서와 대조 테스트로 고정.
const VIDEO = new Set(['.mov', '.mp4']);
const PHOTO = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png']);
const FAMILY = /미네|휘영|정영호|\b201\b|\b202\b|가족/;
const EVENT = /사건|기념일|생일|돌잔치|결혼|졸업|입학/;

export function mediaKind(record) {
  const suffix = extname(record.importPath || record.archivePath || '').toLowerCase();
  if (VIDEO.has(suffix)) return 'video';
  if (PHOTO.has(suffix)) return 'photo';
  return null;
}

export function chooseRepresentative(items) {
  // §5: 없는 측정값은 최하위. 동률은 촬영 시각, 그다음 id로 결정한다.
  const score = (item) => [item.mineFaceScore, item.faceSize, item.faceFront,
    item.eyesOpen, item.quality?.sharpness, item.athenaStrength,
    item.importance ?? item.vision?.aesthetic, item.resolution, item.record.size];
  return [...items].sort((a, b) => {
    const left = score(a), right = score(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (Number(right[index]) || 0) - (Number(left[index]) || 0);
      if (delta) return delta;
    }
    return String(a.record.capturedAt || '').localeCompare(String(b.record.capturedAt || ''))
      || a.record.id.localeCompare(b.record.id);
  })[0];
}

export function exclusionReasons(item, context = {}) {
  // §2: 어느 하나라도 해당하면 후보에서 제외한다. 불확실한 입력은 확인 전까지 제외한다.
  const { record, vision, quality, face = {}, note = {} } = item;
  const reasons = [];
  const people = [...(face.people || []), ...(face.hold || [])];
  const noteText = [note.category, note.people, note.album, record.album, record.importPath].flat().join(' ');
  // 얼굴 판정에 이름이 하나라도 있으면(미네·휘영·나 등 신원이 판정된 사람) 이름과 무관하게 제외한다(리뷰 HIGH: '나' 누락).
  if (people.length || FAMILY.test(noteText)) reasons.push('미네·가족 얼굴·앨범·분류');
  const candidate = note.coreMemoryCandidate;
  if (note.coreMemory || candidate === true || candidate === 'true' || candidate?.value === true
    || /핵심 기억/.test(String(note.description || ''))) reasons.push('핵심 기억');
  if (EVENT.test([note.description, note.title, note.occasion, note.album, record.album, record.importPath].join(' '))) reasons.push('사건·기념일');
  if (note.memos?.length || note.ownerMemo) reasons.push('오너 메모');
  if (note.recording || note.call || !mediaKind(record)) reasons.push('녹음·통화 또는 비대상 형식');
  if (!vision || vision.error || !quality || quality.error) reasons.push('분석 누락');
  if (vision?.faces > 0 && item.groupHasFace) reasons.push('얼굴이 있는 연사');
  // 누구인지 모르는 얼굴도 친척·가족일 수 있어 보수적으로 제외한다(결정 §1·§2 '하나라도 걸리면 제외').
  else if (vision?.faces > 0) reasons.push('얼굴 있음(누구인지 미확인)');
  if (!record.googlePhotosBackupConfirmed) reasons.push('구글 포토 백업 미확인');
  if (note.noteMissing) reasons.push('순간 노트 확인 불가');
  if (context.sourceError) reasons.push('보호 데이터 확인 불가');
  if (record.duplicateOf?.startsWith('archive:') && item.sameInode) reasons.push('하드링크 중복');
  return reasons;
}

export function detectSignals(item) {
  // §3: 임계값은 보수적인 측정용 초기값이며 표본 시트 전에는 삭제 판정으로 쓰지 않는다.
  const { record, vision = {}, quality = {} } = item;
  const labels = (vision.labels || []).map((entry) => String(entry.name || '').toLowerCase());
  const text = String(vision.text || '');
  const kind = mediaKind(record);
  const signals = [];
  if (record.duplicateOf?.startsWith('archive:') && !item.sameInode) signals.push({ type: '완전 중복', grade: 'A' });
  if (item.groupSize > 1 && !item.isRepresentative && item.groupVerified) signals.push({ type: '거의 같은 연사', grade: 'B' });
  if (kind === 'photo' && item.groupSize > 1 && !item.isRepresentative && vision.faces === 0
    && quality.sharpness < 25 && vision.aesthetic < 0.25) signals.push({ type: '흔들림·초점 실패', grade: 'C' });
  if (quality.meanBrightness < 3 && !labels.length && !text && vision.faces === 0
    && (kind === 'photo' || (quality.allFramesMeasured && quality.allFramesDark && quality.hasAudio === false)))
    signals.push({ type: '검은 화면·주머니 촬영', grade: 'A' });
  if (kind === 'photo' && (record.screenshot || labels.some((label) => /screen|app|interface/.test(label)))
    && /지도|인증|안내|map|verification|otp|code/i.test(text)
    && !/영수증|결제|receipt|payment|대화|chat|message/i.test(text))
    signals.push({ type: '일회성 스크린샷', grade: 'B' });
  if (kind === 'video' && quality.durationSec <= SHORT_VIDEO_SECONDS && quality.hasAudio === false
    && !labels.length && !text) signals.push({ type: '짧은 무의미 영상', grade: 'B' });
  if (labels.some((label) => /floor|ceiling|finger/.test(label))) signals.push({ type: '실수 촬영', grade: 'C' });
  return signals;
}

export function classify(item, context) {
  const exclusions = exclusionReasons(item, context);
  const signals = detectSignals(item);
  return { id: item.record.id, path: item.record.importPath || item.record.archivePath,
    size: item.record.size || 0, representative: item.representativeId || null,
    role: item.groupSize > 1 ? item.isRepresentative ? '대표' : '나머지' : null,
    signals, exclusions, candidates: exclusions.length ? [] : signals.filter((signal) => signal.grade !== 'C'),
    // 백업 확인 방법이 생기기 전까지 모든 원본이 '구글 포토 백업 미확인'으로 제외된다 — 그 사유만 남은 행을 따로 센다(리포트용, 후보 아님).
    pendingBackupOnly: exclusions.length === 1 && exclusions[0] === '구글 포토 백업 미확인'
      ? signals.filter((signal) => signal.grade !== 'C') : [] };
}
