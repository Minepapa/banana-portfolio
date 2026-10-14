// 전사 잡과 화자 분리 잡이 같은 발화 묶기 규칙을 쓴다.
// 음성 없음·반복 환각 전사는 대화 형식으로 바꾸지 않는다 — 두 잡 모두 평문(줄임) 표시로 돌아간다.
export function renderDialogue(transcript, speakers, counterpart = '상대', { looped = false } = {}) {
  if (!transcript?.speech || looped) return null;
  if (!speakers?.segments?.length || speakers.transcribedAt !== transcript.transcribedAt) return null;
  const lines = [];
  for (const assignment of speakers.segments) {
    const segment = transcript.segments?.[assignment.i];
    if (!segment?.text || !['owner', 'other'].includes(assignment.speaker)) continue;
    const label = assignment.speaker === 'owner' ? '나' : counterpart || '상대';
    const text = `${segment.text.trim()}${assignment.uncertain ? ' [?]' : ''}`;
    const previous = lines.at(-1);
    if (previous?.label === label) previous.parts.push(text);
    else lines.push({ label, parts: [text] });
  }
  return lines.length ? `${speakers.check ? '[화자 확인 필요]\n' : ''}${lines.map(({ label, parts }) =>
    `${label}: ${parts.join(' ')}`).join('\n')}` : null;
}

export function counterpartFromNote(frontmatter, fallback) {
  const people = Array.isArray(frontmatter.people) ? frontmatter.people : [frontmatter.people];
  const named = people.map((entry) => String(entry || '').match(/\[\[(?:[^|\]]*\/)?([^/|\]]+)(?:\|[^\]]+)?\]\]/)?.[1])
    .find((name) => name && name !== '나');
  return named || fallback || '상대';
}
