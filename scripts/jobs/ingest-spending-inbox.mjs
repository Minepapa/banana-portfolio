#!/usr/bin/env node
// spendingInbox 알림 원문을 날짜별 JSONL로 보관한다. 파싱과 발송은 후속 단계의 몫이다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { getFirestoreAdmin } from '../lib/firestore-admin.mjs';
import { readSpendingInbox, deleteSpendingInboxDocs } from '../lib/spending-inbox.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const FILE_OPS = { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync };
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function dateFromKstTimestamp(ts) {
  const match = TIMESTAMP_PATTERN.exec(ts);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const utcMilliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day),
    Number(hour) - 9, Number(minute), Number(second));
  const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  // Date.UTC normalizes impossible calendar dates. Reject them instead of filing under a wrong day.
  const kstRoundTrip = new Date(utcMilliseconds + 9 * 60 * 60 * 1000).toISOString();
  if (kstRoundTrip.slice(0, 19) !== expected) return null;
  return `${year}-${month}-${day}`;
}

function existingRecords(filepath, fileOps, { repairTail = false } = {}) {
  if (!fileOps.existsSync(filepath)) return new Map();
  const content = fileOps.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  const records = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      records.set(record.id, record);
    } catch (error) {
      const incompleteTail = index === lines.length - 1 && !content.endsWith('\n');
      if (!repairTail || !incompleteTail) throw error;
      // Only an unterminated final fragment can be a crashed append. Complete lines stay untouched.
      const intactContent = content.slice(0, content.lastIndexOf('\n') + 1);
      fileOps.truncateSync(filepath, Buffer.byteLength(intactContent, 'utf8'));
      break;
    }
  }
  return records;
}

export async function ingestSpendingInbox({
  db, spendingDir = VAULT_PATHS.spending, dryRun = false, logger = console, fileOps = FILE_OPS,
}) {
  const documents = await readSpendingInbox(db);
  const confirmedIds = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  let plannedCount = 0;
  let failedCount = 0;

  for (const document of documents) {
    const date = dateFromKstTimestamp(document.ts);
    if (!date || !document.body.trim()) {
      invalidCount += 1;
      continue;
    }

    const filepath = join(spendingDir, date.slice(0, 4), `${date}.jsonl`);
    try {
      if (dryRun) {
        const persistedRecord = existingRecords(filepath, fileOps).get(document.id);
        if (persistedRecord) {
          if (JSON.stringify(persistedRecord) === JSON.stringify(document)) duplicateCount += 1;
          else failedCount += 1;
        } else {
          plannedCount += 1;
        }
        continue;
      }

      fileOps.mkdirSync(join(spendingDir, date.slice(0, 4)), { recursive: true });
      // Lock before the ID check: overlapping 10-minute runs must see each other's append.
      const outcome = await withLock(filepath, () => {
        const persistedRecord = existingRecords(filepath, fileOps, { repairTail: true }).get(document.id);
        if (persistedRecord) {
          return JSON.stringify(persistedRecord) === JSON.stringify(document) ? 'duplicate' : 'failed';
        }
        const needsNewline = fileOps.existsSync(filepath)
          && !fileOps.readFileSync(filepath, 'utf8').endsWith('\n');
        fileOps.appendFileSync(filepath, `${needsNewline ? '\n' : ''}${JSON.stringify(document)}\n`, 'utf8');
        // A successful append call alone cannot authorize deletion. Re-read the JSONL.
        const rereadRecord = existingRecords(filepath, fileOps).get(document.id);
        return JSON.stringify(rereadRecord) === JSON.stringify(document) ? 'written' : 'failed';
      });
      if (outcome === 'duplicate') {
        duplicateCount += 1;
      } else {
        plannedCount += 1;
      }
      if (outcome === 'failed') {
        failedCount += 1;
        continue;
      }
      confirmedIds.push(document.id);
    } catch {
      // A malformed existing file or failed write/read must leave its Firestore document intact.
      // Error messages may include raw JSONL, so only counts are logged.
      failedCount += 1;
    }
  }

  if (!dryRun) await deleteSpendingInboxDocs(db, confirmedIds);
  logger.log(`[ingest-spending-inbox] read=${documents.length} planned=${plannedCount} duplicate=${duplicateCount} invalid=${invalidCount} failed=${failedCount} deleted=${dryRun ? 0 : confirmedIds.length} dryRun=${dryRun}`);
  return { read: documents.length, planned: plannedCount, duplicate: duplicateCount,
    invalid: invalidCount, failed: failedCount, deleted: dryRun ? 0 : confirmedIds.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  ingestSpendingInbox({ db: getFirestoreAdmin(), dryRun: process.argv.includes('--dry-run') })
    .catch(() => { console.error('[ingest-spending-inbox] failed=1'); process.exitCode = 1; });
}
