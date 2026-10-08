// 돌파매매 진입 사전검사용 보유 집합(이관 4-6) — 장후시간외 진입(place-breakout-entry-order)과
// 다음날 시가 폴백 진입(place-breakout-fallback-entry)이 같이 쓴다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findOpenPositions, parseBreakoutPosition } from './breakout-position-vault.mjs';
import { parsePendingEntry, PENDING_ENTRY_STATUS } from './breakout-pending-entry-vault.mjs';

// 사전검사 입력 합치기(이관 4-6) — 순수함수. 해석할 수 없는 기록은 통과로 보지 않고 throw한다.
// 보유로 보는 것: 볼트 보유 포지션 · KIS 실잔고(수동 매수 포함) · 시가 진입 대기열의 진행 중 항목
// (pending·placing·uncertain — placed는 체결되면 포지션, 미체결이면 미체결 주문으로 잡힌다) · 당일 미체결 매수 주문.
const IN_FLIGHT_PENDING = new Set([PENDING_ENTRY_STATUS.PENDING, PENDING_ENTRY_STATUS.PLACING, PENDING_ENTRY_STATUS.UNCERTAIN]);
export function buildHeldCodeSet({ positionFiles, pendingFiles, balanceHoldings, openOrders }) {
  const held = new Set();
  for (const { name, content } of positionFiles) {
    const p = parseBreakoutPosition(content);
    if (!p.code || !p.status) throw new Error(`포지션 기록 해석 불가: ${name}`);
    if (findOpenPositions([p]).length) held.add(String(p.code));
  }
  for (const { name, content } of pendingFiles) {
    const e = parsePendingEntry(content);
    if (!e.code || !e.status) throw new Error(`진입 대기 기록 해석 불가: ${name}`);
    if (IN_FLIGHT_PENDING.has(e.status)) held.add(String(e.code));
  }
  if (!Array.isArray(balanceHoldings)) throw new Error('KIS 잔고 보유목록 없음');
  for (const h of balanceHoldings) held.add(h.code);
  if (!Array.isArray(openOrders)) throw new Error('KIS 미체결 주문 목록 없음');
  for (const o of openOrders) if (o.side === '매수' && o.cancelableQty > 0) held.add(o.code);
  return held;
}

// 포지션·대기열 폴더는 첫 기록이 생길 때 만들어지므로 "폴더 없음 = 기록 0건"이 정상이다.
// 볼트 자체가 안 보이는 경우(미마운트·경로 이관 실수)만 상위 폴더로 가려내 throw한다.
export function readBreakoutRecordFiles(dir) {
  if (!existsSync(dirname(dir))) throw new Error(`볼트 폴더 없음: ${dirname(dir).replace(process.env.HOME ?? '', '~')}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ name: f, content: readFileSync(join(dir, f), 'utf8') }));
}
