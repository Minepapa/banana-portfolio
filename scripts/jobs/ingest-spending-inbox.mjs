#!/usr/bin/env node
// spendingInbox 알림 원문을 날짜별 JSONL로 보관한다. 파싱과 발송은 후속 단계의 몫이다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { getFirestoreAdmin } from '../lib/firestore-admin.mjs';
import { readSpendingInbox, deleteSpendingInboxDocs } from '../lib/spending-inbox.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { spendingRawPath, spendingSummaryPath, writeSpendingSummary } from '../lib/spending-daily.mjs';
import { enrichmentMtime, loadEnrichment, ENRICHMENT_VERSION } from '../lib/spending-enrich.mjs';

const FILE_OPS = { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync };
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const MAX_SUMMARY_RECOVERIES = 16;

// 요약은 원문 + 소비 설정 + 뱅크샐러드 분류에서 나온다. 설정·분류가 요약보다 새롭거나 요약의 보강 판이 낮으면
// 그날 요약도 다시 계산한다(고정비·카드 표를 고치면 지난날 화면 칸도 따라 바뀌게, 2026-11-01).
function summaryVersion(summaryPath) {
  try { return JSON.parse(readFileSync(summaryPath, 'utf8')).enrichmentVersion ?? 0; }
  catch { return 0; }
}

function summariesNeedingRecovery(spendingDir, changedDates) {
  if (!existsSync(spendingDir)) return [];
  const dependsOn = enrichmentMtime(spendingDir);
  const candidates = [];
  for (const year of readdirSync(spendingDir, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    const yearDir = join(spendingDir, year.name);
    for (const file of readdirSync(yearDir, { withFileTypes: true })) {
      if (!file.isFile() || !new RegExp(`^${year.name}-\\d{2}-\\d{2}\\.jsonl$`).test(file.name)) continue;
      const name = file.name;
      const date = name.slice(0, 10);
      if (changedDates.has(date)) continue;
      const rawPath = join(yearDir, name);
      const summaryPath = spendingSummaryPath(date, spendingDir);
      try {
        const rawMtime = statSync(rawPath).mtimeMs;
        if (!existsSync(summaryPath) || Math.max(rawMtime, dependsOn) >= statSync(summaryPath).mtimeMs
            || summaryVersion(summaryPath) < ENRICHMENT_VERSION) {
          candidates.push({ date, rawMtime });
        }
      } catch { /* A disappearing file must not block recovery of other dates. */ }
    }
  }
  if (candidates.length <= MAX_SUMMARY_RECOVERIES) return candidates.map(({ date }) => date);
  // Retry the newest failed append promptly, and rotate older backlog across scheduled runs.
  candidates.sort((a, b) => b.rawMtime - a.rawMtime || a.date.localeCompare(b.date));
  const newest = candidates.shift().date;
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  const start = Math.floor(Date.now() / (10 * 60_000)) % candidates.length;
  const rotated = candidates.slice(start).concat(candidates.slice(0, start));
  return [newest, ...rotated.slice(0, MAX_SUMMARY_RECOVERIES - 1).map(({ date }) => date)];
}

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
  const changedDates = new Set();
  let enrichmentProblems = '';

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
      changedDates.add(date);
    } catch {
      // A malformed existing file or failed write/read must leave its Firestore document intact.
      // Error messages may include raw JSONL, so only counts are logged.
      failedCount += 1;
    }
  }

  if (!dryRun) await deleteSpendingInboxDocs(db, confirmedIds);
  if (!dryRun) {
    let recoveryDates = [];
    try { recoveryDates = summariesNeedingRecovery(spendingDir, changedDates); }
    catch { failedCount += 1; }
    const summaryDates = [...changedDates, ...recoveryDates];
    let enrichment;
    // 보강 입력을 읽기 직전 시각. 요약 시각을 이것으로 맞춰, 읽은 뒤 바뀐 설정은 다음 회차가 반영한다.
    const stamp = new Date();
    if (summaryDates.length) {
      try { enrichment = loadEnrichment(spendingDir); }
      catch { enrichment = undefined; failedCount += 1; }
      if (enrichment?.problems.length) enrichmentProblems = enrichment.problems.join(',');
    }
    for (const date of summaryDates) {
      try {
        // Keep the raw snapshot stable until its summary is committed. An overlapping append
        // must happen afterward, so its raw mtime remains newer if that run then fails.
        await writeSpendingSummary(date, { spendingDir, enrichment, stamp });
      } catch {
        // 원문은 이미 검증했다. 파생 요약 오류는 원문 수집·삭제를 되돌리지 않는다.
        failedCount += 1;
      }
    }
  }
  logger.log(`[ingest-spending-inbox] read=${documents.length} planned=${plannedCount} duplicate=${duplicateCount} invalid=${invalidCount} failed=${failedCount} deleted=${dryRun ? 0 : confirmedIds.length} dryRun=${dryRun}${enrichmentProblems ? ` enrichmentProblems=${enrichmentProblems}` : ''}`);
  return { read: documents.length, planned: plannedCount, duplicate: duplicateCount,
    invalid: invalidCount, failed: failedCount, deleted: dryRun ? 0 : confirmedIds.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  ingestSpendingInbox({ db: getFirestoreAdmin(), dryRun: process.argv.includes('--dry-run') })
    // 일부 실패(failed>0)도 잡 실패로 남겨 하트비트·실패 경보가 보게 한다(2026-11-03, 예전엔 exit 0).
    .then((result) => { if (result.failed > 0) process.exitCode = 1; })
    .catch(() => { console.error('[ingest-spending-inbox] failed=1'); process.exitCode = 1; });
}
