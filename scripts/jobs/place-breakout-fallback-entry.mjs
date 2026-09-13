#!/usr/bin/env node
// place-breakout-fallback-entry.mjs — 돌파매매 전략(퀀트 트랙) 진입이 전날 장후시간외
// 세션에서 전혀 체결되지 않아 State/BreakoutPendingEntries에 큐잉된 항목을, 다음
// 거래일 시가 근처(장 시작 직후, 시장가 주문이 시가 단일가에 참여할 수 있는 시점)에
// 시장가(ORD_DVSN=01)로 다시 시도한다 — "장후시간외 우선+다음날시가 폴백"(오너 확정,
// 2026-09-13)의 두 번째 다리. 여기서도 더 이상의 폴백은 없다(마지막 시도) — 이마저
// 미체결이면 watch-breakout-entry-fill.mjs가 통상적인 "확인 시간 초과" 알림으로
// 수동확인을 요청한다.
//
// ⚠️ 코드리뷰 CRITICAL 지적(2026-09-13) 반영 — "전날 장후시간외 미체결 주문은 세션
// 종료 시 자동 실효된다"는 가정(watch-breakout-entry-fill.mjs 참고, 실전 첫 실행
// 전까지 미검증)이 틀렸을 경우, 확인 없이 바로 시장가 주문을 또 내면 이중매수가
// 된다. 그래서 이 잡은 **주문 전에 반드시** 전날 장후시간외 주문(afterHoursOrderNo)
// 의 실제 상태를 조회해 "확실히 취소/실효됐다"고 확인될 때만 다음날 시가 주문을
// 낸다 — 조회가 실패하거나 상태가 애매하면 자동 발주를 보류하고 수동확인으로 넘긴다
// (findUnprocessedPendingEntries가 'uncertain' 상태는 재시도 대상에서 자동 제외).
//
// launchd 배선은 아직 안 함(2026-09-13) — 이 스크립트를 실제로 호출할 상위 잡(일별
// 신호스캔)은 있지만, 실거래 자동배선 자체는 별도의 명시적 "가동" 결정으로 남겨둠.
//
// 사용법: node scripts/jobs/place-breakout-fallback-entry.mjs   # 장 시작 직후(09:00~09:05 KST) 실행 전제
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadQuantAccount, getKisToken, getKrQuote, getAccountBalance, checkOrderFill, placeKrOrder,
} from '../lib/kis.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import {
  parsePendingEntry, updatePendingEntryRecord, findUnprocessedPendingEntries, PENDING_ENTRY_STATUS,
} from '../lib/breakout-pending-entry-vault.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
const won = (n) => (n == null ? '확인 필요' : Math.round(n).toLocaleString('ko-KR') + '원');

function loadPendingEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ filename: f, content: readFileSync(join(dir, f), 'utf8') }))
    .map(({ filename, content }) => ({ filename, content, ...parsePendingEntry(content) }));
}

async function notify(tag, body) {
  try {
    await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag, body }));
  } catch (e) { console.error('텔레그램 알림 실패(무시):', e.message); }
}

function markUncertain(dir, filename, content, reason) {
  writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
    status: PENDING_ENTRY_STATUS.UNCERTAIN, reason, updatedAt: new Date().toISOString(),
  }));
}

// 순수함수로 분리(테스트 가능하게, 코드리뷰 지적과 동일한 원칙 — decideEntryOutcome
// 참고) — checkOrderFill의 결과(또는 null/예외)만 보고 "확실히 취소/실효됐다"고
// 안전하게 판단할 수 있는지 분류한다. 애매하면 전부 voided=false(폴백 보류) 쪽으로.
export function classifyPriorOrderStatus(result) {
  if (result == null) return { voided: false, note: '전날 주문 조회 결과 없음(응답에 해당 주문 없음) — 생사 확인 불가, 추정 안 함' };
  if (result.canceled) return { voided: true, note: '전날 주문이 취소/실효 상태로 확인됨' };
  if (result.fullyFilled) return { voided: false, note: `전날 주문이 실제로는 전량체결(${result.avgFillPrice}원)된 것으로 확인됨 — 폴백 대상 아님, 이미 포지션이 있을 수 있음` };
  if (result.filledQty > 0) return { voided: false, note: `전날 주문이 일부(${result.filledQty}주) 체결된 것으로 확인됨 — 잔여수량 처리 불명확, 자동폴백 대상 아님` };
  return { voided: false, note: '전날 주문이 아직 미체결 상태로 남아있는 것으로 확인됨(자동실효 가정이 틀렸을 가능성) — 폴백 보류' };
}

// 전날 장후시간외 주문의 생사를 확인 — "확실히 취소/실효됨"일 때만 true. 그 외(조회
// 실패·응답 없음·이미 체결됨·부분체결 등 애매한 모든 경우)는 false로 안전하게 처리.
async function confirmPriorOrderVoided({ token, appkey, appsecret, cano, acntPrdtCd, afterHoursOrderNo, signalDate }) {
  if (!afterHoursOrderNo) return { voided: true, note: '전날 장후시간외 주문번호 자체가 없음(주문 자체가 실패했던 케이스)' };
  let result;
  try {
    result = await checkOrderFill({
      token, appkey, appsecret, cano, acntPrdtCd, odno: afterHoursOrderNo, now: new Date(signalDate),
    });
  } catch (e) {
    return { voided: false, note: `전날 주문 상태 조회 실패(${e.message}) — 생사 확인 불가` };
  }
  return classifyPriorOrderStatus(result);
}

async function main() {
  const dir = VAULT_PATHS.state.breakoutPendingEntries;
  mkdirSync(dir, { recursive: true });
  const all = loadPendingEntries(dir);
  const targets = findUnprocessedPendingEntries(all);
  if (!targets.length) { console.log('ℹ️ 다음날시가 폴백 대기 중인 항목 없음'); return; }

  const quant = loadQuantAccount();
  if (!quant) { console.log('ℹ️ 퀀트 계좌정보(quantAccount) 미설정 — 스킵'); return; }
  const { appkey, appsecret, cano, acntPrdtCd } = quant;
  const token = await getKisToken({ appkey, appsecret });

  // 사이징용 예수금 재확인(코드리뷰 MEDIUM 지적) — 큐잉 시점(전날)의 예수금을 그대로
  // 믿지 않고 오늘 실제 잔고를 다시 조회, daily-breakout-signal-scan.mjs와 동일하게
  // 여러 건을 처리할 때 순차 차감한다.
  let remainingCash;
  try {
    ({ cash: remainingCash } = await getAccountBalance({ token, appkey, appsecret, cano, acntPrdtCd }));
  } catch (e) {
    await notify('경고', `<b>돌파매매 다음날시가 폴백 중단 — 예수금 조회 실패</b>\n예수금을 확인할 수 없어(${e.message}) 이번 실행에서 모든 대기 항목 처리를 보류합니다. 다음 실행에서 재시도됩니다.`);
    return;
  }
  if (remainingCash == null) {
    await notify('경고', '<b>돌파매매 다음날시가 폴백 중단 — 예수금 확인 불가</b>\n예수금이 0으로 추정되지 않아(조회 자체가 이상값) 이번 실행을 보류합니다.');
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  for (const entry of targets) {
    const { code, name, investedWon, afterHoursOrderNo, signalDate, filename, content } = entry;
    console.log(`[처리] ${entry.id} — ${name}(${code})`);

    const priorCheck = await confirmPriorOrderVoided({ token, appkey, appsecret, cano, acntPrdtCd, afterHoursOrderNo, signalDate });
    if (!priorCheck.voided) {
      console.log(`  ⚠️ 전날 주문 생사 미확인 — 자동폴백 보류: ${priorCheck.note}`);
      markUncertain(dir, filename, content, priorCheck.note);
      await notify('경고', `<b>돌파매매 다음날시가 폴백 보류 — 수동확인 필요</b>\n${name}(${code}) — ${priorCheck.note}\n중복매수 위험이 있어 자동 발주하지 않았습니다. KIS 앱에서 직접 확인해 주세요.`);
      continue;
    }

    let currentPrice;
    try {
      ({ price: currentPrice } = await getKrQuote({ token, appkey, appsecret, code }));
    } catch (e) {
      console.log(`  ⚠️ 현재가 조회 실패(${e.message}) — 이번 실행은 건너뜀(다음 실행에서 재시도, 파일 그대로 pending 유지)`);
      await notify('경고', `<b>돌파매매 다음날시가 폴백 — 현재가 조회 실패</b>\n${name}(${code}) 현재가를 못 가져와(${e.message}) 이번 실행은 건너뜁니다. 다음 실행에서 재시도됩니다.`);
      continue;
    }

    const budget = Math.min(investedWon, remainingCash);
    const quantity = Math.floor(budget / currentPrice);
    if (!(quantity > 0)) {
      const reason = budget < investedWon
        ? `가용 예수금(${won(remainingCash)}) 부족으로 예산이 축소됨`
        : `투입예산(${won(investedWon)}) < 현재가(${won(currentPrice)})`;
      console.log(`  ℹ️ 산정 수량 0(${reason}) — 처리완료로 표시하고 스킵`);
      writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
        status: PENDING_ENTRY_STATUS.FAILED, reason, updatedAt: new Date().toISOString(),
      }));
      await notify('스킵', `<b>돌파매매 다음날시가 폴백 스킵</b>\n${name}(${code}) — ${reason}, 매수 안 함.`);
      continue;
    }

    // 접수 직전에 먼저 'placing'으로 기록 — 접수 성공 직후 크래시해도(코드리뷰 MEDIUM
    // 지적) 재실행 시 findUnprocessedPendingEntries가 'pending'만 골라내므로 이 항목은
    // 자동으로 다시 시도되지 않는다(안전 쪽으로 정지, 수동확인).
    writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
      status: PENDING_ENTRY_STATUS.PLACING, updatedAt: new Date().toISOString(),
    }));

    let order;
    try {
      order = await placeKrOrder({
        token, appkey, appsecret, cano, acntPrdtCd, code, side: '매수', quantity, marketOrder: true,
      });
    } catch (e) {
      // confirmedNotSent=true(확실히 미접수)일 때만 failed로 확정 — 그 외(응답불명)는
      // 실제로 접수됐을 수 있으니 uncertain으로 남겨 수동확인을 요구한다(위와 동일 원칙).
      const status = e.confirmedNotSent === true ? PENDING_ENTRY_STATUS.FAILED : PENDING_ENTRY_STATUS.UNCERTAIN;
      const reason = e.confirmedNotSent === true
        ? `시장가 주문 거부 확인됨: ${e.message}`
        : `시장가 주문 응답 불명(${e.message}) — 실제로는 접수됐을 수 있음`;
      console.log(`  ❌ 시장가 주문 실패(${reason})`);
      writeAtomic(join(dir, filename), updatePendingEntryRecord(content, { status, reason, updatedAt: new Date().toISOString() }));
      await notify('경고', `<b>돌파매매 다음날시가 폴백 실패</b>\n${name}(${code}) ${quantity}주 시장가 매수 — ${reason}. 수동 확인 바랍니다.`);
      continue;
    }

    remainingCash -= budget;
    console.log(`  ✅ 시장가 매수 접수 — 주문번호 ${order.orderNo}`);
    writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
      status: PENDING_ENTRY_STATUS.PLACED, updatedAt: new Date().toISOString(),
    }));

    // entry-date는 신호일(signalDate)이 아니라 오늘(실제 체결 시도일) — 포지션의
    // entryDate는 "실제로 진입한 날"이어야 트레일링스탑 기산일이 맞다.
    // 이 다리는 더 이상의 폴백이 없다 — --fallback 없이 호출(미체결 시 통상 타임아웃 알림).
    const child = spawn('node', [
      join(here, '..', 'tools', 'watch-breakout-entry-fill.mjs'),
      `--order-no=${order.orderNo}`, `--code=${code}`, `--name=${name}`, `--entry-date=${todayKST()}`,
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => {
      console.error(`  ⚠️ 체결감시 기동 실패(주문 자체는 이미 접수됨): ${e.message}`);
      notify('경고', `<b>🚨 체결감시 기동 실패 — 무방비 포지션 위험</b>\n${name}(${code}) ${quantity}주 시장가 매수(주문번호 ${order.orderNo})는 접수됐지만 체결감시를 못 띄웠습니다. 즉시 KIS 앱에서 확인해 주세요.`);
    });
    child.unref();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await notify('경고', `<b>돌파매매 다음날시가 폴백 잡 예외 종료</b>\n예상 못 한 오류로 중단됐습니다: ${e.message}`);
    process.exit(1);
  });
}
