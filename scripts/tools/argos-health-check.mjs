#!/usr/bin/env node
// 아르고스 하루 점검(읽기 전용). 95_Etna/Events의 하루치 이벤트로 이상 신호를 찾는다.
// 좌표·알림 본문·파일 이름은 출력하지 않는다(시각·개수·거리만).
//   node scripts/tools/argos-health-check.mjs [--date=YYYY-MM-DD]   (기본: 오늘 KST)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';

const MIN = 60_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString();
const hhmm = (ms) => kst(ms).slice(11, 16);
const R = 6_371_000;
const rad = (x) => (x * Math.PI) / 180;
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 이벤트 배열 → 점검 결과(테스트용 순수 함수). */
export function checkDay(events) {
  const ev = [...events].sort((a, b) => a.occurred_at - b.occurred_at);
  const issues = [];
  const facts = {};
  const of = (type) => ev.filter((e) => e.type === type);

  // 체류: 겹침, 그리고 기준점 근처에서 끝난 체류(집 안 움직임으로 끊김 의심)
  const starts = new Map(of('stay.started').map((e) => [e.payload.stay_id, e]));
  const ends = of('stay.ended');
  facts.stays = starts.size;
  let open = null;
  for (const e of ev.filter((x) => x.type === 'stay.started' || x.type === 'stay.ended')) {
    if (e.type === 'stay.started') {
      if (open) issues.push(`체류 겹침: ${hhmm(open.occurred_at)} 체류가 끝나기 전 ${hhmm(e.occurred_at)} 새 체류`);
      open = e;
    } else if (open && e.payload.stay_id === open.payload.stay_id) open = null;
  }
  const points = of('location.point_recorded');
  for (const end of ends) {
    const start = starts.get(end.payload.stay_id);
    const anchor = start?.payload?.anchor;
    if (!anchor) continue;
    const after = points.find((p) => p.occurred_at > end.occurred_at && p.occurred_at - end.occurred_at < 10 * MIN && p.payload.acc <= 100);
    if (after && distanceM(anchor, after.payload) < 100) {
      issues.push(`체류가 제자리에서 끝남: ${hhmm(end.occurred_at)} (10분 안 위치가 기준점 ${Math.round(distanceM(anchor, after.payload))} m)`);
    }
  }

  // 위치·상태 보고 빈 시간
  facts.points = points.length;
  const gap = (list, limitMin, label) => {
    for (let i = 1; i < list.length; i += 1) {
      const d = list[i].occurred_at - list[i - 1].occurred_at;
      if (d > limitMin * MIN) issues.push(`${label} ${Math.round(d / MIN)}분 비어 있음: ${hhmm(list[i - 1].occurred_at)}~${hhmm(list[i].occurred_at)}`);
    }
  };
  gap(of('core.heartbeat'), 60, '상태 보고');
  // 체류 중에는 15분 체류 확인이 있으니 위치는 45분까지 정상으로 본다
  gap(points.concat(of('stay.heartbeat')).sort((a, b) => a.occurred_at - b.occurred_at), 45, '위치');

  // 맥 도착 지연(실시간 전송이 된 이벤트만: 하루 중 backlog는 따로 셈)
  const lags = ev.map((e) => e.received_at - e.occurred_at).filter(Number.isFinite).sort((a, b) => a - b);
  if (lags.length) {
    facts.lagP50s = Math.round(lags[Math.floor(lags.length * 0.5)] / 1000);
    facts.lagP90s = Math.round(lags[Math.floor(lags.length * 0.9)] / 1000);
  }
  // 미디어·알림·문제 신호
  facts.mediaSent = of('media.transferred').length;
  facts.notifications = of('notification.received').length;
  facts.phoneDeleted = of('media.deleted_on_phone').length;
  facts.phoneRestored = of('media.restored_on_phone').length;
  for (const type of ['media.deletions_held', 'core.ledger_prune_failed', 'core.transport_auth_failed', 'core.transport_rejected',
    'core.rules_rejected', 'core.storage_warning']) {
    const n = of(type).length;
    if (n) issues.push(`${type} ${n}회 (처음 ${hhmm(of(type)[0].occurred_at)})`);
  }
  return { facts, issues };
}

function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--date='));
  const date = arg ? arg.slice(7) : kst(Date.now()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date=YYYY-MM-DD');
  const path = join(vaultAbs(VAULT_REL.argosEvents), date.slice(0, 4), `${date}.jsonl`);
  if (!existsSync(path)) { console.log(`[argos-health-check] ${date} 이벤트 없음`); return; }
  const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const { facts, issues } = checkDay(events);
  console.log(`[argos-health-check] ${date} 이벤트 ${events.length}건`);
  for (const [k, v] of Object.entries(facts)) console.log(`  ${k}: ${v}`);
  console.log(issues.length ? `  이상 신호 ${issues.length}건` : '  이상 신호 없음');
  for (const i of issues) console.log(`  - ${i}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`[argos-health-check] ${e.message}`); process.exit(1); }
}
