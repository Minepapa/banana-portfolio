#!/usr/bin/env node
// 보류가 있을 때만 볼트 밖 클릭 시트를 만들고 아테나 요약을 한 번 보낸다.
// launchctl kickstart 검증은 실제 발송을 막도록 --no-send로 실행한다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { answeredVideoHolds, holdSheetMediaFaces } from './media-faces.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const SENDER_AGENT = 'athena';

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function pendingHoldCount({ root = VAULT_PATHS.root,
  videoMatchesPath = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  sheetsPath = MEDIA_FACES_PATHS.sheets } = {}) {
  const photoPath = join(root, VAULT_REL.mediaFacePeople);
  const photos = existsSync(photoPath) ? JSON.parse(readFileSync(photoPath, 'utf8')).photos ?? {} : {};
  const photoCount = Object.values(photos).filter((entry) => entry.hold?.includes('미네')).length;
  const answered = answeredVideoHolds(sheetsPath);
  const videoCount = jsonLines(videoMatchesPath)
    .reduce((sum, entry) => sum + (entry.hold ?? []).filter((person) => {
      const timestamp = entry.representatives?.[person]?.timestampSec;
      return !answered.has(`${entry.id}:${person}:${timestamp}`);
    }).length, 0);
  return photoCount + videoCount;
}

export function parseArgs(args) {
  if (args.some((arg) => arg !== '--dry-run' && arg !== '--no-send')) {
    throw new Error('지원 옵션: --dry-run, --no-send');
  }
  return { dryRun: args.includes('--dry-run'), noSend: args.includes('--no-send') };
}

export function holdMessage(count, sheets, missingFrames = 0) {
  return { agent: SENDER_AGENT, topic: '얼굴 보류함 월간 시트', kind: '정보',
    body: `보류 ${count}건 · 프레임 누락 ${missingFrames}건\n시트: ${sheets.join(', ')}` };
}

export async function runMonthly(args = [], { count = pendingHoldCount,
  create = holdSheetMediaFaces, send = sendAgentMessage, output = console,
  stateRoot = MEDIA_FACES_PATHS.root, now = new Date() } = {}) {
  const options = parseArgs(args);
  const pending = count();
  if (!pending) return { count: 0, sheets: [] };
  if (options.dryRun) {
    output.log(JSON.stringify({ dryRun: true, pending }));
    return { count: pending, sheets: [] };
  }
  const result = await create({ returnDetails: true });
  if (!result.count && !result.missingFrames) return result;
  output.log(JSON.stringify(result));
  const month = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 7);
  const sentPath = join(stateRoot, `hold-monthly-${month}.sent.json`);
  if (!options.noSend && !existsSync(sentPath)) {
    await send(holdMessage(result.count, result.sheets, result.missingFrames ?? 0));
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeAtomic(sentPath, `${JSON.stringify({ sentAt: new Date().toISOString(), sheets: result.sheets })}\n`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMonthly(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
