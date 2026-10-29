#!/usr/bin/env node
// 장소별 소비 파생 파일(`95_Etna/Spending/Places`)을 지난날 원문(위치·지출 JSONL)에서 다시 만든다.
// 데일리 노트 잡은 확정·재계산 때만 쓰므로, 도입(2026-10-29) 전 날짜는 이 도구로 채운다.
// - 기본은 미리보기: 카카오 조회 없이(등록 장소만 이름이 붙음) 날짜별 연결 결과만 출력하고 쓰지 않는다.
// - --apply: 데일리와 같은 지오코더(캐시 우선)로 계산해 파일을 쓴다. 카카오 조회가 실패한 날은 쓰지 않는다.
// - 데일리 노트·원문은 건드리지 않는다. 일정은 넘기지 않는다(장소 이름에는 영향 없음).
// 사용: node scripts/tools/spending-places-backfill.mjs --from=2026-10-10 --to=2026-10-28 [--apply]
import { fileURLToPath } from 'node:url';
import { computeRoute, readRoutePoints, readRoutePayments, kstDate } from '../jobs/daily-note.mjs';
import { linkPaymentsToRoute, writeSpendingPlaces } from '../lib/spending-places.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function datesBetween(from, to) {
  const dates = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

export async function backfill({ from, to, apply = false, today = kstDate(new Date()),
  deps = { computeRoute, readRoutePoints, readRoutePayments, writeSpendingPlaces } }) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new Error('--from·--to는 YYYY-MM-DD, from <= to');
  if (to >= today) throw new Error('오늘 이후는 채우지 않는다(동선이 아직 확정되지 않음)');
  const results = [];
  for (const date of datesBetween(from, to)) {
    // 지출이 없는 날도 데일리 잡처럼 빈 파일을 쓴다(월간 '기록 일수'의 뜻을 두 경로에서 같게).
    const payments = deps.readRoutePayments(date);
    const route = await deps.computeRoute(date, { dryRun: !apply, points: deps.readRoutePoints(date), payments, events: [] });
    if (!route.length) { results.push({ date, skipped: '동선 없음' }); continue; }
    if (route.degraded) { results.push({ date, skipped: '카카오 조회 실패' }); continue; }
    const linked = linkPaymentsToRoute(route, payments, { date });
    const written = apply ? deps.writeSpendingPlaces({ date, route, payments }) : null;
    results.push({ date, linked, written });
  }
  return results;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('='))
    .map(([key, value]) => [key, value ?? true]));
  const results = await backfill({ from: args.from, to: args.to, apply: args.apply === true });
  for (const result of results) {
    if (result.skipped) { console.log(`${result.date} 건너뜀: ${result.skipped}`); continue; }
    const where = result.linked.map((payment) => `${payment.place} ${payment.amount.toLocaleString('ko-KR')}원`).join(' · ');
    console.log(`${result.date} ${args.apply ? (result.written ? '씀' : '변경 없음') : '미리보기'}: ${where}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error('장소별 소비 채우기 실패:', error.message); process.exitCode = 1; });
}
