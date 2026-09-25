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
// ✅ 자동실효 가정 검증 완료(2026-09-22, 실전 첫 실행 — SK텔레콤 017670 테스트
// 주문) — 가정 자체는 맞았다: 세션 종료 후 KIS 체결조회 응답이 cncl_yn:""(빈
// 문자열, 'Y' 아님)·tot_ccld_qty:"0"·rmn_qty:"0"·rjct_qty:"1"(주문수량 전체)로
// 왔다. 다만 그때까지 코드가 "voided"로 인정하는 신호가 cncl_yn==='Y'뿐이라 이
// 패턴을 못 알아보고 'unfilled'로 오분류 → 이미 죽은 주문에 취소를 또 시도 →
// KIS가 거부 → uncertain에 갇혀 폴백이 하루 지연됐다. classifyPriorOrderStatus에
// remainingQty===0·filledQty===0 분기(rejectedOrExpired)를 추가해 해소 — 상세는
// 그 함수 헤더 주석 참고.
//
// launchd 배선: 평일 09:03 KST(com.banana2.place-breakout-fallback-entry.plist,
// 2026-09-18 — 오너의 "카이로스 자동거래 승인" 지시로 상시 가동. 2026-09-16 세션크론
// 1회 실행에서 안전장치(classifyPriorOrderStatus, 이중매수 방지)가 실제로 정상
// 작동함을 확인한 뒤 상시 배선으로 전환. 킬스위치(State/KillSwitch)도 같은 턴에
// 이 파일 주문 직전 지점에 연결됨, 아래 confirmPriorOrderVoided 다음 참고).
//
// 사용법: node scripts/jobs/place-breakout-fallback-entry.mjs   # 장 시작 직후(09:00~09:05 KST) 실행 전제
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadQuantAccount, getKisToken, getKrQuote, getAccountBalance, checkOrderFill, placeKrOrder, reviseKrOrder,
} from '../lib/kis.mjs';
import { isKillSwitchActive } from '../lib/kill-switch.mjs';
import { readKrxTradingDayStatus } from '../lib/krx-trading-calendar.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram, escapeHtml } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import {
  parsePendingEntry, updatePendingEntryRecord, findUnprocessedPendingEntries, isPendingEntryStale, PENDING_ENTRY_STATUS,
} from '../lib/breakout-pending-entry-vault.mjs';
import { parseBreakoutPosition, findOpenPositions } from '../lib/breakout-position-vault.mjs';
import { MAX_CONCURRENT_POSITIONS, STOP_LOSS_PCT } from '../lib/breakout-risk.mjs';

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

// watch-breakout-entry-fill.mjs 자식 프로세스에 넘길 CLI 인자(폴백 다리 — --fallback
// 없이 호출, place-breakout-entry-order.mjs의 buildWatchArgs와 동일 이유로 순수함수
// 분리: 2026-09-19 코드리뷰 CRITICAL 지적 재발방지 — stopLossPct 플러밍이 조용히
// 무력화돼도(예: entryStopLossPct가 undefined인데 아무도 못 알아챔) npm test가 계속
// 초록이면 안 된다). stopLossPct 없으면(과거 대기항목 레코드) STOP_LOSS_PCT로 폴백 —
// 4%로 사이징(2배 투입)된 포지션에 8% 손절이 걸리는 CRITICAL 사고 재발방지가
// 이 함수를 만든 이유이므로, 이 폴백 자체가 회귀하지 않게 테스트로 고정한다.
export function buildFallbackWatchArgs({ order, code, name, entryDate, stopLossPct }) {
  const resolvedStopLossPct = stopLossPct ?? STOP_LOSS_PCT;
  return [
    `--order-no=${order.orderNo}`, `--code=${code}`, `--name=${name}`, `--entry-date=${entryDate}`,
    `--stop-loss-pct=${resolvedStopLossPct}`,
  ];
}

// Pending Entry는 placed 뒤에도 출처 추적을 위해 보존한다. Position의 파일 ID는
// {code}-{entryDate}이므로, 실제 진입 시도일을 한 번만 계산해 감시 인자와 이 링크가
// 반드시 같은 Position을 가리키게 한다. placed는 주문 접수 상태라 아직 체결·Position
// 생성이 보장되지는 않으므로, 필드명도 결과가 아니라 체결 시 생성될 예정 ID임을 밝힌다.
export function buildPlacedPendingEntryUpdate({ code, entryDate, cancelReason = '', updatedAt }) {
  return {
    status: PENDING_ENTRY_STATUS.PLACED,
    expectedPositionId: `${code}-${entryDate}`,
    ...(cancelReason ? { reason: cancelReason } : {}),
    updatedAt,
  };
}

// place-breakout-entry-order.mjs와 동일 패턴(ENOENT만 "꺼짐", 그 외 읽기 오류는
// 안전한 쪽인 "활성"으로 — 2026-09-18 코드리뷰 MEDIUM, 승인 없는 완전자동 경로라
// execute-quant-proposal.mjs류의 전역 fail-open 기본값을 그대로 물려받지 않는다).
function readKillSwitchState(filepath) {
  try {
    return { content: readFileSync(filepath, 'utf8'), readFailed: false };
  } catch (e) {
    if (e.code === 'ENOENT') return { content: null, readFailed: false };
    return { content: null, readFailed: true, error: e };
  }
}

function markUncertain(dir, filename, content, reason) {
  writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
    status: PENDING_ENTRY_STATUS.UNCERTAIN, reason, updatedAt: new Date().toISOString(),
  }));
}

// daily-breakout-signal-scan.mjs의 loadOpenPositionCodes()와 동일 패턴 — 2026-09-18
// 코드리뷰 MEDIUM 지적: 이 잡은 지금까지 슬롯(MAX_CONCURRENT_POSITIONS)을 전혀
// 확인하지 않고 예수금만 보고 순차 발주했다. 신호스캔은 슬롯을 체크하는데 이 잡만
// 빠져 있으면, 대기 여러 건이 한꺼번에 풀릴 때(킬스위치 장기 활성 후 해제 등)
// 보유종목 상한을 조용히 넘길 수 있다.
function loadOpenPositionCount() {
  const dir = VAULT_PATHS.state.breakoutPositions;
  if (!existsSync(dir)) return 0;
  const contents = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8'));
  return findOpenPositions(contents.map((c) => parseBreakoutPosition(c))).length;
}

// 순수함수로 분리(테스트 가능하게, 코드리뷰 지적과 동일한 원칙 — decideEntryOutcome
// 참고) — checkOrderFill의 결과(또는 null/예외)만 보고 "확실히 취소/실효됐다"고
// 안전하게 판단할 수 있는지 분류한다. 애매하면 전부 voided=false(폴백 보류) 쪽으로.
// ⚠️ rejectedOrExpired 분기 추가(2026-09-22, 실전 첫 실행 라이브 데이터로 발견) —
// 헤더(:10-16)가 명시한 "장후시간외 미체결 주문은 세션 종료 시 자동실효된다"는
// 가정을 검증할 첫 실제 사례(SK텔레콤 017670, 2026-09-21 장후시간외 1주 매수
// 시도)에서, KIS 체결조회(TTTC0081R) 원본 응답이 cncl_yn:""(빈 문자열, 'Y' 아님)
// ·tot_ccld_qty:"0"·rmn_qty:"0"·rjct_qty:"1"(=주문수량 전체)로 왔다 — 즉 자동실효
// 가정 자체는 맞았지만(주문이 실제로 죽어있음), 이 코드가 "voided"로 인정하는
// 유일한 신호가 cncl_yn==='Y'뿐이라 못 잡았다. remainingQty(rmn_qty)가 0인데
// filledQty도 0이면(체결 0에 잔여수량도 0) 그 수량이 갈 곳은 거부/실효뿐이다 —
// 체결됐으면 filledQty>0, 아직 살아있으면 remainingQty>0이어야 하므로(기존
// kis.test.js 라이브 계약 — 부분체결 rmn_qty:'7'·완전미체결 rmn_qty:'10' 케이스
// 참고, 둘 다 remainingQty>0). 이 신호를 몰라서 이 잡이 이미 죽은 주문에 대해
// attemptCancelPriorOrder(실제 KIS 취소요청)를 또 시도했고, "취소가능수량 없음"류
// 사유로 그 취소 요청 자체가 실패해 uncertain에 갇혔다(오늘 아침 실사고 — SK텔레콤
// 폴백이 진행 안 됨). cncl_yn 체크보다 먼저 두지 않는 이유: 명시적 canceled 판정이
// 더 강한 증거라 우선순위를 유지한다.
export function classifyPriorOrderStatus(result) {
  if (result == null) return { voided: false, kind: 'no_result', note: '전날 주문 조회 결과 없음(응답에 해당 주문 없음) — 생사 확인 불가, 추정 안 함' };
  if (result.canceled) return { voided: true, kind: 'canceled', note: '전날 주문이 취소/실효 상태로 확인됨' };
  if (result.fullyFilled) return { voided: false, kind: 'fullyFilled', note: `전날 주문이 실제로는 전량체결(${result.avgFillPrice}원)된 것으로 확인됨 — 폴백 대상 아님, 이미 포지션이 있을 수 있음` };
  if (result.filledQty > 0) return { voided: false, kind: 'partial', note: `전날 주문이 일부(${result.filledQty}주) 체결된 것으로 확인됨 — 잔여수량 처리 불명확, 자동폴백 대상 아님` };
  if (result.filledQty === 0 && result.remainingQty === 0) {
    return { voided: true, kind: 'rejectedOrExpired', note: '전날 주문이 거부되었거나 장후시간외 세션 종료로 자동실효된 것으로 확인됨(체결 0주·잔여수량 0) — 취소시도 없이 폴백 진행' };
  }
  return { voided: false, kind: 'unfilled', note: '전날 주문이 아직 미체결 상태로 남아있는 것으로 확인됨(자동실효 가정이 틀렸을 가능성) — 폴백 보류' };
}

// holdings 교차검증 대상 — no_result(당일 주문 조회에 아예 안 잡힘)만 해당된다.
// ⚠️ unfilled는 의도적으로 제외(2026-09-19 코드리뷰 HIGH 지적) — checkOrderFill이
// 이미 filledQty=0(미체결)이라고 직접 말해준 상태라, holdings에 없다는 사실이
// 거기 더할 새 정보가 없다. "아직 체결 안 됨"과 "주문 자체가 (자동실효 등으로)
// 죽었음"은 서로 다른 명제이고, 이 파일 헤더(:10-16)가 명시하듯 "장후시간외
// 미체결 주문이 세션 종료 시 자동실효된다"는 가정은 여전히 검증되지 않았다.
// 그 가정이 틀렸다면 전날 주문이 지금도 살아있을 수 있고, holdings만으로
// voided=true로 승격시키면 이 안전장치가 막으려던 바로 그 이중매수 시나리오
// (죽지 않은 주문 위에 새 시장가 주문을 얹음)를 열어버린다. no_result는
// 사정이 다르다 — 당일 주문 목록에 아예 안 잡히는 상태라 holdings 부재와
// 결합했을 때 훨씬 방어 가능한 추론이 된다.
const HOLDINGS_CROSSCHECK_KINDS = new Set(['no_result']);
export function needsHoldingsCrossCheck(classification) {
  return HOLDINGS_CROSSCHECK_KINDS.has(classification.kind);
}

// 종목코드 비교 정규화 — 프론트매터 왕복·업스트림 인자 파싱 경로가 문자열/숫자 중
// 어느 쪽으로도 code를 줄 수 있고, 선행 0(예: "005930")이 숫자로 변환되면 소실될 수
// 있다(코드리뷰 LOW 지적). 정규화 없이 엄격 비교하면 형 불일치 시 "보유 없음"으로
// 조용히 오판해 실주문으로 이어질 수 있어, 6자리 0패딩 문자열로 맞춰 비교한다.
const normalizeCode = (c) => String(c ?? '').trim().padStart(6, '0');

// checkOrderFill 응답만으로는 애매한 경우(주문 자체를 못 찾음)에 한해, 실제 계좌
// 보유종목(getAccountBalance의 holdings)을 교차검증 증거로 추가한다. 2026-09-19
// 오너 지적 — 이 잡은 예수금 사이징을 위해 이미 getAccountBalance를 호출하면서도
// 같이 반환되는 holdings는 버리고 있었다. "그 종목이 실제 계좌에 없다"는 사실
// 자체가 "주문이 살아있지 않다"는 직접증거가 되는 no_result 케이스에 한해서만
// 활용한다(055550/신한지주 건 재발 방지 — 단, 그 건은 실제로는 unfilled였으므로
// 이 최소수정으로는 자동 해소되지 않는다, 아래 needsHoldingsCrossCheck 주석 참고).
// holdings가 배열이 아니면(응답 파싱 실패·필드명 변경 등, 코드리뷰 HIGH 지적) 그
// 자체를 "보유 없음"의 증거로 쓰지 않고 원래 판정을 그대로 유지한다.
export function refineWithHoldings(classification, code, holdings) {
  if (!needsHoldingsCrossCheck(classification)) return classification;
  if (!Array.isArray(holdings)) return classification;
  const held = holdings.find((h) => normalizeCode(h.code) === normalizeCode(code) && h.qty > 0);
  if (held) {
    return {
      voided: false,
      kind: classification.kind,
      note: `${classification.note} — 단, 계좌 보유종목 조회에서 실제 보유 확인됨(${held.qty}주, 교차검증) — 체결됐을 가능성 높음, 수동확인 필요`,
    };
  }
  return {
    voided: true,
    kind: classification.kind,
    note: `${classification.note} — 계좌 보유종목 조회 결과 실제 보유 없음(교차검증) — 폴백 진행`,
  };
}

// 전날 주문의 생사를 가장 직접적으로 확인하는 방법 — 취소를 실제로 시도한다. 성공하면
// "방금까지 살아있던 주문을 우리가 지금 직접 죽였다"는 확정적 증거라 voided=true를
// 확신할 수 있다(checkOrderFill의 unfilled 분류만으로는 이 확신에 못 미쳤던 문제 —
// 2026-09-19 코드리뷰 HIGH 지적으로 holdings 단독승격 대상에서 unfilled를 뺀 뒤,
// unfilled 케이스가 다시 uncertain에 갇히는 걸 풀기 위해 도입).
//
// ⚠️ confirmPriorOrderVoided에서 반드시 classification.kind==='unfilled'가 이미
// 확인된 뒤에만 호출할 것(취소요청은 QTY_ALL_ORD_YN='Y'라 부분체결 잔량도 그대로
// 취소해버린다 — filledQty>0인 'partial' 케이스에 잘못 걸면 이미 체결된 수량 위에
// 잔량을 지우고 폴백 매수까지 겹쳐 이중매수+무보호 잔량이 남는다. 2026-09-19 코드리뷰
// HIGH 지적으로 read(checkOrderFill)→write(취소) 순서를 강제 — 예전엔 먼저 취소부터
// 시도해서 이 구분 자체가 없었다). 실패하면(이미 체결됐거나 이미 죽었거나 — KIS
// 응답만으론 어느 쪽인지 구분 안 함, reviseKrOrder 주석 참고) 추정하지 않고 원래
// classification을 그대로 반환한다 — 실패를 "이미 죽었다"로 해석하지 않는다는 점이
// 핵심(그렇게 해석하면 "이미 체결됨" 케이스에서 이중매수로 직행한다).
// orgNo·quantity 둘 다 있어야 시도한다(과거 레코드는 이 필드가 없어 자동 스킵 —
// 하위호환, breakout-pending-entry-vault.mjs 참고).
export async function attemptCancelPriorOrder({
  token, appkey, appsecret, cano, acntPrdtCd, orgNo, orderNo, quantity, reviseKrOrderImpl = reviseKrOrder,
}) {
  if (!orgNo || !(Number.isInteger(quantity) && quantity > 0)) return { attempted: false };
  try {
    // retries 축소(기본 2→1) — 코드리뷰 LOW 지적: 이 취소요청이 레이트리밋으로 재시도를
    // 소진하면, 같은 진입 처리 루프 안에서 뒤따르는 checkOrderFill·getAccountBalance
    // 호출까지 레이트리밋 구간으로 밀릴 수 있다(여러 대기항목을 연달아 처리하는 루프라
    // 누적 가능). 실패해도 아래에서 안전한 기존 경로로 그대로 넘어가므로 재시도 예산을
    // 아껴 뒤 단계에 양보하는 쪽이 전체 성공률에 낫다.
    const cancelResult = await reviseKrOrderImpl({
      token, appkey, appsecret, cano, acntPrdtCd, orgNo, orderNo, action: '취소', quantity, price: 0, retries: 1,
    });
    return { attempted: true, canceled: true, cancelOrderNo: cancelResult?.orderNo ?? null };
  } catch (e) {
    return { attempted: true, canceled: false, error: e };
  }
}

// 전날 장후시간외 주문의 생사를 확인 — "확실히 취소/실효됨"일 때만 true. 그 외(조회
// 실패·응답 없음·이미 체결됨·부분체결·미체결 등 애매한 모든 경우)는 일단 false로
// 안전하게 처리한다. read(checkOrderFill)를 항상 먼저 하고, 그 결과가 'unfilled'로
// 확정됐을 때만(그리고 allowCancel이 명시적으로 true일 때만 — 아래 참고)
// attemptCancelPriorOrder로 취소를 시도한다. 'no_result'는 needsHoldingsCrossCheck로
// holdings 교차검증. checkOrderFillImpl/getAccountBalanceImpl/reviseKrOrderImpl은
// 테스트 주입용(2026-09-19 코드리뷰 MEDIUM 지적 — 이 파일의 순수함수 분리 컨벤션을
// 이 래퍼도 따르도록, kis.mjs의 fetchImpl 패턴과 동일한 이유).
//
// ⚠️ allowCancel 기본값 false(2026-09-19 코드리뷰 CRITICAL 지적) — 예전엔 이 함수가
// 항상 취소를 시도했는데, main()의 킬스위치 체크가 이 함수 호출 "뒤"에 있어서
// 오너가 킬스위치를 켜놔도 이 함수가 실제 KIS 취소주문을 내버렸다(그 뒤에야 발주만
// 보류하고 취소는 이미 실행된 상태로 남음). 호출측이 킬스위치·슬롯·현재가·수량 같은
// 다른 모든 게이트를 전부 통과시킨 뒤에만 allowCancel:true로 명시적으로 호출하도록
// 강제 — 이 함수 내부에서 "언젠가 호출 순서가 맞겠지"에 기대지 않는다.
export async function confirmPriorOrderVoided({
  token, appkey, appsecret, cano, acntPrdtCd, code, afterHoursOrderNo, afterHoursOrgNo, afterHoursOrderQty, signalDate,
  allowCancel = false,
  checkOrderFillImpl = checkOrderFill, getAccountBalanceImpl = getAccountBalance, reviseKrOrderImpl = reviseKrOrder,
}) {
  if (!afterHoursOrderNo) return { voided: true, note: '전날 장후시간외 주문번호 자체가 없음(주문 자체가 실패했던 케이스)' };

  let result;
  try {
    result = await checkOrderFillImpl({
      token, appkey, appsecret, cano, acntPrdtCd, odno: afterHoursOrderNo, now: new Date(signalDate),
    });
  } catch (e) {
    return { voided: false, note: '전날 주문 상태 조회 실패 — 생사 확인 불가' };
  }
  const classification = classifyPriorOrderStatus(result);

  if (allowCancel && classification.kind === 'unfilled') {
    const cancelAttempt = await attemptCancelPriorOrder({
      token, appkey, appsecret, cano, acntPrdtCd, orgNo: afterHoursOrgNo, orderNo: afterHoursOrderNo, quantity: afterHoursOrderQty, reviseKrOrderImpl,
    });
    if (cancelAttempt.canceled) {
      // 취소요청 응답(rt_cd='0')이 "이미 적용 완료"인지 "접수만 되고 비동기 처리중"
      // 인지 이 프로젝트 기준 미검증(2026-09-19 코드리뷰 Open Question) — 추정하지
      // 않고 checkOrderFillImpl을 한 번 더 불러 실제로 canceled 상태가 됐는지
      // 재확인한다. 이 재조회는 부수적으로 레이스(취소 시도 사이 실제로 체결된 경우)
      // 도 잡아준다 — 재확인 결과가 canceled가 아니면(fullyFilled 포함) 그 최신
      // 분류를 그대로 반환해 원래의 checkOrderFill+holdings 안전장치를 그대로 태운다.
      // ⚠️ 미검증(2026-09-19 코드리뷰 검증패스 MEDIUM) — checkOrderFillImpl이
      // INQR_STRT_DT=INQR_END_DT=signalDate(전날)로 조회하는데, 오늘(T일) 실행한
      // 취소가 그 전날자 행의 cncl_yn을 실제로 'Y'로 갱신해 보여주는지 이 프로젝트
      // 기준 확인된 적 없다. KIS가 그 갱신을 반영 안 하면 이 재확인은 항상
      // kind==='unfilled'로 돌아와(안전한 방향 — voided:false로 uncertain에 남고
      // 이중매수는 안 남지만) "unfilled 자동해소"라는 이 기능의 목적 자체가 달성
      // 안 될 수 있다. 실전 첫 취소시도의 재확인 응답을 반드시 확인할 것.
      let recheckResult;
      try {
        recheckResult = await checkOrderFillImpl({
          token, appkey, appsecret, cano, acntPrdtCd, odno: afterHoursOrderNo, now: new Date(signalDate),
        });
      } catch (e) {
        return { voided: false, kind: 'unfilled', note: `${classification.note} — 취소 요청은 성공(rt_cd=0) 응답을 받았으나 재확인 조회 실패, 적용 여부 불확실해 자동진행 보류` };
      }
      const recheckClassification = classifyPriorOrderStatus(recheckResult);
      if (recheckClassification.kind === 'canceled') {
        return {
          voided: true, kind: 'canceledByUs', cancelOrderNo: cancelAttempt.cancelOrderNo,
          note: `전날 장후시간외 주문이 여전히 살아있어 이 잡이 직접 취소함(취소주문번호 ${cancelAttempt.cancelOrderNo ?? '확인불가'}) — 재조회로 취소 확정까지 확인, 폴백 진행`,
        };
      }
      return { ...recheckClassification, note: `${recheckClassification.note} — 취소 요청은 성공(rt_cd=0) 응답을 받았으나 재확인 조회에서 취소 확정이 안 보여 자동진행 보류(비동기 지연 가능성)` };
    }
    if (cancelAttempt.attempted) {
      // 실패 사유를 note에 남겨(코드리뷰 LOW 지적) uncertain 알림에 진단정보로 노출되게
      // 한다 — 지금까지는 error를 반환값에 담아두고 아무도 안 읽었다.
      return { ...classification, note: `${classification.note} — 취소시도 실패` };
    }
    return classification; // orgNo·quantity 없음(과거 레코드) — 시도 자체를 안 함, 원판정 그대로
  }

  if (!needsHoldingsCrossCheck(classification)) return classification;
  let holdings;
  try {
    ({ holdings } = await getAccountBalanceImpl({ token, appkey, appsecret, cano, acntPrdtCd }));
  } catch (e) {
    return { ...classification, note: `${classification.note} — 계좌 보유종목 교차검증 실패, 원래 판정 유지` };
  }
  return refineWithHoldings(classification, code, holdings);
}

async function main() {
  const calendar = readKrxTradingDayStatus();
  if (calendar.isOpen !== true) {
    console.log(`[건너뜀] ${calendar.date} KRX 개장일이 확인되지 않아 다음날시가 폴백을 실행하지 않음: ${calendar.reason || '휴장일'}`);
    return;
  }
  const dir = VAULT_PATHS.state.breakoutPendingEntries;
  mkdirSync(dir, { recursive: true });
  const all = loadPendingEntries(dir);
  const targets = findUnprocessedPendingEntries(all);
  if (!targets.length) { console.log('ℹ️ 다음날시가 폴백 대기 중인 항목 없음'); return; }

  // 슬롯 상한 체크(2026-09-18 코드리뷰 MEDIUM) — daily-breakout-signal-scan.mjs와
  // 동일하게 여기서도 확인. 이미 다 찼으면 이번 실행에서 아무것도 처리하지 않고
  // 그대로 둔다(상태 변경 없음 — 킬스위치 스킵과 동일 원칙, 슬롯이 열리면 다음
  // 실행에서 자동 재시도).
  let remainingSlots = MAX_CONCURRENT_POSITIONS - loadOpenPositionCount();
  if (remainingSlots <= 0) {
    console.log(`ℹ️ 슬롯이 이미 다 참(보유 ${MAX_CONCURRENT_POSITIONS}종목) — 대기 ${targets.length}건 처리 보류`);
    return;
  }

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
    await notify('경고', '<b>돌파매매 다음날시가 폴백 중단 — 예수금 조회 실패</b>\n예수금을 확인할 수 없어 이번 실행에서 모든 대기 항목 처리를 보류합니다. 다음 실행에서 재시도됩니다.');
    return;
  }
  if (remainingCash == null) {
    await notify('경고', '<b>돌파매매 다음날시가 폴백 중단 — 예수금 확인 불가</b>\n예수금이 0으로 추정되지 않아(조회 자체가 이상값) 이번 실행을 보류합니다.');
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  for (const entry of targets) {
    const { code, name, investedWon, afterHoursOrderNo, afterHoursOrgNo, afterHoursOrderQty, stopLossPct: entryStopLossPct, signalDate, filename, content } = entry;
    console.log(`[처리] ${entry.id} — ${name}(${code})`);

    // 나이 게이트(2026-09-18 코드리뷰 HIGH) — 킬스위치가 여러 날 켜져 있다가 꺼지면
    // 그 사이 쌓인 대기 항목이 신호일 가격·조건 재검증 없이 한꺼번에 시가 시장가로
    // 나갈 위험이 있다. 정상 운영(주말 포함)에서는 절대 안 걸리는 문턱(5일)이라
    // 이 체크가 발동한다는 것 자체가 이례적 상황임을 뜻한다 — 자동발주 대신
    // 수동확인으로 넘긴다.
    if (isPendingEntryStale(entry)) {
      console.log(`  ⚠️ 신호일(${signalDate})이 너무 오래됨 — 자동폴백 거부(expired)`);
      writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
        status: PENDING_ENTRY_STATUS.EXPIRED, reason: `신호일(${signalDate})로부터 시간이 많이 지나 조건 재검증 없이 자동발주하지 않음(킬스위치 장기 활성 등 이례적 상황 의심)`, updatedAt: new Date().toISOString(),
      }));
      await notify('경고', `<b>돌파매매 다음날시가 폴백 거부 — 신호일 만료</b>\n${name}(${code}) 신호일(${signalDate})이 너무 오래돼 자동발주하지 않았습니다. 지금도 매수하고 싶으면 조건을 다시 확인하고 수동으로 진행해 주세요.`);
      continue;
    }

    // 슬롯 상한(2026-09-18 코드리뷰 MEDIUM) — 루프 진입 전 한 번만 확인하면 이번
    // 실행에서 여러 건을 연달아 접수할 때 상한을 넘길 수 있어, 접수 성공마다
    // 차감해 매 건 재확인한다.
    if (remainingSlots <= 0) {
      console.log(`  ℹ️ 슬롯 소진 — ${name}(${code}) 처리 보류(대기 유지, 다음 실행 재시도)`);
      await notify('스킵', `<b>돌파매매 다음날시가 폴백 보류 — 슬롯 소진</b>\n${name}(${code}) — 이번 실행에서 보유종목 상한(${MAX_CONCURRENT_POSITIONS})에 도달해 처리하지 못했습니다. 다음 실행에서 재시도됩니다.`);
      continue;
    }

    // ⚠️ 2026-09-19 코드리뷰 CRITICAL 지적으로 순서 재배치 — confirmPriorOrderVoided가
    // "취소시도"(실제 KIS 주문취소, 되돌릴 수 없음)를 포함하게 되면서, 그 취소를
    // 굳이 안 냈어도 됐을 이유(현재가 조회 실패·수량 0·킬스위치 활성)들을 전부 먼저
    // 확인해야 한다 — 예전 순서(생사확인→현재가→수량→킬스위치)에선 킬스위치가 켜져
    // 있어도 그 앞의 생사확인이 이미 실제 취소를 내버릴 수 있었다. 아래 네 게이트를
    // 전부 통과한 뒤에만 취소를 허용(allowCancel:true)한다.
    let currentPrice;
    try {
      ({ price: currentPrice } = await getKrQuote({ token, appkey, appsecret, code }));
    } catch (e) {
      console.log(`  ⚠️ 현재가 조회 실패(${e.message}) — 이번 실행은 건너뜀(다음 실행에서 재시도, 파일 그대로 pending 유지)`);
      await notify('경고', `<b>돌파매매 다음날시가 폴백 — 현재가 조회 실패</b>\n${name}(${code}) 현재가를 못 가져와 이번 실행은 건너뜁니다. 다음 실행에서 재시도됩니다.`);
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

    // 킬스위치 — place-breakout-entry-order.mjs와 동일 원칙·동일 State 파일(전역
    // 공유, execute-quant-proposal.mjs 등과 동일). 오너 지시(2026-09-18) 대응. 여러
    // 건을 순차 처리하는 루프라 매 건마다 새로 읽는다(execute-quant-proposal.mjs가
    // 제안마다 다시 읽는 것과 동일 이유 — 처리 도중 오너가 스위치를 켤 수 있음).
    // 'pending' 상태를 그대로 유지해(마킹 안 함) 스위치 해제 후 다음 실행에서 자동
    // 재시도되게 한다 — 'uncertain'과 달리 사람 개입이 필요한 상황이 아니므로.
    // 아래 confirmPriorOrderVoided의 취소시도까지 이 스위치가 반드시 막아야 하므로
    // (코드리뷰 CRITICAL 지적) 이 체크가 그보다 먼저 와야 한다 — 순서를 옮기지 말 것.
    const killSwitchState = readKillSwitchState(VAULT_PATHS.state.killSwitch);
    if (killSwitchState.readFailed) {
      console.log(`  ⚠️ 킬스위치 상태 확인 불가(${killSwitchState.error.message}) — 안전하게 발주 보류(대기 상태 유지)`);
      await notify('경고', `<b>돌파매매 다음날시가 폴백 보류 — 킬스위치 확인 불가</b>\n${name}(${code}) 킬스위치 파일을 읽을 수 없어 안전하게 발주를 보류했습니다. 볼트 접근 상태를 확인해 주세요.`);
      continue;
    }
    if (isKillSwitchActive(killSwitchState.content)) {
      console.log(`  ℹ️ 킬스위치 활성 — ${name}(${code}) 발주 보류(대기 상태 유지, 자동 재시도됨)`);
      await notify('스킵', `<b>돌파매매 다음날시가 폴백 보류 — 킬스위치 활성</b>\n${name}(${code}) 전날 미체결 확인됐지만 킬스위치가 켜져 있어 발주하지 않았습니다. "킬스위치 오프" 명령으로 해제하면 다음 실행에서 자동 재시도됩니다.`);
      continue;
    }

    const priorCheck = await confirmPriorOrderVoided({
      token, appkey, appsecret, cano, acntPrdtCd, code, afterHoursOrderNo, afterHoursOrgNo, afterHoursOrderQty, signalDate,
      allowCancel: true,
    });
    if (!priorCheck.voided) {
      console.log(`  ⚠️ 전날 주문 생사 미확인 — 자동폴백 보류: ${priorCheck.note}`);
      markUncertain(dir, filename, content, priorCheck.note);
      await notify('경고', `<b>돌파매매 다음날시가 폴백 보류 — 수동확인 필요</b>\n${name}(${code}) — ${escapeHtml(priorCheck.note)}\n중복매수 위험이 있어 자동 발주하지 않았습니다. KIS 앱에서 직접 확인해 주세요.`);
      continue;
    }
    // 이 잡이 방금 실제로 전날 주문을 취소한 경우 — 이 코드베이스에서 이 잡이 실주문을
    // "취소"하는 첫 사례라 반드시 통보한다(코드리뷰 HIGH 지적, 예전엔 완전히 조용했음).
    let cancelReason = null;
    if (priorCheck.kind === 'canceledByUs') {
      cancelReason = priorCheck.note;
      console.log(`  ℹ️ ${cancelReason}`);
      await notify('완료', `<b>돌파매매 다음날시가 폴백 — 전날 주문 직접 취소</b>\n${name}(${code}) — ${escapeHtml(cancelReason)}\n이어서 오늘 시가 폴백 매수를 진행합니다.`);
    }

    // 접수 직전에 먼저 'placing'으로 기록 — 접수 성공 직후 크래시해도(코드리뷰 MEDIUM
    // 지적) 재실행 시 findUnprocessedPendingEntries가 'pending'만 골라내므로 이 항목은
    // 자동으로 다시 시도되지 않는다(안전 쪽으로 정지, 수동확인).
    writeAtomic(join(dir, filename), updatePendingEntryRecord(content, {
      status: PENDING_ENTRY_STATUS.PLACING, ...(cancelReason ? { reason: cancelReason } : {}), updatedAt: new Date().toISOString(),
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
      const orderFailReason = e.confirmedNotSent === true
        ? `시장가 주문 거부 확인됨: ${e.message}`
        : `시장가 주문 응답 불명(${e.message}) — 실제로는 접수됐을 수 있음`;
      // 취소 사실을 여기서도 이어붙임(코드리뷰 검증패스 MEDIUM 지적) — 안 이어붙이면
      // "전날 주문은 우리가 취소했는데 오늘 새 주문도 실패"라는 최악의 조합에서
      // 볼트 레코드만으론 전날 주문이 왜 사라졌는지 설명이 안 남는다(볼트 레코드로
      // 사후 복기하는 게 이 프로젝트의 주 경로라 e.message 원문은 여기 남긴다 —
      // 오너에게 직접 나가는 텔레그램 알림에만 별도로 안전한 문구를 쓴다, 아래).
      const reason = cancelReason ? `${cancelReason} / ${orderFailReason}` : orderFailReason;
      const orderFailReasonSafe = e.confirmedNotSent === true
        ? '시장가 주문 거부 확인됨'
        : '시장가 주문 응답 불명(실제로는 접수됐을 수 있음)';
      const reasonSafe = cancelReason ? `${cancelReason} / ${orderFailReasonSafe}` : orderFailReasonSafe;
      console.log(`  ❌ 시장가 주문 실패(${reason})`);
      writeAtomic(join(dir, filename), updatePendingEntryRecord(content, { status, reason, updatedAt: new Date().toISOString() }));
      await notify('경고', `<b>돌파매매 다음날시가 폴백 실패</b>\n${name}(${code}) ${quantity}주 시장가 매수 — ${escapeHtml(reasonSafe)}. 수동 확인 바랍니다.`);
      continue;
    }

    remainingCash -= budget;
    remainingSlots -= 1;
    console.log(`  ✅ 시장가 매수 접수 — 주문번호 ${order.orderNo}`);
    const entryDate = todayKST();
    writeAtomic(join(dir, filename), updatePendingEntryRecord(content,
      buildPlacedPendingEntryUpdate({ code, entryDate, cancelReason, updatedAt: new Date().toISOString() }),
    ));

    // entry-date는 신호일(signalDate)이 아니라 오늘(실제 체결 시도일) — 포지션의
    // entryDate는 "실제로 진입한 날"이어야 트레일링스탑 기산일이 맞다.
    // 이 다리는 더 이상의 폴백이 없다 — --fallback 없이 호출(미체결 시 통상 타임아웃 알림).
    //
    // ⚠️ entryStopLossPct 결측 경고(2026-09-19 코드리뷰 검증패스 MEDIUM 지적) —
    // buildFallbackWatchArgs 자체는 null이면 조용히 STOP_LOSS_PCT(8%)로 폴백한다
    // (과거 대기항목 레코드 하위호환용). 그런데 place-breakout-entry-order.mjs가
    // 이제 자동호출 경로에서 이 필드를 항상 채우도록 강제하므로(alertAndExit 가드),
    // 이 시점에 null이 실제로 온다는 건 배선 버그일 가능성이 높다(하위호환이
    // 필요한 레거시 레코드가 실측상 존재하지 않음 — CRITICAL 사고 재발 경로를
    // 조용히 통과시키면 안 된다는 지적, entry-order.mjs의 loud-failure 가드와
    // 비대칭이었음).
    if (entryStopLossPct == null) {
      console.warn(`  ⚠️ ${name}(${code}) 대기항목에 stopLossPct 없음 — STOP_LOSS_PCT(8%)로 폴백함(배선 버그 의심, 레거시 레코드가 아니라면 확인 필요)`);
    }
    const child = spawn('node', [
      join(here, '..', 'tools', 'watch-breakout-entry-fill.mjs'),
      ...buildFallbackWatchArgs({ order, code, name, entryDate, stopLossPct: entryStopLossPct }),
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => {
      console.error(`  ⚠️ 체결감시 기동 실패(주문 자체는 이미 접수됨): ${e.message}`);
      notify('경고', `<b>체결감시 기동 실패 — 무방비 포지션 위험</b>\n${name}(${code}) ${quantity}주 시장가 매수(주문번호 ${order.orderNo})는 접수됐지만 체결감시를 못 띄웠습니다. 즉시 KIS 앱에서 확인해 주세요.`);
    });
    child.unref();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await notify('경고', '<b>돌파매매 다음날시가 폴백 잡 예외 종료</b>\n예상 못 한 오류로 중단됐습니다. 로그를 확인해 주세요.');
    process.exit(1);
  });
}
