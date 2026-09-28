#!/usr/bin/env node
// 이미 체결된 카이로스 보유 포지션의 보호주문을 수동으로 재시도한다.
//
// 2026-09-29 재설계 — 보호주문은 이제 손절 단일 다리뿐이다(3R 부분익절은 매일
// reconcile-breakout-protection.mjs가 능동 관리, 진입 시점엔 시도 자체를 안 함).
// 이 도구는 새 주문 계산 경로를 만들지 않고 손절 단일 다리 재시도(ensureStopOrder,
// breakout-protection.mjs)만 호출한다. 단, 파일에 stopOrderNo가 비어 있다고 바로
// 새 주문을 내지 않는다 — 파일이 KIS 실제 상태보다 낡았을 수 있으므로(예: 이전
// 시도가 애매한 응답으로 끝나 실제로는 접수됐을 가능성) 먼저 KIS 정정취소가능주문을
// 조회해 이미 이 종목에 손절형(스톱지정가) 매도주문이 떠 있는지 확인하고, 있으면
// 중복주문을 막기 위해 자동 진행하지 않고 사람에게 알린다.
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
import { loadQuantAccount, getKisToken, placeKrOrder, getCancelableOrders, getAccountBalance, getKrQuote } from '../lib/kis.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { isKillSwitchActive } from '../lib/kill-switch.mjs';
import { ensureStopOrder } from '../lib/breakout-protection.mjs';
import { isAlreadyBreached } from '../lib/breakout-exit-management.mjs';
import { parseBreakoutPosition } from '../lib/breakout-position-vault.mjs';
import { patchFrontmatterFileSafely, withLock } from '../lib/state-writer.mjs';
// 08:35 잡(reconcile-breakout-protection.mjs)과 락 파일·유효기간을 공유한다 —
// breakout-protection-lock.mjs 헤더 주석 참고. 처음엔 잡 파일에서 직접
// import했는데, 그러면 이 CLI가 잡의 전체 의존 그래프(텔레그램·장부기록 등)를
// 딸려 들이고 계층 방향도 거꾸로라(2026-09-29 4차 코드리뷰 LOW 지적) 공용
// 모듈로 옮겼다.
import { BREAKOUT_PROTECTION_LOCK_FILE, BREAKOUT_PROTECTION_LOCK_STALE_MS } from '../lib/breakout-protection-lock.mjs';

const LOCK_FILE = BREAKOUT_PROTECTION_LOCK_FILE;
const LOCK_STALE_MS = BREAKOUT_PROTECTION_LOCK_STALE_MS;
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
    if (DRY_RUN) {
      console.log(`[DRY RUN] ${position.name || position.code}: 손절 ${position.stopOrderNo ?? '누락'} — 손절만 재시도 예정`);
      return;
    }
    const gates = gatesAllowOrder();
    if (!gates.ok) throw new Error(`${gates.reason} — 보호주문 발주 안 함`);

    // 파일의 stopOrderNo를 그대로 믿지 않는다 — 2026-09-29 재설계로 KIS 스톱지정가
    // 주문은 당일유효(매일 자동 소멸)라, 파일에 남은 stopOrderNo는 "이미 지나간
    // 날짜에 걸었던 주문번호"일 뿐 지금 실제로 살아있다는 보장이 없다(2026-09-29
    // 2차 코드리뷰 HIGH 지적 — ensureStopOrder의 조기 반환이 이 낡은 번호만 보고
    // "protected"라고 파일에 거짓 기록할 수 있었음, 실제로 대한항공 포지션이 이
    // 조건이었다). 매번 KIS 정정취소가능주문·실제 보유수량·현재가를 직접 조회해
    // "지금 실제로" 안전하게 낼 수 있는 상태인지 확인한다(2026-09-29 3차 코드리뷰
    // HIGH 지적 — 2차 수정이 이 세 가드를 전부 빠뜨렸었다. 삭제된 옛
    // breakout-morning-protection.mjs의 decideMorningProtection이 하던 검사를
    // 여기 인라인으로 복원).
    const [cancelableOrders, balance, quote] = await Promise.all([
      getCancelableOrders({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
      getAccountBalance({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
      // 손절선 통과 여부는 반드시 지금 이 순간의 실시간가로 판정한다 — 이
      // 도구는 오너가 08:35 잡의 긴급 경고를 받고 장중에 수동으로 돌리는
      // 도구라, 전일 종가 캐시로는 오늘 갭하락/급락을 못 본다(2026-09-29
      // 4차 코드리뷰 HIGH 지적 — 3차 수정이 실시간 시세 대신 캐시 종가를
      // 써서 이 가드를 사실상 무력화했었다). getKrQuote는 유효한 현재가를
      // 못 받으면 그 자체로 throw하므로(kis.mjs parseQuoteResponse) "가격을
      // 못 구함"이 곧 안전하게 중단됨을 뜻한다 — 조용히 통과시키지 않는다.
      getKrQuote({ token, appkey, appsecret, code: position.code }),
    ]);
    // 이 종목의 매도주문이면 타입(스톱지정가 '22')을 가리지 않고 살아있는 것
    // 전부를 본다 — placeStopAndPartialExit가 매도는 확정하고 잔여 손절만 실패한
    // urgentReview 상태에서는 남은 게 스톱지정가가 아니라 이미 체결된(또는
    // 체결 대기) 시장가 매도일 수 있는데, 그 주문도 매도가능수량을 잡고 있어
    // 새 스톱주문을 내면 2026-09-28 대한항공 ord_psbl_qty=0 사고와 같은 계열의
    // 충돌이 난다.
    const existingSellOrder = cancelableOrders.find((o) => o.code === position.code
      && o.side === '매도' && (o.cancelableQty ?? 0) > 0);
    if (existingSellOrder) {
      throw new Error(`KIS엔 이미 이 종목 매도주문(${existingSellOrder.orderNo}, ${existingSellOrder.orderType ?? existingSellOrder.orderTypeCode}, 수량 ${existingSellOrder.quantity})이 살아있습니다 — 중복주문 방지를 위해 자동 재시도를 하지 않습니다. 파일의 손절정보(stopOrderNo 등)가 이 주문번호와 일치하는지 KIS 앱과 대조해 수동 정정하세요.`);
    }
    const holding = balance.holdings.find((h) => h.code === position.code) ?? null;
    if (!holding || !Number.isInteger(holding.qty) || holding.qty !== Number(position.quantity)) {
      throw new Error(`KIS 실제 보유수량이 파일 기록과 다릅니다(기록 ${position.quantity}주, KIS ${holding?.qty ?? '보유 없음'}) — 자동 재시도를 하지 않습니다. 먼저 파일을 KIS 실제 상태와 수동 대조하세요.`);
    }
    // 검증하는 가격(stopPrice)과 실제로 주문에 실리는 가격이 같은 값임을 보장한다
    // — ensureStopOrder(breakout-protection.mjs)는 position.stopPrice가 있으면
    // 그걸, 없으면 computeInitialStopOrder(진입가 기준 재계산값)를 쓴다. stopPrice가
    // 비어있는데 여기서 검증을 건너뛰면, 트레일링으로 이미 올라간 진짜 손절선이
    // 아니라 진입가 기준 옛 값으로 주문이 나갈 수 있다(2026-09-29 4차 코드리뷰
    // MEDIUM 지적).
    const stopPrice = Number(position.stopPrice);
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      throw new Error(`포지션 파일의 stopPrice가 유효하지 않습니다(${position.stopPrice}) — 손절선 통과 여부를 확인할 수 없어 자동 재시도를 하지 않습니다.`);
    }
    if (isAlreadyBreached(quote.price, stopPrice)) {
      throw new Error(`현재가(${quote.price})가 손절선(${stopPrice}) 이하입니다 — 스톱지정가 주문이 접수만 되고 정상 작동을 보장할 수 없어 자동 재시도를 하지 않습니다. 시장가 매도 등 수동 조치가 필요할 수 있습니다.`);
    }
    // 여기 도달했으면 KIS 실제 상태로 "지금 살아있는 매도주문 없음·보유수량
    // 일치·손절선 미통과"를 방금 확인했다 — 파일의 stopOrderNo가 뭐였든(비어있든,
    // 어제 날짜의 소멸된 번호든) ensureStopOrder가 그 낡은 값을 보고 조기
    // 반환하지 않도록 null로 넘긴다. entry-fill 시점(watch-breakout-entry-fill.mjs)
    // 의 ensureStopOrder 호출은 이 문제가 없다 — 그쪽은 같은 실행 안에서 막
    // 채워진 값만 본다.
    const placeOrder = (params) => placeKrOrder({
      token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
      code: position.code, ...params,
    });
    const result = await ensureStopOrder({ ...position, stopOrderNo: null }, {
      placeOrder,
      beforePlaceOrder: () => gatesAllowOrder().ok,
    });
    // ensureStopOrder 반환값 중 포지션 레코드 스키마에 실제로 있는 필드만
    // 화이트리스트로 기록한다 — {...result}로 전부 쏟으면 attempts·stopAmbiguous·
    // gateBlocked·error 같은 내부 진단 필드가 frontmatter에 영구히 남는다
    // (2026-09-29 2차 코드리뷰 MEDIUM 지적, 실제 003490 파일에 이미 이런 잔재가
    // 있었음).
    const wrote = await patchFrontmatterFileSafely(filepath, {
      stopOrderNo: result.stopOrderNo,
      stopOrderOrgNo: result.stopOrderOrgNo,
      protectionStatus: result.protectionStatus,
      protectionDeferredUntil: null,
      protectionDeferredAt: null,
      protectionCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!wrote) throw new Error('포지션 파일이 사라져 결과를 기록하지 못했습니다');
    console.log(`[보호주문 재시도] ${position.name || position.code}: ${result.protectionStatus} (손절 ${result.stopOrderNo ?? '없음'})`);
  }, { staleLockMs: LOCK_STALE_MS });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`❌ 보호주문 재시도 중단: ${error.message}`);
    process.exitCode = 2;
  });
}
