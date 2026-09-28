#!/usr/bin/env node
// 평일 KRX 시가단일가 프리장(08:35) — 돌파매매(퀀트 트랙) 보유 포지션의 청산측을
// 매일 능동으로 관리한다(2026-09-29 재설계, Log/Strategy/2026-09-28-대한항공보호주문
// 실패-트레일링전환.md "정정 2" 절 참고 — banana-vault).
//
// 이전 설계(손절 전량+3R 부분익절을 진입 시점에 동시 예약)는 KIS가 전량 손절주문이
// 이미 전체 매도가능수량을 예약해버려 그 위에 3R 주문을 또 걸 수 없다는 구조적
// 결함이 있었다(2026-09-28 대한항공 실사고, `ord_psbl_qty=0` 실측 확인). 새 설계는
// 진입 시점엔 전량 손절주문만 걸고(watch-breakout-entry-fill.mjs), 이 잡이 매일:
// ①포지션이 이미 전량 종료(손절 체결)됐는지 먼저 확인 — 종료됐으면 원장 기록+
//   포지션 종료 처리만 하고 끝.
// ②아직 보유 중이면 트레일링(computeTrailingStop 기반 손절선 능동 정정)과 3R
//   최초도달 시 부분익절(취소→50%시장가매도→잔여손절재예약)을 판정·실행한다.
// 판정 로직은 breakout-exit-management.mjs(순수함수, 부작용 없음)가 맡고, 이 잡은
// 그 판정을 실제 KIS 호출로 실행하는 역할만 한다.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadQuantAccount, getKisToken, getAccountBalance, getCancelableOrders,
  reviseKrOrder, placeKrOrder, checkOrderFill,
} from '../lib/kis.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { BREAKOUT_PROTECTION_LOCK_FILE, BREAKOUT_PROTECTION_LOCK_STALE_MS } from '../lib/breakout-protection-lock.mjs';
import { readKrxTradingDayStatus } from '../lib/krx-trading-calendar.mjs';
import { getExecutionMode, MODE_LIVE } from '../lib/shadow-mode.mjs';
import { isKillSwitchActive } from '../lib/kill-switch.mjs';
import { parseBreakoutPosition } from '../lib/breakout-position-vault.mjs';
import {
  decideExitManagement, executeExitManagement, decidePositionClosure, decidePendingPartialExitConfirmation,
} from '../lib/breakout-exit-management.mjs';
import { loadPriceSeries } from '../lib/breakout-price-series.mjs';
import { patchFrontmatterFileSafely, withLock, writeAtomic } from '../lib/state-writer.mjs';
import { buildExecutionRecord, buildProfitRecord } from '../lib/ledger-vault-writer.mjs';
import { QUANT_TRACK_LABEL } from '../lib/account-resolver.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';

const DEPARTMENT_LABEL = '운영실 Hermes';
const BROKER = '한국투자증권';
const DRY_RUN = process.argv.includes('--dry-run');
// retry-breakout-protection.mjs(수동 재시도 CLI)와 락 파일·유효기간을 공유한다 —
// breakout-protection-lock.mjs 헤더 주석 참고(2026-09-29 3·4차 코드리뷰).
const LOCK_FILE = BREAKOUT_PROTECTION_LOCK_FILE;
const LOCK_STALE_MS = BREAKOUT_PROTECTION_LOCK_STALE_MS;

export function isKrxPreMarketWindow(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const hhmm = Number(parts.hour) * 100 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && hhmm >= 830 && hhmm < 900;
}

// 08:35는 장 시작(09:00) 전이라 "오늘" 봉이 아직 없다 — checkOrderFill로 전날
// 체결분을 조회할 때, 그리고 원장 tradeDate/exitDate를 적을 때 "가장 최근 거래일"이
// 필요하다. `new Date(now); setDate(getDate()-1)`(옛 yesterday() 구현, 2026-09-29
// 코드리뷰 HIGH 지적으로 제거)는 두 가지가 틀렸다 — ①서버 로컬시각 기준 날짜연산이라
// UTC 자정 근처에는 KST 날짜와 어긋날 수 있고 ②"달력상 하루 전"일 뿐이라 주말·
// 공휴일 다음 거래일에는 실제 마지막 거래일이 아니다(월요일 08:35에 "일요일"을
// 만들어버림). 대신 update-breakout-price-cache.mjs가 매일 07:00에 갱신하는 실제
// 확정 거래일 캐시(priceSeries.dates 마지막 원소, latestConfirmedHigh와 동일 소스라
// 이미 이 실행 안에서 로드함)를 그대로 쓴다 — 이게 이 시점 기준 진짜 마지막 거래일.
export function tradingDayFillCheckWindow(latestTradingDate, fallbackNow) {
  if (!latestTradingDate) return fallbackNow;
  // KST 정오로 고정 — 어느 서버 타임존에서 돌아도 날짜가 밀리지 않는다(자정 근처
  // UTC 변환 오차 회피). checkOrderFill은 이 값의 연/월/일만 읽는다.
  return new Date(`${latestTradingDate}T12:00:00+09:00`);
}

// latestTradingDate(개별종목 확정 시세 캐시의 최신 거래일)가 오늘 기준으로 너무
// 오래됐으면 checkOrderFill 조회창·원장 tradeDate에 그대로 쓰면 안 된다 — ①07:00
// update-breakout-price-cache 잡이 며칠째 실패했거나 ②이 잡 자체가 launchd·
// 맥미니 슬립 등으로 며칠 못 돌았을 때, 실제 체결일과 다른 날짜를 조회해 체결을
// 영원히 못 찾거나 원장에 틀린 날짜를 남길 수 있다(2026-09-29 2차 코드리뷰 HIGH
// 지적). 최초 7일은 "설·추석 최대 5~6일"이라는 잘못된 가정이었다(2026-09-29
// 3차 코드리뷰 MEDIUM 지적 — 2017년 추석은 임시공휴일까지 겹쳐 09-29→10-10,
// 달력 11일 연속 휴장이었던 실제 KRX 사례가 있다). 그 사례에 여유를 더해 14일로
// 잡는다. checkOrderFill도 이 값과 맞춰 뒤로 넓혀 조회한다(아래
// FILL_QUERY_LOOKBACK_DAYS) — 시세캐시가 살짝 낡았더라도(이 임계값 안쪽) 주문을
// 실제로 낸 날짜가 latestTradingDate보다 며칠 앞일 수 있어, 조회창 자체도 같이
// 넓혀야 체결을 찾을 수 있다(2026-09-29 3차 코드리뷰 HIGH 지적 — staleness
// 판정과 조회창이 같은 latestTradingDate 하나만 보고 서로를 검증 못 하던 문제).
const STALE_PRICE_SERIES_DAYS = 14;
const FILL_QUERY_LOOKBACK_DAYS = 14;
export function isPriceSeriesStale(latestTradingDate, now) {
  if (!latestTradingDate) return true;
  const todayKst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  const diffDays = (Date.parse(`${todayKst}T00:00:00Z`) - Date.parse(`${latestTradingDate}T00:00:00Z`)) / 86400000;
  return !(diffDays >= 0 && diffDays <= STALE_PRICE_SERIES_DAYS);
}

// 포지션의 entryDate부터 개별종목 확정 시세 캐시(update-breakout-price-cache.mjs가
// 평일 07:00에 갱신, 전일까지 확정)의 최신 거래일까지 전체 구간의 고가 중 최댓값을
// 구해 기존 highSinceEntry와 비교한다. highSinceEntry 필드는 이번이 최초 배선이라
// (지금까지 한 번도 갱신된 적 없음) 기존 보유 포지션은 진입일 이후 누적 구간
// 전체를 한 번에 따라잡아야 한다 — "어제 하루"만 보면 안 된다. 시세 캐시가 없거나
// (드묾, 신규상장 직후 등) entryDate 이후 유효한 고가 데이터가 하나도 없으면 null
// (판단 불가 — 추정 안 함, 호출측이 review로 처리).
export function latestConfirmedHigh(position, priceSeries) {
  if (!priceSeries) return null;
  const highsSinceEntry = priceSeries.highs.filter(
    (h, i) => priceSeries.dates[i] >= position.entryDate && h > 0,
  );
  if (!highsSinceEntry.length) return null;
  return Math.max(position.highSinceEntry ?? position.entryPrice, ...highsSinceEntry);
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
      entries.push({ filepath, position });
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

// 같은 체결을 재시도 때 두 번 기록하지 않도록(idempotency) 파일이 이미 있으면
// 조용히 스킵한다 — buildExecutionRecord/buildProfitRecord의 dedupKey 기반
// 파일명 자체가 이미 결정론적이라 존재 여부만 보면 된다.
function recordLedgerFileIfNew({ dir, filename, content }) {
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, filename);
  if (existsSync(filepath)) return false;
  writeAtomic(filepath, content);
  return true;
}

async function main() {
  const now = new Date();
  if (!DRY_RUN) {
    const calendar = readKrxTradingDayStatus(now);
    if (calendar.isOpen !== true) {
      console.log(`[건너뜀] ${calendar.date} KRX 개장일이 확인되지 않아 청산 관리를 하지 않음: ${calendar.reason || '휴장일'}`);
      return;
    }
    if (!isKrxPreMarketWindow(now)) {
      console.log('[건너뜀] KRX 평일 08:30~09:00 시가단일가 시간이 아님');
      return;
    }
  }
  await withLock(LOCK_FILE, async () => {
    const { entries, errors: fileErrors } = readPositions();
    const openPositions = entries.filter(({ position: p }) => p.status === '보유');
    if (!openPositions.length && !fileErrors.length) { console.log('[정상] 청산관리 대상 없음'); return; }
    if (!openPositions.length) { await notify(fileErrors, '경고'); return; }

    const quant = loadQuantAccount();
    if (!quant) { await notify(['KIS 퀀트계좌 설정을 읽지 못해 청산 관리를 보류했습니다.']); return; }
    const { appkey, appsecret } = quant;
    const token = await getKisToken({ appkey, appsecret });
    const [balance, cancelableOrders] = await Promise.all([
      getAccountBalance({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
      getCancelableOrders({ token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd }),
    ]);
    const balanceByCode = new Map(balance.holdings.map((h) => [h.code, h]));

    const readState = (filepath) => {
      try { return readFileSync(filepath, 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    };
    // 네트워크 조회·앞선 포지션 처리 도중 오너가 킬스위치/체결모드를 바꿀 수 있으므로
    // 실행 시작 때 읽은 낡은 스냅샷을 쓰지 않고, 각 주문 직전에 다시 읽는다(기존
    // gatesAllowOrder와 동일 원칙).
    const gatesAllowOrder = () => {
      try {
        const haltedNow = isKillSwitchActive(readState(VAULT_PATHS.state.killSwitch));
        const liveNow = getExecutionMode(readState(VAULT_PATHS.state.executionMode)) === MODE_LIVE;
        return !haltedNow && liveNow;
      } catch (e) {
        console.error(`[주문 게이트 조회 실패] ${e.message}`);
        return false;
      }
    };

    const reports = [...fileErrors];
    let urgentDetected = fileErrors.length > 0;

    for (const { filepath, position } of openPositions) {
      const label = position.name || position.code;
      try {
        const holding = balanceByCode.get(position.code) ?? null;
        const priceSeries = loadPriceSeries(position.code);
        const latestTradingDate = priceSeries?.dates?.length ? priceSeries.dates[priceSeries.dates.length - 1] : null;
        const latestClose = priceSeries?.closes?.length ? priceSeries.closes[priceSeries.closes.length - 1] : null;
        const fillCheckNow = tradingDayFillCheckWindow(latestTradingDate, now);

        if (isPriceSeriesStale(latestTradingDate, now)) {
          urgentDetected = true;
          reports.push(`${label}: 확정 시세 캐시가 너무 오래됨(최신 거래일 ${latestTradingDate ?? '없음'}) — 07:00 캐시 잡 또는 이 잡의 실행 공백 의심, 체결조회 날짜창을 신뢰할 수 없어 이 포지션은 건너뜀`);
          continue;
        }

        // 0) 이전 실행에서 3R 부분익절 시장가 매도를 냈지만 체결가를 아직 원장에
        //    못 적었으면(당시엔 접수만 확인 가능, 09:00 시가단일가 체결은 다음
        //    실행에야 확정) 오늘 먼저 그 확인부터 한다. 네 결과(confirm·review·
        //    abandon·partialFill) 전부 DRY_RUN이 아닌 한 아래 1·2단계로 그대로
        //    이어서 진행한다 — 여기서 continue하면 그만큼 손절 재등록이 늦어져
        //    무보호 기간이 생긴다(2026-09-29 2차 코드리뷰 CRITICAL 지적, 최초
        //    버전의 실제 결함). 네 갈래 각각이 아래로 내려간 뒤 실제로 어떻게
        //    되는지(2026-09-29 4차 코드리뷰 MEDIUM 지적 — 이 주석이 예전엔
        //    "abandon·partialFill도 review로 떨어진다"고 잘못 적혀 있었다. 확인
        //    자체가 최소 다음 실행에야 이뤄지는데, 그때는 원래 걸어둔 손절
        //    주문(remainingQty 기준)이 당일유효 소멸로 이미 사라진 뒤라 실제로는
        //    review가 아니라 아래처럼 흐른다):
        //    - confirm: partialSold=true 그대로, quantity=remainingQty 그대로 →
        //      살아있는 매도주문이 없으면 3R 재도달 안 하므로 plain placeStop.
        //    - review(아직 미확인): holding.qty가 매도 체결분만큼 이미 줄어 있으면
        //      정상 진행(원장만 다음 실행으로 이월), 아직 안 줄었으면 2단계
        //      수량불일치 가드가 안전하게 review로 잡는다.
        //    - abandon(전량 미체결): quantity를 원래 전량으로 복원, partialSold를
        //      false로 되돌림 → 살아있는 매도주문 없음 + 아직 3R 이상이면
        //      placeStopAndPartialExit가 "같은 실행 안에서 즉시 재시도"로 다시
        //      나간다. 거래정지 등으로 매도 자체가 실패했던 상황을 스스로
        //      재시도하는 의도된 동작 — urgentDetected로 오너에게는 알린다.
        //    - partialFill(일부만 체결): quantity를 실제 체결분만큼만 복원,
        //      partialSold는 true 유지(3R 이벤트 자체는 이미 일어났으므로 재시도
        //      대상 아님) → 살아있는 매도주문이 없으면 plain placeStop이 복원된
        //      정확한 잔여수량으로 새 손절을 건다.
        //    어느 갈래도 중복 매도를 내지 않는다 — confirm/review에서 매도 관련
        //    주문을 다시 내는 경로 자체가 없고, abandon/partialFill의 재시도는
        //    "이전 시도가 실패/부분실패로 종결됐다고 이미 확인된" 상태에서만
        //    나간다.
        if (position.partialExitPendingOrderNo) {
          const pendingFill = await checkOrderFill({
            token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
            odno: position.partialExitPendingOrderNo, now: fillCheckNow, sinceDaysBack: FILL_QUERY_LOOKBACK_DAYS,
          });
          const pendingDecision = decidePendingPartialExitConfirmation({ position, fill: pendingFill });

          if (pendingDecision.action === 'review') {
            urgentDetected = true;
            reports.push(`${label}: ${DRY_RUN ? '드라이런 — ' : ''}${pendingDecision.reason}`);
          } else if (pendingDecision.action === 'confirm') {
            if (DRY_RUN) {
              reports.push(`${label}: 드라이런 — 부분익절 매도 체결 확인(${pendingFill.filledQty}주 @${pendingFill.avgFillPrice}원) — 원장 기록 안 함, 이어서 1·2단계도 미리보기`);
            } else {
              const tradeDateOnly = latestTradingDate ?? now.toISOString().slice(0, 10);
              const execution = {
                tradeDate: `${tradeDateOnly}T00:00:00`, tradeType: '매도', stockCode: position.code,
                stockName: label, quantity: pendingFill.filledQty, price: pendingFill.avgFillPrice, currency: 'KRW',
                broker: BROKER, orderNo: pendingFill.orderNo, account: QUANT_TRACK_LABEL,
              };
              const realizedProfit = (pendingFill.avgFillPrice - position.entryPrice) * pendingFill.filledQty;
              recordLedgerFileIfNew(buildExecutionRecord(execution));
              recordLedgerFileIfNew(buildProfitRecord(execution, position.entryPrice, realizedProfit));
              const wrote = await patchFrontmatterFileSafely(filepath, {
                partialExitPendingOrderNo: null, partialExitPendingOrgNo: null, partialExitPendingQty: null,
                updatedAt: now.toISOString(),
              });
              if (!wrote) throw new Error('포지션 파일 동시수정으로 부분익절 원장 기록 실패');
              reports.push(`${label}: 3R 부분익절 체결 확인(${pendingFill.filledQty}주 @${pendingFill.avgFillPrice}원) — 원장 기록 완료`);
            }
            // DRY_RUN이든 아니든 아래 1·2단계 미리보기·실행이 이 확인 결과를
            // 반영하도록 in-memory 상태는 항상 갱신한다(실제 파일 쓰기만
            // DRY_RUN에서 건너뜀, 2026-09-29 4차 코드리뷰 MEDIUM 지적 — 예전엔
            // 드라이런이 여기서 continue해 이 확인과 맞물리는 1·2단계 미리보기가
            // 전혀 안 나왔었다).
            position.partialExitPendingOrderNo = null;
            position.partialExitPendingOrgNo = null;
            position.partialExitPendingQty = null;
          } else {
            // abandon(전량 취소/미체결) 또는 partialFill(일부만 체결) — 시가단일가
            // 거래정지 등 드문 경우. 실제 체결된 몫만 원장에 남기고, 안 팔린
            // 몫만큼 수량·투자금을 되돌린다.
            urgentDetected = true;
            const filledQty = pendingDecision.action === 'partialFill' ? pendingFill.filledQty : 0;
            const unfilledQty = position.partialExitPendingQty - filledQty;
            const restoredQuantity = position.quantity + unfilledQty;
            const restoredInvestedWon = Math.round(position.investedWon * (restoredQuantity / position.quantity));
            let ledgerNote = '';
            if (pendingDecision.action === 'partialFill' && !DRY_RUN) {
              const tradeDateOnly = latestTradingDate ?? now.toISOString().slice(0, 10);
              const execution = {
                tradeDate: `${tradeDateOnly}T00:00:00`, tradeType: '매도', stockCode: position.code,
                stockName: label, quantity: pendingFill.filledQty, price: pendingFill.avgFillPrice, currency: 'KRW',
                broker: BROKER, orderNo: pendingFill.orderNo, account: QUANT_TRACK_LABEL,
              };
              const realizedProfit = (pendingFill.avgFillPrice - position.entryPrice) * pendingFill.filledQty;
              recordLedgerFileIfNew(buildExecutionRecord(execution));
              recordLedgerFileIfNew(buildProfitRecord(execution, position.entryPrice, realizedProfit));
              ledgerNote = `체결된 ${pendingFill.filledQty}주는 원장 기록 완료, `;
            }
            if (!DRY_RUN) {
              const wrote = await patchFrontmatterFileSafely(filepath, {
                quantity: restoredQuantity, investedWon: restoredInvestedWon,
                partialSold: pendingDecision.action === 'partialFill', protectionStatus: 'failed',
                partialExitPendingOrderNo: null, partialExitPendingOrgNo: null, partialExitPendingQty: null,
                updatedAt: now.toISOString(),
              });
              if (!wrote) throw new Error('포지션 파일 동시수정으로 부분익절 원복 기록 실패');
            }
            reports.push(`${label}: ${DRY_RUN ? '드라이런 — ' : ''}⚠️ ${pendingDecision.reason} — ${ledgerNote}미체결 ${unfilledQty}주 수량 원복(${DRY_RUN ? '예정' : `완료→${restoredQuantity}주`}), 이어서 1·2단계도 ${DRY_RUN ? '미리보기' : '재판정'}`);
            // 위 confirm과 동일 원칙 — in-memory 상태는 항상 갱신, 파일 쓰기만
            // DRY_RUN에서 건너뜀.
            position.quantity = restoredQuantity;
            position.investedWon = restoredInvestedWon;
            position.partialSold = pendingDecision.action === 'partialFill';
            position.partialExitPendingOrderNo = null;
            position.partialExitPendingOrgNo = null;
            position.partialExitPendingQty = null;
          }
        }

        // 1) 전량 종료(손절 체결) 감지 — 트레일링/3R 판정보다 먼저. KIS 잔고에
        //    이 종목이 없거나 수량이 0이면 우리 손절주문이 체결됐거나(가장 흔한
        //    경우) 다른 이유로 잔고가 사라진 것 — 조용히 "종료됐다"고 추정하지
        //    않고 반드시 checkOrderFill로 실제 체결을 확인한 뒤에만 종료 처리한다.
        if (!holding || !(holding.qty > 0)) {
          const fill = await checkOrderFill({
            token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd,
            odno: position.stopOrderNo, now: fillCheckNow, sinceDaysBack: FILL_QUERY_LOOKBACK_DAYS,
          });
          const closure = decidePositionClosure({ position, holding, fill });
          if (closure.action !== 'close') {
            urgentDetected = true;
            reports.push(`${label}: ${closure.reason}`);
            continue;
          }
          if (DRY_RUN) {
            reports.push(`${label}: 드라이런 — 손절 체결 확인(${fill.filledQty}주 @${fill.avgFillPrice}원), 원장 기록·포지션 종료 안 함`);
            continue;
          }
          // checkOrderFill은 체결 시각을 안 돌려준다(전날 조회 범위만 확정) — 정확한
          // 시각 대신 그 날짜의 자정을 트레이드 타임스탬프로 쓴다(다른 정보 없음,
          // 명시적 근사 — 정확한 시각이 필요해지면 별도 API 확인 필요).
          const tradeDateOnly = latestTradingDate ?? now.toISOString().slice(0, 10);
          const execution = {
            tradeDate: `${tradeDateOnly}T00:00:00`, tradeType: '매도', stockCode: position.code,
            stockName: label, quantity: fill.filledQty, price: fill.avgFillPrice, currency: 'KRW',
            broker: BROKER, orderNo: fill.orderNo, account: QUANT_TRACK_LABEL,
          };
          const realizedProfit = (fill.avgFillPrice - position.entryPrice) * fill.filledQty;
          recordLedgerFileIfNew(buildExecutionRecord(execution));
          recordLedgerFileIfNew(buildProfitRecord(execution, position.entryPrice, realizedProfit));
          const wrote = await patchFrontmatterFileSafely(filepath, {
            status: '청산', exitDate: tradeDateOnly, exitReason: '트레일링스탑', updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 종료 기록 실패');
          reports.push(`${label}: 손절 체결 확인(${fill.filledQty}주 @${fill.avgFillPrice}원) — 원장 기록+포지션 종료 완료`);
          continue;
        }

        // 2) 아직 보유 중 — 트레일링/3R 판정.
        if (holding.qty !== Number(position.quantity)) {
          urgentDetected = true;
          reports.push(`${label}: 보유수량 불일치(기록 ${position.quantity}, KIS ${holding.qty}) — 확인 필요`);
          continue;
        }
        const latestHigh = latestConfirmedHigh(position, priceSeries);
        const decision = decideExitManagement({
          position, holding, sellOrders: cancelableOrders, latestHigh, latestClose,
        });

        if (decision.action === 'review') {
          if (decision.urgent) urgentDetected = true;
          reports.push(`${label}: ${decision.urgent ? '⚠️ 오늘 무보호 — ' : ''}${decision.reason}`);
          continue;
        }
        if (decision.action === 'none') {
          // 조정 자체는 불필요해도 highSinceEntry 추적값은 최신으로 갱신해둔다
          // (다음날 판정이 낡은 고가로 잘못 계산되지 않도록).
          if (decision.highSinceEntry != null && decision.highSinceEntry > position.highSinceEntry) {
            await patchFrontmatterFileSafely(filepath, {
              highSinceEntry: decision.highSinceEntry, updatedAt: now.toISOString(),
            });
          }
          continue;
        }
        // 여기서부터는 decision.action이 'placeStop'·'revise'·'partialExit'·
        // 'placeStopAndPartialExit' 중 하나 — 실제 주문이 나갈 수 있다.
        if (DRY_RUN) {
          const preview = decision.action === 'placeStop'
            ? `당일유효 손절주문 소멸 감지 — 새 손절 등록 예정(${decision.position.quantity}주 →${decision.newStopPrice}원)`
            : decision.action === 'revise'
              ? `손절선 정정 예정(→${decision.newStopPrice}원)`
              : decision.action === 'placeStopAndPartialExit'
                ? `당일유효 손절주문 소멸+3R 최초도달 겹침 — ${decision.soldQty}주 시장가매도+잔여 ${decision.remainingQty}주 신규 손절 예정(→${decision.newStopPrice}원)`
                : `3R 부분익절 예정(${decision.soldQty}주 시장가매도+잔여 ${decision.remainingQty}주 재예약)`;
          reports.push(`${label}: 드라이런 — ${preview}`);
          continue;
        }
        if (!gatesAllowOrder()) {
          const haltedNow = isKillSwitchActive(readState(VAULT_PATHS.state.killSwitch));
          // 게이트가 의도적으로 막은 상황(킬스위치·섀도우)이라도, 보유 포지션이
          // 오늘 손절/트레일링/3R 조정을 못 받는다는 사실 자체는 동일하다 —
          // '완료' 태그로 조용히 넘어가면 안 된다(2026-09-29 2차 코드리뷰 MEDIUM
          // 지적).
          urgentDetected = true;
          reports.push(`${label}: ${haltedNow ? '킬스위치 활성' : '체결모드 섀도우'} — 주문 안 냄(오늘 무보호 상태로 남음)`);
          continue;
        }
        const gatedCall = (fn) => async (params) => {
          if (!gatesAllowOrder()) {
            const e = new Error('주문 게이트가 실행 도중 닫힘');
            e.confirmedNotSent = true;
            throw e;
          }
          return fn(params);
        };
        const reviseOrder = gatedCall((params) => reviseKrOrder({
          token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd, ...params,
        }));
        const placeOrder = gatedCall((params) => placeKrOrder({
          token, appkey, appsecret, cano: quant.cano, acntPrdtCd: quant.acntPrdtCd, code: position.code, ...params,
        }));
        const result = await executeExitManagement(decision, { reviseOrder, placeOrder });

        if (result.status === 'completed' && decision.action === 'placeStop') {
          const wrote = await patchFrontmatterFileSafely(filepath, {
            stopOrderNo: result.stopOrderNo, stopOrderOrgNo: result.stopOrderOrgNo,
            stopPrice: decision.newStopPrice, highSinceEntry: decision.highSinceEntry,
            protectionStatus: 'protected', updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 손절 재등록 결과 기록 실패');
          reports.push(`${label}: 당일유효 손절주문 소멸 감지 — 새 손절 등록 완료(→${decision.newStopPrice}원)`);
        } else if (result.status === 'completed' && decision.action === 'revise') {
          const wrote = await patchFrontmatterFileSafely(filepath, {
            stopOrderNo: result.stopOrderNo, stopOrderOrgNo: result.stopOrderOrgNo,
            stopPrice: decision.newStopPrice, highSinceEntry: decision.newHighSinceEntry,
            updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 정정 결과 기록 실패');
          reports.push(`${label}: 손절선 정정 완료(→${decision.newStopPrice}원)`);
        } else if (result.status === 'completed'
          && (decision.action === 'partialExit' || decision.action === 'placeStopAndPartialExit')) {
          // investedWon은 남은 수량 비율만큼 줄인다(백테스트 시뮬레이터의 부분익절
          // 회계 방식과 동일 — investedWon -= soldWon). 매도 자체는 체결가를 아직
          // 모르므로(09:00 시가단일가) 원장에 바로 안 적고 partialExitPending*에
          // 주문번호만 남겨 다음 실행이 확인·기록하게 한다(위 0단계).
          const remainingFraction = decision.remainingQty / position.quantity;
          const wrote = await patchFrontmatterFileSafely(filepath, {
            stopOrderNo: result.stopOrderNo, stopOrderOrgNo: result.stopOrderOrgNo,
            stopPrice: decision.newStopPrice, highSinceEntry: decision.highSinceEntry,
            quantity: decision.remainingQty,
            investedWon: Math.round(position.investedWon * remainingFraction),
            partialSold: true, protectionStatus: 'protected',
            partialExitPendingOrderNo: result.partialExitOrderNo, partialExitPendingOrgNo: result.partialExitOrgNo ?? null,
            partialExitPendingQty: result.soldQty, updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 3R 부분익절 결과 기록 실패');
          reports.push(`${label}: 3R 부분익절 완료(${decision.soldQty}주 매도 — 체결가 확인 후 원장 기록 예정, 잔여 ${decision.remainingQty}주 손절 →${decision.newStopPrice}원)`);
        } else if (result.status === 'urgentReview' && result.partialExitOrderNo) {
          // 시장가 매도는 확정 접수됐는데(취소할 기존 주문이 없던 경우거나, 있었다면
          // 이미 취소까지 확정된 뒤라는 뜻) 잔여 수량 재예약이 실패 — 판 몫은
          // 확정 사실이라 안전하게 기록하고, 잔여 몫은 무보호로 남았으니
          // protectionStatus를 failed로 남겨 다음 실행이 손절 재등록을 최우선
          // 재시도하게 한다(sellOrdersForThisCode가 비어있을 것이므로 자연히
          // placeStop 분기로 다시 들어간다).
          urgentDetected = true;
          const remainingFraction = decision.remainingQty / position.quantity;
          const wrote = await patchFrontmatterFileSafely(filepath, {
            quantity: decision.remainingQty,
            investedWon: Math.round(position.investedWon * remainingFraction),
            partialSold: true, protectionStatus: 'failed',
            partialExitPendingOrderNo: result.partialExitOrderNo, partialExitPendingOrgNo: result.partialExitOrgNo ?? null,
            partialExitPendingQty: result.soldQty, updatedAt: now.toISOString(),
          });
          if (!wrote) throw new Error('포지션 파일 동시수정으로 부분매도 확정 기록 실패');
          reports.push(`${label}: ⚠️ ${decision.soldQty}주 매도는 확정됐으나 잔여 ${decision.remainingQty}주 신규 손절 실패 — 무보호, 즉시 확인 필요(${result.error ?? '응답 없음'})`);
        } else {
          // 'review'(취소 단계 애매 — 원래 손절주문이 여전히 살아있을 수 있음) 또는
          // 'urgentReview'(매도 자체가 애매 — 아무 것도 확정된 게 없어 이전 상태와
          // 실질 같음, 그래도 무보호이니 긴급). 둘 다 포지션 파일은 건드리지 않는다
          // — 다음 실행이 KIS 실제 상태를 다시 조회해서 이어가야 하므로, 여기서
          // 파일에 애매한 진행상태를 남기면 오히려 그 재조회를 혼란스럽게 만들 수 있다.
          const urgent = result.status === 'urgentReview';
          if (urgent) urgentDetected = true;
          reports.push(`${label}: ${urgent ? '⚠️ 무보호 가능성 — 즉시 확인 필요' : '주문 취소 결과 불확실 — 확인 필요'}(단계: ${result.stage}, ${result.error ?? '응답 없음'})`);
        }
      } catch (e) {
        urgentDetected = true;
        console.error(`[청산관리 오류] ${position.code}: ${e.message}`);
        reports.push(`${label}: 조회 또는 기록 오류 — 중복방지를 위해 추가 주문을 중단했습니다.`);
      }
    }

    // 경고 여부는 메시지 문구 정규식 추측이 아니라 위에서 각 분기가 직접 표시한
    // urgentDetected 플래그로 판단한다(2026-09-29 코드리뷰 HIGH 지적 — 옛 정규식은
    // "확정 고가를 확인하지 못함"처럼 실제로 긴급한 review 사유인데도 어떤
    // 키워드와도 안 맞아 조용히 '완료'로 나갈 수 있었다). "조정 불필요"·"이미 최신"
    // 문구로 report를 걸러내던 옛 필터는 그런 문구를 내는 분기가 더 없어 죽은
    // 코드였다(2026-09-29 2차 코드리뷰 LOW 지적) — 제거.
    await notify(reports, urgentDetected ? '경고' : '완료');
    for (const line of reports) console.log(`[청산관리] ${line}`);
  }, { staleLockMs: LOCK_STALE_MS });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error(`[청산관리 중단] ${e.message}`);
    await notify(['KIS 조회 또는 청산 관리가 실패했습니다. 주문 중복 방지를 위해 자동 조정을 중단했습니다.'], '경고').catch(() => {});
    process.exit(1);
  });
}
