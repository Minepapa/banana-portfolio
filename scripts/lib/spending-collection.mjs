// 하루 지출 수집 점검(소비 보고 2단계, 2026-10-31 제우스 판단): '지출 0원'이 결제가 없던 날인지 수집이 빠진 날인지 가른다.
// - 알림 앱 원문(`Spending/{YYYY}/{date}.jsonl`)과 아르고스 원본(`Events`)의 같은 날 결제 알림을 같은 파서로 센다.
// - 11-07 전환 전에는 알림 앱이 정본이고 아르고스는 미리보기다. 아르고스가 더 많이 잡았으면 알림 앱이 놓친 것이다.
// - 전환 뒤에는 아르고스 결제가 같은 원문 파일로 들어오므로(argos-forward --apply) 두 수가 같아지고 'ok'가 된다.
// 한계(2026-10-31 리뷰): 건수만 비교해 서로 다른 결제를 하나씩 놓친 날은 못 잡는다. 전환 뒤에는 argos-forward가
// 07:30 브리핑 전에 전날 분을 붙이지 못하면 argos-more로 뜬다(전환 배선 때 주기 확인).
// 원본은 읽기만 한다. 판정 결과는 파일로 남기지 않는다(새 경로 없음) — 브리핑과 화면이 그때그때 계산한다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { spendingRecordsFromEvents } from './argos-forward.mjs';
import { parseSpendingRecords } from './spending-parse.mjs';
import { readDailySpending, readSpendingSettings } from './spending-daily.mjs';

export const COLLECTION_STATUSES = ['ok', 'quiet', 'check'];

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
}) : []);

// 순수 판정. alertCount: 알림 앱 지출 건수, argosCount: 아르고스 지출 건수.
// - check/argos-more: 아르고스가 더 많이 잡음(알림 앱이 놓침)
// - check/no-source: 두 수집 모두 그날 흔적이 없음
// - quiet: 수집은 살아 있었고 지출 0건(결제 없음, 알림 기준)
export function judgeCollection({ alertCount, argosCount, alertSource, argosAlive }) {
  if (argosCount > alertCount) return { status: 'check', reason: 'argos-more' };
  if (alertCount > 0) return { status: 'ok', reason: null };
  if (!alertSource && !argosAlive) return { status: 'check', reason: 'no-source' };
  return { status: 'quiet', reason: null };
}

export function dayCollection(date, { root = VAULT_PATHS.root, spendingDir = VAULT_PATHS.spending } = {}) {
  const { recipientDecisions } = readSpendingSettings(spendingDir);
  const summary = readDailySpending(date, { spendingDir, recipientDecisions });
  const eventsOf = (day) => readJsonl(join(root, ...VAULT_REL.argosEvents.split('/'), day.slice(0, 4), `${day}.jsonl`));
  const events = eventsOf(date);
  const argosAlive = events.some((event) => event?.type === 'core.heartbeat');
  // 이벤트 파일은 받은 날 기준이라 자정 직전 결제 알림이 다음 날 파일에 있을 수 있다. 결제 시각(ts) 날짜로 거른다.
  const records = spendingRecordsFromEvents([...events, ...eventsOf(nextDay(date))])
    .filter((record) => record.ts.slice(0, 10) === date);
  const argosCount = parseSpendingRecords(records, { recipientDecisions })
    .filter((entry) => entry.status === 'expense').length;
  const counts = { alertCount: summary.expenseCount, argosCount, alertSource: summary.hasSource, argosAlive };
  return { date, ...counts, ...judgeCollection(counts) };
}

export function formatCollectionLine(result) {
  if (result.status !== 'check') return null;
  if (result.reason === 'argos-more') {
    return `- ${result.date.slice(5)} 지출 수집 확인 필요: 아르고스 결제 ${result.argosCount}건, 지출 기록 ${result.alertCount}건`;
  }
  return `- ${result.date.slice(5)} 지출 수집 확인 필요: 알림 앱·아르고스 모두 그날 기록 없음`;
}
