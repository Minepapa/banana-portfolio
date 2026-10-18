// 영상·소리 캐시만으로 재생 시작점을 고른다. 전사·목소리 구간은 나중에 선택 입력으로 받는다.
export const HIGHLIGHT_RULES = Object.freeze({
  shortVideoSec: 10, binSec: 2, minSec: 3, maxSec: 20, maxSegments: 3,
  activeScore: 0.55, faceScore: 5, faceRadiusSec: 1.5,
  tagWeights: Object.freeze({ laughter: 2.3, crying: 2.2, singing: 1.9,
    shouting: 1.8, speech: 0.7 }),
  tagFloor: 0.25, loudRatio: 1.7, loudScore: 0.9,
  highPitchRatio: 1.4, highPitchScore: 0.8,
  transcriptScore: 0.4, mineVoiceScore: 1.5,
});

const round = (value) => Math.round(value * 100) / 100;
const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const overlap = (leftStart, leftEnd, rightStart, rightEnd) =>
  Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));

export function scoreWindows(durationSec, { faces = [], cues = [], transcripts = [], mineVoice = [] } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('영상 길이 오류');
  const rules = HIGHLIGHT_RULES;
  const rmsBase = median(cues.map((cue) => cue.rms));
  const pitchBase = median(cues.map((cue) => cue.pitch));
  const bins = [];
  for (let start = 0; start < durationSec; start += rules.binSec) {
    const end = Math.min(durationSec, start + rules.binSec);
    const evidence = new Map();
    const add = (tag, score) => evidence.set(tag, Math.max(evidence.get(tag) ?? 0, score));
    for (const face of faces) {
      if (!face?.people?.includes('미네') || !Number.isFinite(face.second)) continue;
      if (overlap(start, end, face.second - rules.faceRadiusSec,
        face.second + rules.faceRadiusSec)) add('미네 얼굴', rules.faceScore);
    }
    for (const cue of cues) {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)
        || !overlap(start, end, cue.start, cue.end)) continue;
      for (const [tag, weight] of Object.entries(rules.tagWeights)) {
        const confidence = Number(cue.tags?.[tag] ?? 0);
        if (confidence >= rules.tagFloor) add(({ laughter: '웃음', crying: '울음',
          singing: '노래', shouting: '소리 지름', speech: '말소리' })[tag], confidence * weight);
      }
      if (rmsBase && cue.rms >= rmsBase * rules.loudRatio) add('커진 소리', rules.loudScore);
      if (pitchBase && cue.pitch >= pitchBase * rules.highPitchRatio) add('높아진 목소리', rules.highPitchScore);
    }
    for (const part of transcripts) {
      if (Number.isFinite(part.start) && Number.isFinite(part.end)
        && overlap(start, end, part.start, part.end) && part.text?.trim()) add('말소리', rules.transcriptScore);
    }
    for (const part of mineVoice) {
      if (Number.isFinite(part.start) && Number.isFinite(part.end)
        && overlap(start, end, part.start, part.end)) add('미네 목소리', rules.mineVoiceScore);
    }
    bins.push({ start, end, score: round([...evidence.values()].reduce((sum, value) => sum + value, 0)),
      evidence: [...evidence.keys()] });
  }
  return bins;
}

export function mergeHighlightWindows(windows, durationSec) {
  const rules = HIGHLIGHT_RULES;
  const groups = [];
  let current = null;
  for (const window of windows) {
    if (window.score < rules.activeScore) {
      if (current) groups.push(current);
      current = null;
      continue;
    }
    if (!current || window.start > current.end || window.end - current.start > rules.maxSec) {
      if (current) groups.push(current);
      current = { start: window.start, end: window.end, windows: [window] };
    } else {
      current.end = window.end;
      current.windows.push(window);
    }
  }
  if (current) groups.push(current);
  const segments = groups.map((group) => {
    const start = Math.max(0, Math.min(group.start, durationSec - rules.minSec));
    const end = Math.min(durationSec, Math.max(group.end, start + rules.minSec));
    const evidence = [...new Set(group.windows.flatMap((window) => window.evidence))];
    return { startSec: round(start), endSec: round(end), score: round(group.windows.reduce(
      (sum, window) => sum + window.score * (window.end - window.start), 0) / (group.end - group.start)),
    evidence };
  });
  const disjoint = [];
  for (const segment of segments) {
    const previous = disjoint.at(-1);
    if (!previous || previous.endSec <= segment.startSec) {
      disjoint.push(segment);
    } else if (segment.endSec - previous.startSec <= rules.maxSec) {
      const previousLength = previous.endSec - previous.startSec;
      const currentLength = segment.endSec - segment.startSec;
      previous.score = round((previous.score * previousLength + segment.score * currentLength)
        / (previousLength + currentLength));
      previous.endSec = segment.endSec;
      previous.evidence = [...new Set([...previous.evidence, ...segment.evidence])];
    } else {
      // 마지막 1~2초를 최소 길이로 늘리면 앞 구간과 겹친다. 앞 구간의 끝을 당긴다.
      const boundary = Math.min(previous.endSec, segment.endSec - rules.minSec);
      previous.endSec = boundary;
      segment.startSec = boundary;
      disjoint.push(segment);
    }
  }
  return disjoint;
}

export function selectHighlights(segments, windows, durationSec) {
  const rules = HIGHLIGHT_RULES;
  if (durationSec < rules.shortVideoSec) {
    const evidence = [...new Set(windows.flatMap((window) => window.evidence))];
    return [{ startSec: 0, endSec: round(durationSec),
      score: round(windows.reduce((sum, window) => sum + window.score, 0) / (windows.length || 1)),
      evidence: evidence.length ? evidence : ['짧은 영상'] }];
  }
  const candidates = segments.length ? segments : [{ startSec: 0, endSec: rules.minSec,
    score: 0, evidence: ['소리·얼굴 근거 없음'] }];
  const selected = [];
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score || left.startSec - right.startSec)) {
    if (selected.length === rules.maxSegments) break;
    if (selected.some((part) => overlap(part.startSec, part.endSec, candidate.startSec, candidate.endSec))) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.startSec - right.startSec);
}

export function videoHighlights(match, cues = null, options = {}) {
  const durationSec = Number(match.durationSec || cues?.durationSec);
  const faces = match.framePeople?.length ? match.framePeople
    : match.people?.includes('미네') && Number.isFinite(match.representatives?.미네?.timestampSec)
      ? [{ second: match.representatives.미네.timestampSec, people: ['미네'] }] : [];
  const windows = scoreWindows(durationSec, { faces, cues: cues?.windows ?? [],
    transcripts: options.transcripts ?? [], mineVoice: options.mineVoice ?? [] });
  return selectHighlights(mergeHighlightWindows(windows, durationSec), windows, durationSec);
}
