// 이름 확인 도구와 야간 전사가 같은 녹음 노트 제목을 계산한다.
export function cleanRecordingTitle(value) {
  return String(value).normalize('NFC').replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D/gu, '')
    .replace(/[\\/:*?"<>|\x00-\x1f#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function recordingNoteTitle(stem) {
  if (!/^\d{4}-\d{2}-\d{2} \S/.test(stem)) throw new Error('날짜 접두 녹음 이름 필요');
  const suffix = ' 녹음';
  let prefix = '';
  for (const character of cleanRecordingTitle(stem)) {
    if ([...prefix].length >= 70 || Buffer.byteLength(`${prefix}${character}${suffix}.md`) > 255) break;
    prefix += character;
  }
  return `${prefix.trimEnd()}${suffix}`;
}
