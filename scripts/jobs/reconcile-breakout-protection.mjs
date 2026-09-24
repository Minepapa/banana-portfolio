#!/usr/bin/env node
// 평일 KRX 시가단일가 프리장(08:35) — 장후시간외 체결분의 보호주문을 다음날 등록.
// 실제 체결감시기(watch-breakout-entry-fill.mjs)가 미체결분을 09:03 폴백으로 보내고,
// 그 폴백 체결은 기존 감시기가 즉시 보호한다. 이후에도 보호주문은 당일 만료될 수
// 있으므로 모든 보유 포지션을 매일 재조회하고, API에서 확인된 누락 다리만 복구한다.
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
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
const DRY_RUN = process.argv.includes('--dry-run');
const LOCK_FILE = join(VAULT_PATHS.state.breakoutPositions, '.morning-protection.lock');
// 계좌조회·여러 보유종목 순회·보호주문 재시도보다 state-writer 기본 10초 stale 기준을
// 충분히 길게 둔다. 중복 실행이 이 락을 만료로 오판해 제거하면 같은 보호주문을 둘 수 있다.
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export function isKrxPreMarketWindow(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const hhmm = Number(parts.hour) * 100 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && hhmm >= 830 && hhmm < 900;
}

function readPositions() {
  const dir = VAULT_PATHS.state.breakoutPositions;
  if (!existsSync(dir)) return { entries: [], errors: [] };
  const entries = [];
  const errors = [];
  for (const filename of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const filepath = join(dir, filename);
    try {
      const content = readFileSync(filepath, 'utf8');
      const position = parseBreakoutPosition(content);
      if (!position.id || !position.code || !position.status) {
        errors.push(`${filename}: 포지션 필수 필드 누락`);
        continue;
      }
      entries.push({ filepath, filename, position });
    } catch (e) {
      console.error(`[포지션 파일 읽기 오류] ${filename}: ${e.message}`);
      errors.push(`${filename}: 포지션 파일을 읽지 못함 — 해당 파일 자동조정 중단`);
    }
  }
  return { entries, errors };
}

async function notify(lines, tag = '보호') {
  if (!lines.length) return;
  if (DRY_RUN) { console.log(`[DRY RUN ${tag}] ${lines.join(' | ')}`); return; }
  await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag, facts: lines }));
}

async function main() {
  const now = new Date();
  if (!DRY_RUN && !isKrxPreMarketWindow(now)) {
    console.log('[건너뜀] KRX 평일 08:30~09:00 시가단일가 시간이 아님');
    return;
  }
  await withLock(LOCK_FILE, async () => {
    const { entries: allEntries, errors: fileErrors } = readPositions();
    const entries = allEntries.filter(({ position: p }) => p.status === '보유');
    if (!entries.length && !fileErrors.length) { console.log('[정상] 아침 보호조정 대상 없음'); return; }
    if (!entries.length) { await notify(fileErrors, '경고'); return; }
    const quant = loadQuantAccount();
    if (!quant) { await notify(['KIS 퀀트계좌 설정을 읽지 못해 보호주문을 보류했습니다.']); return; }
    const { appkey, appsecret } = quant;
    const token = await getKisToken({ appkey, appsecret });
    const balance = await getAccountBalance({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd });
    const orders = await getCancelableOrders({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd });
    const readState = (filepath) => {
      try { return readFileSync(filepath, 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    };
    const balanceByCode = new Map(balance.holdings.map((h) => [h.code, h]));
    const reports = [...fileErrors];

    for (const { filepath, position } of entries) {
      try {
        const holding = balanceByCode.get(position.code) ?? null;
        const quote = await getKrQuote({ token, appkey, appsecret, code: position.code });
        const prices = computeProtectionOrders(position.entryPrice, position.quantity, position.stopLossPct);
        const decision = decideMorningProtection({
          position, holding, sellOrders: orders, currentPrice: quote.price,
          stopPrice: prices.stopOrder.conditionPrice, profitPrice: prices.profitOrder?.conditionPrice ?? null,
        });
        if (decision.action !== 'place') {
          reports.push(`${position.name || position.code}: ${decision.reason}`);
          continue;
        }
        const alreadyProtected = Boolean(decision.existingStop)
          && (position.profitOrderApplicable === false || Boolean(decision.existingProfit));
        if (alreadyProtected) {
          // `protectionStatus`는 접수 당시 상태일 뿐이다. 매일 API에서 두 다리를
          // 재확인한 결과 모두 살아 있으면 주문 없이 확인시각만 갱신한다.
          const wrote = await patchFrontmatterFileSafely(filepath, {
            protectionStatus: 'protected',
            stopOrderNo: decision.existingStop.orderNo,
            stopOrderOrgNo: decision.existingStop.branchNo ?? null,
            profitOrderNo: decision.existingProfit?.orderNo ?? null,
            profitOrderOrgNo: decision.existingProfit?.branchNo ?? null,
            protectionCheckedAt: now.toISOString(), updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 확인시각 기록 실패');
          reports.push(`${position.name || position.code}: 손절·3R 보호주문 모두 활성 확인`);
          continue;
        }
        if (DRY_RUN) {
          reports.push(`${position.name || position.code}: 드라이런 — 발주 안 함`);
          continue;
        }
        // 네트워크 조회·앞선 포지션 처리 도중 오너가 킬스위치/체결모드를 바꿀 수 있으므로
        // 실행 시작 때 읽은 낡은 스냅샷을 쓰지 않고, 각 포지션의 첫 주문 직전에 다시 읽는다.
        const gatesAllowOrder = () => {
          try {
            const haltedNow = isKillSwitchActive(readState(VAULT_PATHS.state.killSwitch));
            const liveNow = getExecutionMode(readState(VAULT_PATHS.state.executionMode)) === MODE_LIVE;
            return !haltedNow && liveNow;
          } catch (e) {
            console.error(`[주문 게이트 조회 실패] ${position.code}: ${e.message}`);
            return false;
          }
        };
        if (!gatesAllowOrder()) {
          const haltedNow = isKillSwitchActive(readState(VAULT_PATHS.state.killSwitch));
          reports.push(`${position.name || position.code}: ${haltedNow ? '킬스위치 활성' : '체결모드 섀도우'} — 발주 안 함`);
          continue;
        }
        const placeOrder = (params) => placeKrOrder({
          token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
          code: position.code, ...params,
        });
        // 저장된 주문번호만 신뢰하지 않는다. API에서 조건가·가격·수량이 정확히 맞는
        // 스톱다리를 확인하면 그 주문번호를 이어받고, ensurePositionProtected가
        // 실제로 누락된 다리만 접수한다. 알 수 없는 같은 종목 매도는 위 판정에서 차단.
        const result = await ensurePositionProtected(carryForwardProtectionOrders(position, decision), {
          placeOrder, beforePlaceOrder: gatesAllowOrder,
        });
        const patch = {
          ...result, protectionDeferredUntil: null, protectionDeferredAt: null,
          protectionCheckedAt: now.toISOString(), updatedAt: now.toISOString(),
        };
        const wrote = await patchFrontmatterFileSafely(filepath, patch);
        if (!wrote) throw new Error('포지션 파일 동시수정으로 결과 기록 실패');
        reports.push(`${position.name || position.code}: ${result.protectionStatus === 'protected' ? '손절·3R 보호주문 접수' : result.gateBlocked ? '스위치 변경으로 후속 발주 중단 — 보호주문 상태 즉시 확인 필요' : '보호주문 일부 또는 전체 실패 — 즉시 확인 필요'} (손절 ${result.stopOrderNo ?? '없음'}, 3R ${result.profitOrderNo ?? '없음'})`);
      } catch (e) {
        console.error(`[아침 보호조정 오류] ${position.code}: ${e.message}`);
        reports.push(`${position.name || position.code}: 조회 또는 기록 오류 — 중복방지를 위해 추가 주문을 중단했습니다.`);
      }
    }
    const actionable = reports.filter((x) => !/모두 활성 확인/.test(x));
    await notify(actionable, actionable.some((x) => /실패|오류|보류|중단|불일치|존재/.test(x)) ? '경고' : '완료');
    for (const line of reports) console.log(`[아침 보호조정] ${line}`);
  }, { staleLockMs: LOCK_STALE_MS });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error(`[아침 보호조정 중단] ${e.message}`);
    await notify(['KIS 보호주문 조회 또는 아침 조정이 실패했습니다. 주문 중복 방지를 위해 자동 발주를 중단했습니다.'], '경고').catch(() => {});
    process.exit(1);
  });
}
