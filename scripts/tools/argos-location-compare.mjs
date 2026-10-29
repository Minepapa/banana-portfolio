#!/usr/bin/env node
// 아르고스 위치와 OwnTracks 위치를 날짜별로 대조한다(읽기 전용, 아르고스 수신부 재설계 2단계 4번,
// 2026-10-29). OwnTracks 대체 판단(목표 2026-11-07 전후)의 근거 지표다.
// 좌표는 출력하지 않는다(개수·비율·시각·거리만).
//
// 지표를 이렇게 정한 이유(독립 리뷰 2026-10-29, 첫 판 REQUEST CHANGES):
// - 두 앱은 안드로이드의 같은 위치 측정값을 받는다. 같은 tst의 점은 좌표도 같으므로 "측정값 공유"로
//   따로 센다 — 거리 0은 아르고스가 정확하다는 뜻이 아니다.
// - 시각이 몇 초 다른 점끼리 거리를 재면 그동안 이동한 거리(속도×시각차)가 나온다. 그래서 OwnTracks
//   시각에 맞춰 아르고스 경로를 앞뒤 점 사이로 보간한 뒤 거리를 잰다.
// - OwnTracks(significant 모드)는 체류 중 보고하지 않도록 설계돼 있고, 아르고스는 체류 중 15분마다 체류
//   확인을 보낸다. 공백은 아르고스를 "위치 점만"과 "체류 확인 포함" 둘 다 보여 준다.
// - 정확도 지표는 acc가 숫자인 점만 쓴다(null을 0 m로 세지 않는다).
//   node scripts/tools/argos-location-compare.mjs [--date=YYYY-MM-DD] [--days=N]   (기본: 어제 KST, 1일)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { distanceM } from './argos-health-check.mjs';

// 공백: 이 시간보다 길게 기록이 없으면 한 번(argos-health-check와 같은 45분).
export const GAP_MIN = 45;
// 보간에 쓰는 아르고스 앞뒤 점의 최대 간격. 이보다 멀면 경로를 안다고 볼 수 없어 비교하지 않는다.
export const INTERP_MAX_SEC = 120;

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const hhmm = (sec) => new Date(sec * 1000 + 9 * 3600_000).toISOString().slice(11, 16);
const hasAcc = (p) => typeof p.acc === 'number' && Number.isFinite(p.acc);
const percentile = (sorted, q) => (sorted.length ? sorted[Math.floor(sorted.length * q)] : null);

function gapsOf(points) {
  const timeline = [...points].sort((a, b) => a.tst - b.tst);
  const gaps = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const d = timeline[i].tst - timeline[i - 1].tst;
    if (d > GAP_MIN * 60) gaps.push(`${hhmm(timeline[i - 1].tst)}~${hhmm(timeline[i].tst)}(${Math.round(d / 60)}분)`);
  }
  return gaps;
}

/** 위치 점 배열({tst, lat, lon, acc}) → 지표. aliveMarks: 공백 계산에만 넣는 생존 표시(체류 확인). */
export function locationMetrics(points, aliveMarks = []) {
  const withAcc = points.filter(hasAcc);
  const accs = withAcc.map((p) => p.acc).sort((a, b) => a - b);
  const coarse = withAcc.filter((p) => p.acc >= 100).length;
  return {
    points: points.length,
    precisePoints: withAcc.length - coarse,
    coarsePct: withAcc.length ? Math.round((coarse / withAcc.length) * 100) : null,
    accP50: accs.length ? Math.round(percentile(accs, 0.5)) : null,
    gaps: gapsOf(points),
    gapsWithAlive: aliveMarks.length ? gapsOf([...points, ...aliveMarks]) : null,
  };
}

/** 아르고스 경로를 t초에 보간한다. 앞뒤 점이 INTERP_MAX_SEC 안에 있어야 한다. */
export function interpolateAt(sortedArgos, t) {
  let lo = 0;
  let hi = sortedArgos.length - 1;
  if (hi < 0 || t < sortedArgos[0].tst || t > sortedArgos[hi].tst) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sortedArgos[mid].tst <= t) lo = mid; else hi = mid;
  }
  const a = sortedArgos[lo];
  const b = sortedArgos[hi];
  if (a.tst === t) return a;
  if (b.tst === t) return b;
  if (b.tst - a.tst > INTERP_MAX_SEC) return null;
  const f = (t - a.tst) / (b.tst - a.tst);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/** OwnTracks 정확한 점마다: 같은 tst면 측정값 공유, 아니면 아르고스 보간 경로까지 거리(m). */
export function compareTracks(owntracks, argos) {
  const sorted = argos.filter((p) => hasAcc(p) && p.acc < 100).sort((a, b) => a.tst - b.tst);
  const sameTst = new Map(sorted.map((p) => [p.tst, p]));
  let shared = 0;
  let sharedSameFix = 0;
  const distances = [];
  for (const o of owntracks) {
    if (!hasAcc(o) || o.acc >= 100) continue;
    const twin = sameTst.get(o.tst);
    if (twin) {
      shared += 1;
      if (twin.lat === o.lat && twin.lon === o.lon) sharedSameFix += 1;
      continue;
    }
    const at = interpolateAt(sorted, o.tst);
    if (at) distances.push(Math.round(distanceM(o, at)));
  }
  distances.sort((a, b) => a - b);
  return {
    shared, sharedSameFix,
    interpolated: distances.length,
    distanceP50: percentile(distances, 0.5),
    distanceP90: percentile(distances, 0.9),
  };
}

export function readOwnTracks(root, date) {
  const path = join(root, VAULT_REL.location, date.slice(0, 4), `${date}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try { const p = JSON.parse(line); return Number.isFinite(p.tst) ? [p] : []; } catch { return []; }
  });
}

// 아르고스: 위치 점(location.point_recorded)과 체류 확인(stay.heartbeat, 생존 표시로만 쓴다).
export function readArgos(root, date) {
  const path = join(root, VAULT_REL.argosEvents, date.slice(0, 4), `${date}.jsonl`);
  const out = { points: [], alive: [] };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'location.point_recorded' && Number.isFinite(e.payload?.tst)) out.points.push(e.payload);
    else if (e?.type === 'stay.heartbeat' && Number.isFinite(e.occurred_at)) out.alive.push({ tst: Math.floor(e.occurred_at / 1000) });
  }
  return out;
}

export function compareDay(owntracks, argos) {
  return {
    owntracks: locationMetrics(owntracks),
    argos: locationMetrics(argos.points, argos.alive),
    tracks: compareTracks(owntracks, argos.points),
  };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const end = args.date ?? kstDate(Date.now() - 86_400_000);
  const days = Math.max(1, Number(args.days ?? 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isInteger(days)) throw new Error('--date=YYYY-MM-DD --days=N');
  const root = vaultAbs('');
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = kstDate(Date.parse(`${end}T00:00:00+09:00`) - i * 86_400_000);
    const r = compareDay(readOwnTracks(root, date), readArgos(root, date));
    const line = (label, m) => `  ${label}: 점 ${m.points}개(acc<100m ${m.precisePoints}개) · acc≥100m ${m.coarsePct ?? '-'}% · acc 중앙값 ${m.accP50 ?? '-'}m · 공백 ${m.gaps.length}회`
      + (m.gapsWithAlive ? ` (체류 확인 포함 ${m.gapsWithAlive.length}회)` : '');
    console.log(`[argos-location-compare] ${date}`);
    console.log(line('OwnTracks', r.owntracks));
    console.log(line('아르고스 ', r.argos));
    const t = r.tracks;
    console.log(`  같은 측정값 공유(같은 tst) ${t.shared}점(좌표 일치 ${t.sharedSameFix}) · 보간 대조 ${t.interpolated}점 거리 중앙값 ${t.distanceP50 ?? '-'}m · 90% ${t.distanceP90 ?? '-'}m`);
    for (const [label, gaps] of [['OwnTracks', r.owntracks.gaps], ['아르고스(위치 점만)', r.argos.gaps]]) {
      if (gaps.length) console.log(`  ${label} 공백: ${gaps.join(', ')}`);
    }
  }
  console.log('  참고: OwnTracks(significant 모드)는 체류 중 보고하지 않도록 설계돼 있어 체류 구간이 공백으로 잡힌다.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`[argos-location-compare] ${e.message}`); process.exit(1); }
}
