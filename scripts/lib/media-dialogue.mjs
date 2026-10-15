// 전사 잡과 화자 분리 잡이 같은 발화 묶기 규칙을 쓴다.
// 음성 없음·반복 환각 전사는 대화 형식으로 바꾸지 않는다 — 두 잡 모두 평문(줄임) 표시로 돌아간다.
export function splitDialogueParts(segments = []) {
  return segments.flatMap((segment, i) => {
    const text = String(segment.text || '');
    const texts = text.replace(/(?:^|\s)-(?=\s|$)/gu, '\n').split('\n')
      .map((part) => part.trim()).filter(Boolean);
    const weights = texts.map((part) => [...part.replace(/\s*\[\?\]\s*/gu, '').trim()].length);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    return texts.map((part, k) => {
      const start = Number(segment.start) || 0;
      const duration = Math.max(0, (Number(segment.end) || 0) - start);
      const partStart = start + Math.round(duration * elapsed / (total || 1));
      elapsed += weights[k];
      const end = k === texts.length - 1 ? start + duration
        : start + Math.round(duration * elapsed / (total || 1));
      return { i, k, start: partStart, end, text: part };
    });
  });
}

function normalizedSentence(text) {
  return String(text).replace(/\[\?\]/gu, '').replace(/(?:^|\s)-\s+/gu, ' ')
    .replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase();
}

function isBackchannel(text) {
  const normalized = normalizedSentence(text);
  return normalized.length > 0 && normalized.length <= 4
    && /^(?:응+|어+|네+|예+|음+|아+|맞아|그래|그치|으응|응응)$/u.test(normalized);
}

function sentenceParts(text) {
  return (String(text).match(/[^.!?~]+[.!?~]+|[^.!?~]+$/gu) || [])
    .map((sentence) => ({ text: sentence.trim() })).filter((sentence) => sentence.text);
}

// 반복 문장 사이에는 짧은 맞장구만 허용한다. 세 번째 반복이 확인되기 전에는 아무것도 줄이지 않는다.
export function collapseRepeatedParts(parts) {
  const removed = new Set();
  const markers = new Map();
  for (let index = 0; index < parts.length; index += 1) {
    if (removed.has(index)) continue;
    const key = normalizedSentence(parts[index].text);
    if (key.length < 8) continue;
    const matches = [index];
    for (let cursor = index + 1; cursor < parts.length; cursor += 1) {
      if (isBackchannel(parts[cursor].text)) continue;
      if (normalizedSentence(parts[cursor].text) !== key) break;
      matches.push(cursor);
    }
    if (matches.length < 3) continue;
    markers.set(index, `(같은 문장 ${matches.length}회 반복 — 전사 오류로 줄임)`);
    for (let match = 1; match < matches.length; match += 1) {
      const previous = matches[match - 1];
      const current = matches[match];
      removed.add(current);
      for (let cursor = previous + 1; cursor < current; cursor += 1) {
        if (isBackchannel(parts[cursor].text)) removed.add(cursor);
      }
    }
    const last = matches.at(-1);
    let next = last + 1;
    while (next < parts.length && isBackchannel(parts[next].text)) next += 1;
    if (next < parts.length) {
      for (let cursor = last + 1; cursor < next; cursor += 1) removed.add(cursor);
    }
  }
  const result = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (removed.has(index)) continue;
    result.push(parts[index]);
    if (markers.has(index)) result.push({ ...parts[index], text: markers.get(index) });
  }
  return result;
}

export function shortenSegmentRepetition(text, segments) {
  if (!segments?.length) return text;
  const parts = sentenceParts(splitDialogueParts(segments).map((part) => part.text).join(' '));
  const collapsed = collapseRepeatedParts(parts);
  if (collapsed.length === parts.length) return text;
  return collapsed.map((part) => part.text).join(' ');
}

function turnScore(part, turns) {
  const scores = Object.fromEntries([...new Set(turns.map((turn) => turn.speaker))]
    .filter((speaker) => /^S[0-2]$/.test(speaker)).map((speaker) => [speaker, 0]));
  for (const turn of turns) {
    if (!(turn.speaker in scores)) continue;
    scores[turn.speaker] += Math.max(0, Math.min(part.end, turn.end) - Math.max(part.start, turn.start));
  }
  const speaker = Object.keys(scores).sort((a, b) => scores[b] - scores[a] || a.localeCompare(b))[0] || 'S0';
  return { speaker, uncertain: part.end <= part.start
    || scores[speaker] < (part.end - part.start) * 0.5 };
}

export function speakerParts(transcript, speakers, ownerTurnSpeaker) {
  if (!Array.isArray(transcript.segments)) return [];
  const pieces = splitDialogueParts(transcript.segments);
  if (pieces.length === transcript.segments.length) return [];
  const assignments = new Map(speakers.segments.map((part) => [part.i, part]));
  if (speakers.kind === 'Recordings') return pieces.map((part) => {
    const original = assignments.get(part.i);
    if (!original) return null;
    const scored = speakers.turns?.length ? turnScore(part, speakers.turns) : null;
    return { i: part.i, k: part.k, speaker: scored?.speaker || original.speaker,
      uncertain: scored?.uncertain ?? original.uncertain };
  }).filter(Boolean);
  let ownerSpeaker = ownerTurnSpeaker;
  if (!ownerSpeaker && speakers.turns?.length) {
    const votes = { S0: 0, S1: 0 };
    for (const [i, segment] of transcript.segments.entries()) {
      const assignment = assignments.get(i);
      if (!assignment) continue;
      const matched = turnScore(segment, speakers.turns).speaker;
      votes[matched] += assignment.speaker === 'owner' ? 1 : -1;
    }
    ownerSpeaker = votes.S1 > votes.S0 ? 'S1' : 'S0';
  }
  return pieces.map((part) => {
    const original = assignments.get(part.i);
    if (!original) return null;
    if (!speakers.turns?.length) return { i: part.i, k: part.k,
      speaker: original.speaker, uncertain: original.uncertain };
    const scored = turnScore(part, speakers.turns);
    return { i: part.i, k: part.k, speaker: scored.speaker === ownerSpeaker ? 'owner' : 'other',
      uncertain: scored.uncertain };
  }).filter(Boolean);
}

export function renderDialogue(transcript, speakers, counterpart = '상대', { looped = false } = {}) {
  if (!transcript?.speech || looped) return null;
  if (!speakers?.segments?.length || speakers.transcribedAt !== transcript.transcribedAt) return null;
  const lines = [];
  const inferredParts = speakers.parts?.length ? speakers.parts : speakerParts(transcript, speakers);
  const assignments = inferredParts.length ? inferredParts : speakers.segments;
  const split = new Map(splitDialogueParts(transcript.segments)
    .map((part) => [`${part.i}:${part.k}`, part]));
  const recording = speakers.kind === 'Recordings';
  if (recording && new Set(Object.values(speakers.labels || {})).size < 2) return null;
  const entries = assignments.map((assignment) => {
    const part = split.get(`${assignment.i}:${assignment.k ?? 0}`);
    return part && { ...assignment, text: part.text.replace(/\[\?\]/gu, '').trim() };
  }).filter((part) => part?.text && (recording ? Boolean(speakers.labels?.[part.speaker])
    : ['owner', 'other'].includes(part.speaker)));
  for (const assignment of entries) {
    const label = recording ? speakers.labels[assignment.speaker]
      : assignment.speaker === 'owner' ? '나' : counterpart || '상대';
    const text = assignment.text;
    const previous = lines.at(-1);
    if (previous?.label === label) previous.parts.push(text);
    else lines.push({ label, parts: [text] });
  }
  return lines.length ? `${speakers.check ? '[화자 확인 필요]\n' : ''}${lines.map(({ label, parts }) =>
    `${label}: ${collapseRepeatedParts(sentenceParts(parts.join(' '))).map((part) => part.text).join(' ')}`).join('\n')}` : null;
}

export function counterpartFromNote(frontmatter, fallback) {
  const people = Array.isArray(frontmatter.people) ? frontmatter.people : [frontmatter.people];
  const named = people.map((entry) => String(entry || '').match(/\[\[(?:[^|\]]*\/)?([^/|\]]+)(?:\|[^\]]+)?\]\]/)?.[1])
    .find((name) => name && name !== '나');
  return named || fallback || '상대';
}
