#!/usr/bin/env node
// 아르고스 이벤트 → 기존 위치·소비 데이터셋 전달(전환 준비, 요청 `아르고스 수신부 재설계` 2단계 2·3번).
// 기본은 미리보기(읽기 전용): 새로 들어갈 건수와 이미 있는 건수만 센다.
// --apply는 전환 때만 쓴다. 병행 기간에 소비를 넘기면 알림 앱과 아르고스가 같은 결제를 두 번 넣어
// 지출이 이중 집계된다(두 경로가 같은 출처 이름을 쓰므로 파서의 출처 간 병합으로 걸러지지 않는다).
//   node scripts/tools/argos-forward.mjs --date=2026-10-28 [--days=7] [--kinds=location,spending] [--apply]
// 6번(닫히지 않은 체류)은 지금 체류 이벤트를 읽는 곳이 없어(동선은 점으로 계산) 이 도구 범위 밖이다.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocationStore } from '../jobs/owntracks-receiver.mjs';
import { locationPointsFromEvents, spendingRecordsFromEvents } from '../lib/argos-forward.mjs';
import { readDailySpending, spendingRawPath, spendingSummaryPath } from '../lib/spending-daily.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
}) : []);

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function readEvents(date, root = VAULT_PATHS.root) {
  return readJsonl(join(root, VAULT_REL.argosEvents, date.slice(0, 4), `${date}.jsonl`));
}

function locationTimestamps(date, root) {
  return new Set(readJsonl(join(root, VAULT_REL.location, date.slice(0, 4), `${date}.jsonl`)).map((point) => point.tst));
}

// 지출 원문에 id 기준으로 붙이고(같은 id는 건너뜀), 바뀐 날의 파생 요약을 다시 만든다(수집 잡과 같은 잠금 순서).
async function appendSpending(records, spendingDir) {
  const changed = new Set();
  let written = 0;
  for (const record of records) {
    const date = record.ts.slice(0, 10);
    const path = spendingRawPath(date, spendingDir);
    mkdirSync(join(spendingDir, date.slice(0, 4)), { recursive: true });
    const added = await withLock(path, () => {
      if (readJsonl(path).some((existing) => existing.id === record.id)) return false;
      const needsNewline = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n');
      appendFileSync(path, `${needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`, 'utf8');
      return true;
    });
    if (added) { written += 1; changed.add(date); }
  }
  for (const date of changed) {
    const summaryPath = spendingSummaryPath(date, spendingDir);
    await withLock(spendingRawPath(date, spendingDir), () => withLock(summaryPath, () => {
      const content = `${JSON.stringify(readDailySpending(date, { spendingDir }), null, 2)}\n`;
      if (!existsSync(summaryPath) || readFileSync(summaryPath, 'utf8') !== content) writeAtomic(summaryPath, content);
    }));
  }
  return written;
}

export async function forwardArgos({ date, days = 1, kinds = ['location', 'spending'], apply = false,
  root = VAULT_PATHS.root, spendingDir = VAULT_PATHS.spending, store = createLocationStore({ root }) }) {
  const result = { location: { events: 0, fresh: 0, existing: 0, written: 0 },
    spending: { events: 0, fresh: 0, existing: 0, written: 0 } };
  const dates = Array.from({ length: days }, (_, index) => shiftDate(date, -index)).reverse();
  for (const day of dates) {
    const events = readEvents(day, root);
    if (kinds.includes('location')) {
      const points = locationPointsFromEvents(events);
      const known = locationTimestamps(day, root);
      const fresh = points.filter((point) => !known.has(point.tst));
      Object.assign(result.location, { events: result.location.events + points.length,
        fresh: result.location.fresh + fresh.length, existing: result.location.existing + points.length - fresh.length });
      // 같은 tst는 저장 함수가 다시 확인해 거른다(이벤트 날짜와 점 날짜가 자정 근처에서 다를 수 있다).
      if (apply) for (const point of fresh) if (store(point)) result.location.written += 1;
    }
    if (kinds.includes('spending')) {
      const records = spendingRecordsFromEvents(events);
      const ids = new Set(records.flatMap((record) => readJsonl(spendingRawPath(record.ts.slice(0, 10), spendingDir))
        .map((existing) => existing.id)));
      const fresh = records.filter((record) => !ids.has(record.id));
      Object.assign(result.spending, { events: result.spending.events + records.length,
        fresh: result.spending.fresh + fresh.length, existing: result.spending.existing + records.length - fresh.length });
      if (apply) result.spending.written += await appendSpending(fresh, spendingDir);
    }
  }
  return result;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? true]));
  const date = args.date ?? new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date=YYYY-MM-DD');
  const days = Number(args.days ?? 1);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days는 1~31');
  const kinds = String(args.kinds ?? 'location,spending').split(',');
  if (kinds.some((kind) => !['location', 'spending'].includes(kind))) throw new Error('--kinds는 location,spending 중에서');
  const result = await forwardArgos({ date, days, kinds, apply: args.apply === true });
  console.log(`[argos-forward] ${date} ${days}일 ${args.apply === true ? '적용' : '미리보기'}`);
  for (const kind of kinds) {
    const r = result[kind];
    console.log(`  ${kind}: 이벤트 ${r.events} · 새로 ${r.fresh} · 이미 있음 ${r.existing}${args.apply === true ? ` · 씀 ${r.written}` : ''}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error('[argos-forward] 실패:', error.message); process.exitCode = 1; });
}
