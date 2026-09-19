#!/usr/bin/env node
// watch-breakout-entry-fill.mjs — 돌파매매 전략(퀀트 트랙) 매수 주문의 체결을
// 확인하고, 전량체결되면 포지션 상태를 만들고 손절+3R부분익절 보호주문을 즉시
// 자동으로 건다(2026-09-13, 오너 확정 — 보호주문은 매수 승인 하나로 충분, 별도
// 텔레그램 승인 불필요. Log/Strategy/2026-09-13-퀀트트랙-돌파매매전략-설계 참고).
//
// watch-order-fill.mjs(범용 체결감시)와 별도 파일인 이유: 그건 매수/매도 어느
// 쪽에도 쓰이는 일반 도구라 돌파매매 전용 후속조치(포지션 생성+보호주문)를
// 거기 끼워넣으면 관심사가 섞인다 — checkOrderFill·Ledger 기록 같은 재사용 가능한
// 부분은 그대로 가져오되, 이 파일은 "매수 체결 후 무엇을 더 할지"에만 집중한다.
//
// 진입 체결방식 "장후시간외 우선+다음날시가 폴백"(오너 확정, 2026-09-13, 아래 §
// 참고) 지원 — `--fallback=nextDayOpen --invested-won=<원>`을 넘기면, 타임아웃까지
// 아예 체결이 없었을 때(filledQty===0) 알림만 보내고 끝내는 대신 State/
// BreakoutPendingEntries에 대기 레코드를 남겨 place-breakout-fallback-entry.mjs
// (시가 근처 실행)가 다음날 시가로 이어 시도하게 한다. 부분체결(filledQty>0인데
// 전량은 아닌 경우)은 자동 폴백 대상이 아니다 — 이미 일부 보유 중인 상태에서 다음날
// 또 얼마를 사야 할지는 기계적으로 정할 수 없어(중복매수 위험) 수동확인 알림으로
// 넘긴다. fallback 옵션이 없으면(이 스크립트가 폴백 다리(다음날 시가) 자체의
// 체결감시로 쓰일 때 등) 기존과 완전히 동일하게 동작 — 그 다리는 더 이상 폴백이
// 없는 마지막 시도라 타임아웃 알림이 그대로 맞다.
//
// 사용법:
//   node scripts/tools/watch-breakout-entry-fill.mjs --order-no=6693100 --code=005930 --name=삼성전자 --entry-date=2026-09-14
//   node scripts/tools/watch-breakout-entry-fill.mjs --order-no=... --code=... --entry-date=... --fallback=nextDayOpen --invested-won=10000000
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadKisCredentials, loadQuantAccount, getKisToken, checkOrderFill, placeKrOrder,
} from '../lib/kis.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { QUANT_TRACK_LABEL } from '../lib/account-resolver.mjs';
import { buildBreakoutPositionRecord, updateBreakoutPositionRecord } from '../lib/breakout-position-vault.mjs';
import { buildPendingEntryRecord } from '../lib/breakout-pending-entry-vault.mjs';
import { computeProtectionOrders, ensurePositionProtected } from '../lib/breakout-protection.mjs';
import { STOP_LOSS_PCT } from '../lib/breakout-risk.mjs';

const BROKER = '한국투자증권';
const DEPARTMENT_LABEL = '운영실 Hermes'; // watch-order-fill.mjs와 동일 원칙 — 순수 API조회 결과 전달, 부서 판단 없음

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const won = (n) => (n == null ? '확인 필요' : Math.round(n).toLocaleString('ko-KR') + '원');

// 타임아웃 시점의 최종 판단 — 순수함수로 분리(코드리뷰 CRITICAL 지적, 2026-09-13:
// "체결 여부를 모름"(마지막 조회 자체가 실패, resultKnown=false)과 "0주 체결이
// 확정됨"(정상 조회됐는데 filledQty===0)을 뭉개면, 사실은 체결됐는데 확인만
// 실패한 경우에도 다음날시가 폴백이 걸려 ①이미 있는 포지션 위에 중복매수 ②원래
// 체결분은 보호주문(손절/3R익절) 없이 무방비로 방치되는 사고로 이어진다. 반드시
// "확인 자체가 실패"를 별도 케이스로 먼저 걸러낸다.
export function decideEntryOutcome({ fallbackEnabled, resultKnown, filledQty }) {
  if (!resultKnown) {
    return { action: 'manualReview', reason: '체결상태 확인 자체가 실패(마지막 조회 오류) — 체결 여부를 알 수 없음, 폴백 금지' };
  }
  if (filledQty > 0) {
    return { action: 'manualReview', reason: `일부(${filledQty}주)만 체결된 상태 — 자동 폴백 대상 아님(중복매수 위험), 잔여 수량 처리를 직접 판단 필요` };
  }
  if (fallbackEnabled) return { action: 'queueFallback', reason: null };
  return { action: 'manualReview', reason: '확인 시간 내 전량체결 미확인' };
}

function buildProtectionMessage({ name, code, entryPrice, quantity, protection, stopLossPct = STOP_LOSS_PCT }) {
  const stopPct = (stopLossPct * 100).toFixed(0);
  if (protection.protectionStatus === 'protected') {
    const lines = [`<b>매수 체결 + 보호주문 완료</b>`, `${name}(${code}) ${quantity}주 @${won(entryPrice)}`];
    lines.push(`손절(-${stopPct}%) 주문번호 ${protection.stopOrderNo}`);
    lines.push(protection.profitOrderNo ? `3R 부분익절 주문번호 ${protection.profitOrderNo}` : '부분익절: 수량 부족으로 해당없음');
    return lines.join('\n');
  }
  // 애매한 실패(confirmedNotSent 없음 — 실제로는 접수됐을 수 있음)는 "재시도 소진 후
  // 확실히 실패"와 다른 문구를 쓴다(코드리뷰 HIGH 지적 — 재시도를 멈춘 건 이중주문을
  // 막기 위해서지 실패가 확정돼서가 아니다. KIS 체결내역과 직접 대조해야 확실해짐).
  const ambiguousNote = protection.stopAmbiguous || protection.profitAmbiguous
    ? `\n⚠️ 응답 불명 상태로 재시도를 중단한 다리가 있습니다(손절=${protection.stopAmbiguous ? '불명' : '정상시도'}, 부분익절=${protection.profitAmbiguous ? '불명' : '정상시도'}) — 실제로는 이미 주문이 접수됐을 수 있으니, 한 번 더 걸기 전에 반드시 KIS 앱에서 먼저 확인하세요(중복주문 위험).`
    : '';
  return [
    `<b>⚠️ 보호주문 실패 — 즉시 확인 필요</b>`,
    `${name}(${code}) ${quantity}주 @${won(entryPrice)}는 매수 체결됐지만,`,
    `손절/부분익절 주문이 ${protection.attempts}회 시도 후에도 안 걸렸습니다.`,
    `손절걸림=${protection.stopOrderNo ? 'O' : 'X'}, 부분익절걸림=${protection.profitOrderNo ? 'O' : (protection.profitOrderApplicable === false ? '해당없음' : 'X')}`,
    `포지션이 무방비 상태일 수 있습니다 — KIS 앱에서 직접 확인·수동 손절 검토 바랍니다.${ambiguousNote}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orderNo = args['order-no'];
  const orgNo = args['org-no'] || null; // 취소시도용(2026-09-19) — 없으면(과거 호출부 등) 그냥 취소시도를 스킵
  const code = args.code || '';
  const name = args.name || code;
  const entryDate = args['entry-date'];
  const timeoutArg = Number(args.timeout);
  const timeoutMin = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : 30;
  const fallback = args.fallback === 'nextDayOpen' ? 'nextDayOpen' : null;
  const investedWonArg = Number(args['invested-won']);
  const investedWon = Number.isFinite(investedWonArg) && investedWonArg > 0 ? investedWonArg : null;
  // ATR 가변손절(2026-09-19 실전배선) — 신호 시점(daily-breakout-signal-scan.mjs)에
  // 확정된 값을 그대로 물려받는다. 없거나 형식이 이상하면(과거 호출부·수동 테스트
  // 등) 기존 고정값 STOP_LOSS_PCT로 안전하게 폴백 — 조용히 다른 값을 추정하지 않음.
  // 타당범위 검사(코드리뷰 LOW 지적, place-breakout-entry-order.mjs와 동일 이유) —
  // >0만 보면 비율 대신 퍼센트 단위(4 vs 0.04)가 그대로 통과해 음수 손절가로
  // 이어질 수 있다.
  const stopLossPctArg = Number(args['stop-loss-pct']);
  const stopLossPct = Number.isFinite(stopLossPctArg) && stopLossPctArg > 0 && stopLossPctArg < 0.5 ? stopLossPctArg : STOP_LOSS_PCT;

  if (!orderNo) { console.error('❌ --order-no 필요'); process.exit(2); }
  if (!code) { console.error('❌ --code 필요'); process.exit(2); }
  if (!entryDate) { console.error('❌ --entry-date 필요(포지션 레코드 id에 사용)'); process.exit(2); }
  if (fallback && !investedWon) { console.error('❌ --fallback=nextDayOpen을 쓰려면 --invested-won도 필요(폴백 주문 규모 산정용)'); process.exit(2); }
  // orgNo 없으면 취소시도 기능이 이 대기항목에 한해 조용히 꺼진다(에러는 아님, 정상
  // 폴백 흐름은 그대로 진행) — 하지만 아무 로그도 없으면 왜 항상 uncertain으로만
  // 빠지는지 원인을 못 찾는다(2026-09-19 코드리뷰 MEDIUM 지적, "silently disabled
  // feature is visible in the job log").
  if (fallback && !orgNo) {
    console.warn('⚠️ --org-no 없음 — 이 대기항목은 다음날 폴백 시 전날주문 취소시도를 못 함(holdings 교차검증 경로만 적용됨)');
  }

  mkdirSync(VAULT_PATHS.facts.ledger.executions, { recursive: true });
  mkdirSync(VAULT_PATHS.state.breakoutPositions, { recursive: true });
  if (fallback) mkdirSync(VAULT_PATHS.state.breakoutPendingEntries, { recursive: true });

  const quant = loadQuantAccount();
  if (!quant) { console.error('❌ 퀀트 계좌정보(quantAccount) 미설정'); process.exit(1); }
  const { appkey, appsecret } = loadKisCredentials();

  async function pollOnce() {
    const token = await getKisToken({ appkey, appsecret });
    return checkOrderFill({
      token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd, odno: orderNo,
    });
  }

  // 매수 체결 확정 후 포지션 생성+보호주문 자동 발주(오너 확정, 별도 승인 불필요).
  async function protectAfterFill(filledQty, avgFillPrice) {
    const { profitOrder } = computeProtectionOrders(avgFillPrice, filledQty, stopLossPct);
    const stopPrice = avgFillPrice * (1 - stopLossPct);
    const { id, filename, content } = buildBreakoutPositionRecord({
      code, name, entryDate, entryPrice: avgFillPrice, quantity: filledQty,
      investedWon: avgFillPrice * filledQty, stopPrice, stopLossPct, profitOrderApplicable: profitOrder != null,
    });
    const filePath = join(VAULT_PATHS.state.breakoutPositions, filename);
    writeAtomic(filePath, content);
    console.log(`[포지션 생성] ${id}`);

    const position = { entryPrice: avgFillPrice, quantity: filledQty, stopPrice, stopLossPct, stopOrderNo: null, stopOrderOrgNo: null, profitOrderNo: null, profitOrderOrgNo: null, profitOrderApplicable: profitOrder != null };
    // 재시도 사이 토큰이 만료될 수 있어(1일 유효지만 이 잡이 오래 걸릴 이유는 없음에도
    // 방어적으로) 매 시도마다 getKisToken을 다시 호출 — 캐시가 있어 실제 재발급은
    // 거의 안 일어남(kis.mjs getKisToken 헤더 주석 참고).
    const placeOrder = async (params) => placeKrOrder({
      token: await getKisToken({ appkey, appsecret }),
      appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd, code, ...params,
    });
    const protection = await ensurePositionProtected(position, { placeOrder });

    const updated = updateBreakoutPositionRecord(content, {
      stopOrderNo: protection.stopOrderNo, stopOrderOrgNo: protection.stopOrderOrgNo,
      profitOrderNo: protection.profitOrderNo, profitOrderOrgNo: protection.profitOrderOrgNo,
      protectionStatus: protection.protectionStatus, updatedAt: new Date().toISOString(),
    });
    writeAtomic(filePath, updated);
    console.log(`[보호주문] ${protection.protectionStatus}(시도 ${protection.attempts}회)`);

    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL,
      tag: protection.protectionStatus === 'protected' ? '완료' : '경고',
      body: buildProtectionMessage({ name, code, entryPrice: avgFillPrice, quantity: filledQty, stopLossPct, protection: { ...protection, profitOrderApplicable: profitOrder != null } }),
    }));
  }

  // done=true면 더 감시할 필요 없음(취소 확정·전량체결 처리 완료). lastResult는
  // 타임아웃 시(done=false로 끝났을 때) 마지막으로 확인한 체결 상태를 main()이
  // 폴백 여부 판단에 쓸 수 있도록 그대로 넘겨준다.
  async function checkAndReportIfDone() {
    let result;
    try {
      result = await pollOnce();
    } catch (e) {
      console.error(`[조회 실패] ${e.message}`);
      return { done: false, result: null };
    }
    if (result?.canceled) {
      console.log('[취소 확인] 매수 주문이 취소됨 — 포지션 생성 안 함');
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL, tag: '취소',
        body: `<b>돌파매매 매수 주문 취소 확인</b>\n${name}(${code}) 주문번호 ${orderNo} — 취소되었습니다.`,
      }));
      return { done: true, result };
    }
    if (result?.fullyFilled) {
      console.log(`[체결 확인] 전량 체결 — 평균단가 ${result.avgFillPrice}원`);
      if (result.avgFillPrice == null) {
        console.error('[중단] avgFillPrice 없음 — 보호주문 계산 불가, 수동 확인 필요');
        await sendTelegram(formatDepartmentMessage({
          departmentLabel: DEPARTMENT_LABEL, tag: '경고',
          body: `<b>⚠️ 돌파매매 매수 체결됐으나 평균단가 확인 불가</b>\n${name}(${code}) 주문번호 ${orderNo} — 보호주문을 자동으로 못 걸었습니다. 즉시 수동 확인 바랍니다.`,
        }));
        return { done: true, result };
      }
      const { filename, content, dir } = buildExecutionRecord({
        tradeDate: new Date().toISOString(), tradeType: '매수', stockCode: code, stockName: name,
        quantity: result.filledQty, price: result.avgFillPrice, currency: 'KRW', broker: BROKER, account: QUANT_TRACK_LABEL,
      });
      writeAtomic(join(dir, filename), content);
      await protectAfterFill(result.filledQty, result.avgFillPrice);
      return { done: true, result };
    }
    console.log(result && result.filledQty > 0 ? `[부분체결] ${result.filledQty}/${result.orderQty}주 — 계속 감시` : '[미체결] 계속 감시');
    return { done: false, result };
  }

  console.log(`[감시 시작] 돌파매매 매수 주문번호 ${orderNo}(${name}) 체결 확인 — 최대 ${timeoutMin}분`);
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let last = { done: false, result: null };
  while (Date.now() < deadline) {
    last = await checkAndReportIfDone();
    if (last.done) return;
    await sleep(60 * 1000);
  }
  last = await checkAndReportIfDone();
  if (last.done) return;

  const decision = decideEntryOutcome({
    fallbackEnabled: !!fallback, resultKnown: last.result != null, filledQty: last.result?.filledQty ?? 0,
  });

  if (decision.action === 'queueFallback') {
    // 장후시간외 세션(15:40~16:00 KRX) 안에 전혀 체결이 안 된 것으로 "확인된"(모름이
    // 아님) 경우 — KRX 당일유효 세션 주문은 세션 종료 시 자동 실효된다고 가정
    // (2026-09-13 기준 미검증, 실전 첫 실행 때 KIS 체결내역으로 실제로 사라지는지
    // 확인 필요 — Knowledge/API/KIS.md 참고). 별도 취소 호출 없이 다음날 시가
    // 폴백을 큐잉만 한다.
    console.log('[장후시간외 미체결] 다음날 시가 폴백 큐잉');
    const { id, filename, content } = buildPendingEntryRecord({
      code, name, signalDate: entryDate, investedWon, afterHoursOrderNo: orderNo,
      afterHoursOrgNo: orgNo, afterHoursOrderQty: last.result?.orderQty ?? null, stopLossPct,
      reason: `장후시간외 세션 내 미체결(${timeoutMin}분 감시)`,
    });
    writeAtomic(join(VAULT_PATHS.state.breakoutPendingEntries, filename), content);
    console.log(`[대기열 등록] ${id}`);
    await sendTelegram(formatDepartmentMessage({
      departmentLabel: DEPARTMENT_LABEL, tag: '전환',
      body: `<b>장후시간외 미체결 — 다음날 시가로 자동 전환 예정</b>\n${name}(${code}) 주문번호 ${orderNo}\n` +
        `장후시간외 세션 안에 체결되지 않아 자동 취소(가정)됐습니다. 다음 거래일 시가에 약 ${won(investedWon)}어치 매수를 자동으로 다시 시도합니다.`,
    }));
    return;
  }

  console.log(`[타임아웃] ${decision.reason} — 알림 발송`);
  await sendTelegram(formatDepartmentMessage({
    departmentLabel: DEPARTMENT_LABEL, tag: '경고',
    body: `<b>돌파매매 매수 체결 확인 시간 초과</b>\n${name}(${code}) 주문번호 ${orderNo}\n` +
      `${decision.reason} — KIS 앱에서 직접 확인해 주세요.`,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
