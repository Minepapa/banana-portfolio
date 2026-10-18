import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_FACES_PATHS } from './vault-paths.mjs';

export function loadVideoHoldAnswers(sheetsPath = MEDIA_FACES_PATHS.sheets, output = console) {
  const answers = new Map();
  if (!existsSync(sheetsPath)) return answers;
  const names = readdirSync(sheetsPath).filter((name) => /^video-hold-review-\d{4}-\d{2}\.json$/.test(name)).sort();
  for (const name of names) {
    try {
      const review = JSON.parse(readFileSync(join(sheetsPath, name), 'utf8'));
      if (!Array.isArray(review.videoAnswers)) throw new Error('videoAnswers 형식 오류');
      for (const answer of review.videoAnswers) {
        if (typeof answer.id !== 'string' || typeof answer.person !== 'string'
          || !Number.isFinite(answer.timestampSec) || typeof answer.confirmedPerson !== 'boolean') {
          throw new Error('videoAnswers 항목 형식 오류');
        }
      }
      for (const answer of review.videoAnswers) answers.set(`${answer.id}:${answer.person}`, answer);
    } catch (error) {
      (output.warn ?? output.log).call(output, `[video-hold-answers] ${name} 건너뜀: ${error.message}`);
    }
  }
  return answers;
}

export function applyVideoHoldAnswers(entry, answers) {
  const result = { ...entry };
  const hold = entry.hold ?? [];
  const applicable = hold.filter((person) => !entry.people?.includes(person) && answers.has(`${entry.id}:${person}`));
  if (!applicable.length) return result;

  result.hold = hold.filter((person) => !applicable.includes(person));
  result.people = [...(entry.people ?? [])];
  result.ownerConfirmed = { ...entry.ownerConfirmed };
  result.framePeople = (entry.framePeople ?? []).map((frame) => ({ ...frame, people: [...(frame.people ?? [])] }));
  for (const person of applicable) {
    const answer = answers.get(`${entry.id}:${person}`);
    result.ownerConfirmed[person] = answer.confirmedPerson;
    if (!answer.confirmedPerson) continue;
    if (!result.people.includes(person)) result.people.push(person);
    const second = entry.representatives?.[person]?.timestampSec;
    if (!Number.isFinite(second)) continue;
    let frame = result.framePeople.find((item) => item.second === second);
    if (!frame) {
      frame = { second, people: [] };
      result.framePeople.push(frame);
    }
    if (!frame.people.includes(person)) frame.people.push(person);
  }
  result.framePeople.sort((left, right) => left.second - right.second);
  return result;
}
