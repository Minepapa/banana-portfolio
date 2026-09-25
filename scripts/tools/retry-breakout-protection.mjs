#!/usr/bin/env node
// 이미 체결된 카이로스 보유 포지션의 보호주문을 수동으로 재시도한다.
//
// 이 도구는 새 주문 계산·새 KIS 호출 경로를 만들지 않는다. 아침 자동조정 잡과
// 동일하게 KIS 잔고·정정취소가능주문·현재가를 먼저 읽고, 기존 판정 함수가 정확히
// 누락된 보호 다리만 허용한 경우에만 ensurePositionProtected를 호출한다.
// --code로 포지션이 하나로 좁혀지지 않으면 추정하지 않고 중단한다.
//
// 사용법:
//   node scripts/tools/retry-breakout-protection.mjs --code=003490
//   node scripts/tools/retry-breakout-protection.mjs --position-id=003490-2026-09-23 --dry-run
//
// 이 CLI는 Zeus가 stdout을 읽어 오너에게 설명하는 동기 도구이므로 텔레그램을
// 직접 보내지 않는다. 실주문 전 킬스위치·체결모드를 다시 읽고, 둘 중 하나라도
// 주문을 허용하지 않으면 KIS 주문 API를 호출하지 않는다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadQuantAccount, getKisToken, getAccountBalance, getKrQuote,
  getCancelableOrders, placeKrOrder,
} from '../lib/kis.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { isKillSwitchActive } from '../lib/kill-switch.mjs';
import { computeProtectionOrders, ensurePositionProtected } from '../lib/breakout-protection.mjs';
import { parseBreakoutPosition } from '../lib/breakout-position-vault.mjs';
import { decideMorningProtection, carryForwardProtectionOrders } from '../lib/breakout-morning-protection.mjs';
import { patchFrontmatterFileSafely, withLock } from '../lib/state-writer.mjs';

const LOCK_FILE = join(VAULT_PATHS.state.breakoutPositions, '.manual-protection.lock');
const LOCK_STALE_MS = 60 * 60 * 1000;
const DRY_RUN = process.argv.includes('--dry-run');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/s);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function selectProtectionPosition(entries, { code = '', positionId = '' } = {}) {
  const matches = entries.filter(({ position }) => {
    if (position.status !== '보유') return false;
    if (positionId && position.id !== positionId) return false;
    if (code && String(position.code) !== String(code)) return false;
    return true;
  });
  if (matches.length !== 1) {
    return { ok: false, reason: matches.length === 0 ? '보유 포지션을 찾지 못함' : `보유 포지션 ${matches.length}건이 매칭됨 — --position-id로 하나를 지정` };
  }
  return { ok: true, entry: matches[0] };
}

function readEntries() {
  const dir = VAULT_PATHS.state.breakoutPositions;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((filename) => {
    const filepath = join(dir, filename);
    const content = readFileSync(filepath, 'utf8');
    return { filepath, filename, content, position: parseBreakoutPosition(content) };
  });
}

function readState(filepath) {
  try { return readFileSync(filepath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function gatesAllowOrder() {
  const killSwitch = isKillSwitchActive(readState(VAULT_PATHS.state.killSwitch));
  const live = getExecutionMode(readState(VAULT_PATHS.state.executionMode)) === MODE_LIVE;
  return { ok: !killSwitch && live, reason: killSwitch ? '킬스위치 활성' : (live ? null : '체결모드 섀도우') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = String(args.code ?? '').trim();
  const positionId = String(args['position-id'] ?? '').trim();
  if (!code && !positionId) throw new Error('--code 또는 --position-id 중 하나가 필요합니다');
  if (code && !/^\d{6}$/.test(code)) throw new Error('--code는 6자리 국내 종목코드여야 합니다');

  await withLock(LOCK_FILE, async () => {
    const selected = selectProtectionPosition(readEntries(), { code, positionId });
    if (!selected.ok) throw new Error(selected.reason);
    const { filepath, content, position } = selected.entry;
    const quant = loadQuantAccount();
    if (!quant) throw new Error('퀀트 계좌정보를 읽지 못했습니다');
    const { appkey, appsecret } = quant;
    const token = await getKisToken({ appkey, appsecret });
    const [balance, quote, orders] = await Promise.all([
      getAccountBalance({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
      getKrQuote({ token, appkey, appsecret, code: position.code }),
      getCancelableOrders({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
    ]);
    const holding = balance.holdings.find((item) => item.code === position.code) ?? null;
    const prices = computeProtectionOrders(position.entryPrice, position.quantity, position.stopLossPct);
    const decision = decideMorningProtection({
      position, holding, sellOrders: orders, currentPrice: quote.price,
      stopPrice: prices.stopOrder.conditionPrice,
      profitPrice: prices.profitOrder?.conditionPrice ?? null,
    });
    if (decision.action !== 'place') throw new Error(`${position.name || position.code}: ${decision.reason}`);

    const carried = carryForwardProtectionOrders(position, decision);
    if (DRY_RUN) {
      console.log(`[DRY RUN] ${position.name || position.code}: 손절 ${carried.stopOrderNo ?? '누락'}, 3R ${carried.profitOrderNo ?? '누락'} — 누락 다리만 재시도 예정`);
      return;
    }
    const gates = gatesAllowOrder();
    if (!gates.ok) throw new Error(`${gates.reason} — 보호주문 발주 안 함`);
    const placeOrder = (params) => placeKrOrder({
      token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
      code: position.code, ...params,
    });
    const result = await ensurePositionProtected(carried, {
      placeOrder,
      beforePlaceOrder: () => gatesAllowOrder().ok,
    });
    const wrote = await patchFrontmatterFileSafely(filepath, {
      ...result,
      protectionDeferredUntil: null,
      protectionDeferredAt: null,
      protectionCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!wrote) throw new Error('포지션 파일이 사라져 결과를 기록하지 못했습니다');
    console.log(`[보호주문 재시도] ${position.name || position.code}: ${result.protectionStatus} (손절 ${result.stopOrderNo ?? '없음'}, 3R ${result.profitOrderNo ?? '없음'})`);
  }, { staleLockMs: LOCK_STALE_MS });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`❌ 보호주문 재시도 중단: ${error.message}`);
    process.exitCode = 2;
  });
}
