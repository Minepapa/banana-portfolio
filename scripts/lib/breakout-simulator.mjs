// 돌파매매 전략 — 일별 이벤트 기반 백테스트 시뮬레이터 (2026-09-12). OCF/P의 월간
// 리밸런싱(walk-forward-simulator.mjs)과 달리 이 전략은 매일 신호를 확인하고 포지션별
// 트레일링스탑/피라미딩을 추적해야 해서 별도 엔진이 필요하다.
//
// 후보군 단순화(오너 확정 반영): 코스피200+코스닥150 지수 근사 랭킹을 따로 안 거친다 —
// 오너가 지정한 시가총액 하한(1조원) 자체가 이미 대형주만 남기는 훨씬 강한 필터라(보통
// 코스피200 편입 하한보다 높음), 그 위에 또 지수 근사 랭킹을 얹는 건 이중 작업. 후보군
// = build_candidate_pool() 전체(코스피+코스닥 보통주) 중 그 날짜에 상장돼 있고
// (listingDate<=date<delistingDate) 시가총액 1조원↑ + 유동성 필터 통과 종목.
import { computeBreakoutEntrySignal, RS_LOOKBACK_DAYS } from './breakout-factor.mjs';
import {
  computeTrailingStop, computePositionSize, shouldPyramid,
  shouldTakePartialProfit, rMultiplePrice, PARTIAL_PROFIT_TRIGGER_R, PARTIAL_PROFIT_SELL_FRACTION,
  MAX_CONCURRENT_POSITIONS, STOP_LOSS_PCT, computeATR, selectAdaptiveStopLossPct,
} from './breakout-risk.mjs';
import {
  computeBettingUnitInvestment, MIN_BETTING_UNITS, TOTAL_BETTING_UNITS, BETTING_UNIT_SUCCESS_R,
} from './breakout-unit-tracker.mjs';
import { findIndexAtOrBefore } from './breakout-price-series.mjs';

export const LIQUIDITY_FLOOR_WON = 3_000_000_000; // 일평균거래대금 30억원(기존 프로젝트 관례, rebalance-gap.mjs 등과 동일 기준 재사용)
export { RS_LOOKBACK_DAYS }; // breakout-factor.mjs로 이전(2026-09-15, 위 import 참고) — 기존 호출부 하위호환용 재수출
export const HIGH_LOOKBACK_DAYS = 252; // 52주(거래일 기준)

// closes/volumes 배열에서 endIndex(포함) 기준 최근 days거래일 평균 거래대금(종가×거래량).
// 윈도우가 짧으면(신규상장 직후 등) null(추정 안 함, avg_trading_value_at과 동일 원칙).
export function computeAvgTradingValue(closes, volumes, endIndex, days = 20, minWindowRatio = 0.9) {
  const startIndex = endIndex - days + 1;
  if (startIndex < 0) return null;
  let sum = 0;
  let count = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    if (closes[i] != null && volumes[i] != null) {
      sum += closes[i] * volumes[i];
      count += 1;
    }
  }
  if (count < days * minWindowRatio) return null;
  return sum / count;
}

// 포지션 상태 갱신 — 오늘의 (high, low, close)를 반영해 트레일링스탑·피라미딩·3R
// 부분익절 판정.
//
// ⚠️ 청산 판정은 반드시 "어제까지 확정된 손절선"(position.stopPrice, 오늘 갱신 전)
// 기준으로 먼저 한다 — 오늘의 고가로 손절선을 오늘 안에 미리 올려버린 뒤 그 새
// 손절선을 오늘의 저가와 비교하면, 일중 고가·저가 중 어느 게 먼저 일어났는지 알 수
// 없는데도 "고가가 먼저 찍히고 그 다음 저가로 빠졌다"고 암묵적으로 가정하는 게 된다
// (일봉만으로는 일중 순서를 알 수 없음 — 직접 실측: 이 순서를 반대로 하니 1~2일 만에
// 손익 정확히 0%로 청산되는 부자연스러운 거래 다수 발견, 원인 확인 후 수정).
// 트레일링 갱신(오늘 고가 반영)은 청산이 안 났을 때만, 내일 판정에 쓰일 손절선으로 갱신한다.
//
// 3R 부분익절(오너 확정, 2026-09-13)은 트레일링스탑과 같은 컨벤션으로 "오늘 고가가
// 3R 가격을 찍었는지"로 판정 — 3R가는 진입가로부터 고정 계산되는 값이라(오늘 데이터로
// 새로 만들어내는 임계치가 아님) 트레일링스탑 순서버그와 같은 문제는 없다. 손절
// 청산이 먼저 체크되므로, 같은 날 손절도 나고 3R도 찍는 극단적 경우는 손절이 우선
// (포지션 자체가 사라지니 부분익절 대상이 없음).
// position.stopLossPct(2026-09-19, ATR 가변손절 — 없으면(기존 포지션 객체·
// useAdaptiveStop=false 경로) 기존 고정값 STOP_LOSS_PCT로 하위호환) 기준으로 R배수
// 트리거·트레일링선을 계산한다 — 진입 시점에 정해진 값을 그 포지션의 생애 내내
// 그대로 쓴다(도중에 ATR이 바뀌어도 재계산 안 함 — "그 종목의 진입 당시 변동성
// 성격"으로 손절 체계 자체를 고정하는 설계, 트레일링 자체는 기존처럼 매일 갱신됨).
export function updatePositionForDay(position, dayBar) {
  const stopLossPct = position.stopLossPct ?? STOP_LOSS_PCT;
  if (dayBar.low <= position.stopPrice) {
    return {
      position,
      exit: { exitPrice: position.stopPrice, reason: '트레일링스탑' },
      partialExit: null,
    };
  }
  const highSinceEntry = Math.max(position.highSinceEntry, dayBar.high);

  let partialExit = null;
  let partialSold = position.partialSold;
  if (shouldTakePartialProfit(position.entryPrice, highSinceEntry, position.partialSold, stopLossPct)) {
    partialExit = { exitPrice: rMultiplePrice(position.entryPrice, PARTIAL_PROFIT_TRIGGER_R, stopLossPct), sellFraction: PARTIAL_PROFIT_SELL_FRACTION };
    partialSold = true;
  }

  const rawStop = computeTrailingStop(position.entryPrice, highSinceEntry, stopLossPct);
  const stopPrice = Math.max(position.stopPrice, rawStop); // 래칫 — 절대 하향 안 함
  const addUnit = !position.pyramided && shouldPyramid(position.entryPrice, highSinceEntry, position.units, stopLossPct);
  return {
    position: {
      ...position,
      highSinceEntry,
      stopPrice,
      partialSold,
      units: addUnit ? position.units + 1 : position.units,
      pyramided: addUnit || position.pyramided,
    },
    exit: null,
    partialExit,
  };
}

// 하루치 후보 유니버스 산출 — pool: buildCandidatePool() 결과, seriesByCode: code→
// loadPriceSeries 결과, date: 'YYYY-MM-DD'. 반환: [{code, marcap, closeIdx}] (오늘
// 상장돼 있고 시가총액 하한+유동성 통과한 종목만, 실보유 여부는 호출측이 따로 거른다).
export function computeDailyCandidates(pool, seriesByCode, date, { marketCapFloor, liquidityFloor = LIQUIDITY_FLOOR_WON } = {}) {
  const out = [];
  for (const p of pool) {
    if (p.listingDate && p.listingDate > date) continue;
    if (p.delistingDate && p.delistingDate <= date) continue;
    const series = seriesByCode[p.code];
    if (!series) continue;
    const idx = findIndexAtOrBefore(series.dates, date);
    if (idx < 0 || series.dates[idx] !== date) continue; // 그 날 실제 거래 없으면(휴장 등) 제외
    const close = series.closes[idx];
    if (!(close > 0) || !(p.sharesOutstanding > 0)) continue;
    const marcap = close * p.sharesOutstanding;
    if (marcap < marketCapFloor) continue;
    const avgTradingValue = computeAvgTradingValue(series.closes, series.volumes, idx);
    if (avgTradingValue == null || avgTradingValue < liquidityFloor) continue;
    out.push({ code: p.code, name: p.name, marcap, idx });
  }
  return out;
}

// 전체 백테스트 구동 — pool/seriesByCode/benchmarkSeries는 호출측이 미리 로드해서 넘긴다
// (이 함수 자체는 파일 I/O 안 함, 순수 시뮬레이션 로직). tradingDates: 벤치마크 기준
// 거래일 목록(오름차순). 반환: { trades, equityCurve, finalCapital }.
//
// ⚠️ 체결 타이밍(2026-09-13 수정, 오너 지적): 신호는 당일 "종가"로 확정되지만, 그
// 종가는 장이 끝나야 알 수 있어서 그 가격에 바로 살 수 없다(최초 버전의 문제 —
// 실제로 체결 불가능한 가격을 썼음). 그래서 신호가 뜬 날은 매수를 "예약"만 해두고,
// 실제 진입은 다음 거래일의 시가(Open)로 체결한다 — 하루 뒤처지지만 실제로 낼 수
// 있는 주문이다. 손절/트레일링(저가 터치)은 이미 실제 스탑오더처럼 당일 체결
// 가능해서 그대로 둔다.
export function runBreakoutBacktest({
  pool, seriesByCode, benchmarkSeries, tradingDates, initialCapital,
  marketCapFloor, riskPerTradePct, maxConcurrentPositions = MAX_CONCURRENT_POSITIONS,
  consolidationMethod = 'stddev', volatilityOpts,
  rsPeriods, // 2026-09-15 RS 다구간 비교용 — 지정 안 하면 기존 RS_LOOKBACK_DAYS 단일시점 그대로(회귀 없음)
  rsAnchorSmoothDays, // 2026-09-15 RS 앵커 스무딩 비교용 — 지정 안 하면 기존과 동일(회귀 없음), rsPeriods와 동시지정 시 rsPeriods 우선(breakout-factor.mjs computeBreakoutEntrySignal 참고)
  entryTiming = 'nextDayOpen', // 'nextDayOpen'(기존, 실현가능 지연체결) | 'sameDayClose'(장후시간외 우선체결 가정 — 2026-09-13 오너 요청, 아래 3)단계 참고)
  useBettingUnits = false, // 점진적 배팅(유닛) 사이징 — 오너 지시, 2026-09-14(breakout-unit-tracker.mjs 참고). false(기존 기본값)면 항상 Max2%룰 최대한도로 진입(기존 동작 그대로, 회귀 없음). 2026-09-14 코드리뷰 지적으로 bettingUnits(불리언 플래그)에서 개명 — 같은 파일 안의 currentBettingUnits(개수)와 타입이 헷갈리는 걸 방지.
  initialBettingUnits = MIN_BETTING_UNITS, // 유닛 카운터 시작값 — 백테스트는 기본 1(영상 예시)이지만, 실전(Kairos) State에서 이어받을 카운터를 주입할 통로로 남겨둠(모듈 헤더의 "상태 영속은 호출측 책임" 계약과 일치, 2026-09-14 코드리뷰 지적).
  minRelativeStrength, // 2026-09-19 오너 지적("RS≥0은 너무 열려있다") 대응 — 지정 안 하면 기존과 동일(0, 회귀 없음). breakout-factor.mjs passesRelativeStrengthFilter로 그대로 전달.
  useVolumeConfirmation = false, // 2026-09-19 거래량 확인 조건 비교용 — false(기본)면 기존과 완전 동일(candidate.volumes를 아예 안 넘겨 breakout-factor.mjs가 이 조건 자체를 평가 안 함, 회귀 없음). true면 series.volumes를 신호 계산에 실어 보냄.
  volumeMultiplier, // useVolumeConfirmation=true일 때만 의미 있음 — 지정 안 하면 breakout-factor.mjs VOLUME_CONFIRMATION_MULTIPLIER(1.5) 기본값
  // 2026-09-19 ATR 가변손절(-4%/-8%) 비교용 — false(기본)면 기존과 완전 동일(모든
  // 포지션이 고정 STOP_LOSS_PCT=8%, 회귀 없음). true면 진입 시점 ATR로 포지션별
  // stopLossPct를 정해 생애 내내 고정.
  //
  // ⚠️ 손절폭만 바뀌는 게 아니다(코드리뷰 MEDIUM 지적, 2026-09-19 백테스트 실측) —
  // Max 2%룰 사이징(computePositionSize = capital×riskPct÷stopLossPct)이 손절폭에
  // 반비례라, 좁은 손절(4%)로 진입하는 포지션은 넓은 손절(8%) 대비 투입금액이
  // 정확히 2배(자본의 25%→50%)가 된다. 실측(2026-09-19, 시총1조↑ 318종목 기준):
  // ATR_STOP_THRESHOLD_PCT=4.0 문턱에서 약 31%가 좁은 손절(2배 사이징)을 받는다.
  // 이 때문에 (a) MAX_CONCURRENT_POSITIONS=10 슬롯이 자본 소진으로 다 안 채워질
  // 수 있고(분산 붕괴), (b) 시초가 갭하락으로 손절선을 건너뛸 때 원화 손실도
  // 2배가 된다. 첫 백테스트(2014~2026)에서 useAdaptiveStop=true가 baseline보다
  // 성과가 나빠진 원인이 "손절폭 선택 자체"가 아니라 "동반된 사이징·분산 변화"일
  // 가능성이 있다 — 이 임계값을 재조정해 재검증할 때는 stopLossPct와 사이징을
  // 분리해서(예: 사이징은 8% 기준 고정) 비교해야 두 효과가 안 섞인다.
  useAdaptiveStop = false,
}) {
  let capital = initialCapital;
  const openPositions = new Map(); // code -> position + investedWon
  let pendingEntries = []; // 어제 신호가 확인돼 오늘 시가에 체결 대기 중인 {code, relativeStrength} 목록
  const trades = [];
  const equityCurve = [];
  let skippedNoOpenPrice = 0; // Open 데이터가 없어 예약 체결을 못 한 건수(투명성용)
  let currentBettingUnits = initialBettingUnits; // 계좌 전체 누적 카운터(useBettingUnits=true일 때만 의미 있음)

  // 신규 진입 사이징 — 두 체결 경로(1) nextDayOpen 예약체결, 3) sameDayClose 즉시체결)가
  // 완전히 같은 로직을 써야 해서(2026-09-14 코드리뷰 지적 — 복붙 2곳이 서로 어긋날 여지)
  // 클로저 하나로 뽑음. capital/currentBettingUnits는 let 바인딩이라 호출 시점의 최신값을
  // 그대로 읽는다(클로저가 참조를 캡처, 값이 아님). stopLossPct 파라미터 추가(2026-09-19,
  // ATR 가변손절) — Max 2%룰 자체가 "손절폭에 반비례하는 사이징"이라, 좁은 손절(4%)로
  // 진입하는 포지션은 같은 리스크금액으로 더 큰 금액을 투입해야 원래 취지(리스크 고정)가
  // 맞다. 기본값 STOP_LOSS_PCT 유지로 useAdaptiveStop=false 경로는 기존과 완전 동일.
  const sizeNewEntry = (stopLossPct = STOP_LOSS_PCT) => Math.min(
    useBettingUnits
      ? computeBettingUnitInvestment(capital, currentBettingUnits, { riskPct: riskPerTradePct, stopLossPct })
      : computePositionSize(capital, { riskPct: riskPerTradePct, stopLossPct }),
    capital,
  );

  for (const date of tradingDates) {
    // 오늘 하루치 성공/실패 순변화 — 같은 날 여러 포지션이 동시에 청산될 때 Map
    // 순회순서(=진입순서, 경제적 의미 없음)에 카운터 최종값이 좌우되던 버그를
    // 막기 위해(2026-09-14 코드리뷰 지적) 이벤트를 즉시 반영하지 않고 하루치를
    // 다 모아서 순변화만 계산한 뒤 아래(2단계 끝)에서 딱 한 번 클램프한다 — 덧셈은
    // 교환법칙이 성립해 순서 무관.
    let bettingUnitDelta = 0;
    // 1) 어제 예약된 진입을 오늘 시가로 체결 — 슬롯이 모자라면 RS(상대강도)가 더 강한
    // 종목부터 채운다(오너 지적, 2026-09-13 — 이전엔 후보풀 순서(임의, 경제적 근거
    // 없음)로 아무거나 채웠음, 진입일의 26%가 신호 2건 이상 겹치는 날이라 실제 영향
    // 있는 지점이었음).
    if (pendingEntries.length && openPositions.size < maxConcurrentPositions) {
      const sortedPending = [...pendingEntries].sort((a, b) => b.relativeStrength - a.relativeStrength);
      for (const { code, stopLossPct: pendingStopLossPct } of sortedPending) {
        if (openPositions.size >= maxConcurrentPositions) break;
        if (openPositions.has(code)) continue;
        const series = seriesByCode[code];
        const idx = series ? findIndexAtOrBefore(series.dates, date) : -1;
        if (idx < 0 || series.dates[idx] !== date) continue; // 오늘 거래 없음(휴장 등) — 그냥 흘려보냄(재시도 안 함)
        const openPrice = series.opens[idx];
        if (openPrice == null || !(openPrice > 0)) { skippedNoOpenPrice += 1; continue; } // Open 데이터 없음 — 추정 안 함
        const stopLossPct = pendingStopLossPct ?? STOP_LOSS_PCT;
        const sizeWon = sizeNewEntry(stopLossPct);
        if (!(sizeWon > 0)) continue;
        capital -= sizeWon;
        openPositions.set(code, {
          code, entryDate: date, entryPrice: openPrice, units: 1,
          highSinceEntry: openPrice, stopPrice: openPrice * (1 - stopLossPct), pyramided: false,
          partialSold: false, investedWon: sizeWon, bettingUnitsAtEntry: useBettingUnits ? currentBettingUnits : null,
          stopLossPct,
        });
      }
    }
    pendingEntries = [];

    // 2) 보유 포지션 갱신(트레일링/피라미딩/청산) — 오늘 막 체결된 포지션도 포함(당일 손절 가능)
    for (const [code, pos] of [...openPositions.entries()]) {
      const series = seriesByCode[code];
      const idx = series ? findIndexAtOrBefore(series.dates, date) : -1;
      if (idx < 0 || series.dates[idx] !== date) continue; // 오늘 거래 없음(휴장 등) — 유지
      const dayBar = { high: series.highs[idx], low: series.lows[idx], close: series.closes[idx] };
      if (dayBar.high == null || dayBar.low == null) continue; // 고가/저가 결측 — 판단 보류
      const { position, exit, partialExit } = updatePositionForDay(pos, dayBar);
      if (exit) {
        // 유닛 카운터 갱신(순변화만 누적, 클램프는 2단계 끝에서 한 번만 — 위 설명 참고)
        // — 3R 성공 크레딧을 이미 받은 포지션(partialSold=true, 청산 전 상태 기준)이
        // 나중에 트레일링스탑에 걸려도 "실패"로 다시 깎지 않는다(이미 성공한 거래이므로).
        // 3R 도달 전에 청산되면(원금이 -8%보다 덜 깎였어도) "실패"로 취급하되, 같은 날
        // 3R가도 함께 터치했으면(고가 기준) 미판정으로 남긴다(가정 4, breakout-unit-
        // tracker.mjs 참고 — 실전은 손절·3R익절 주문을 동시에 걸어둬 일중 순서가 불명).
        if (useBettingUnits && !pos.partialSold) {
          const touchedThreeRSameDay = dayBar.high >= rMultiplePrice(pos.entryPrice, BETTING_UNIT_SUCCESS_R);
          if (!touchedThreeRSameDay) bettingUnitDelta -= 1;
        }
        const pnlWon = position.investedWon * (exit.exitPrice / position.entryPrice - 1);
        capital += position.investedWon + pnlWon;
        trades.push({
          code, entryDate: position.entryDate, exitDate: date,
          entryPrice: position.entryPrice, exitPrice: exit.exitPrice,
          units: position.units, investedWon: position.investedWon, pnlWon, reason: exit.reason,
          bettingUnitsAtEntry: position.bettingUnitsAtEntry,
        });
        openPositions.delete(code);
      } else {
        let finalPosition = position;
        if (partialExit) {
          // 3R 최초 도달 = "성공" 크레딧(순변화 누적, breakout-unit-tracker.mjs). partialExit는
          // shouldTakePartialProfit의 !alreadyTaken 가드 덕분에 포지션당 정확히 1회만 발생.
          if (useBettingUnits) bettingUnitDelta += 1;
          const soldWon = position.investedWon * partialExit.sellFraction;
          const pnlWon = soldWon * (partialExit.exitPrice / position.entryPrice - 1);
          capital += soldWon + pnlWon;
          trades.push({
            code, entryDate: position.entryDate, exitDate: date,
            entryPrice: position.entryPrice, exitPrice: partialExit.exitPrice,
            units: position.units, investedWon: soldWon, pnlWon, reason: '3R 부분익절(50%)',
            bettingUnitsAtEntry: position.bettingUnitsAtEntry,
          });
          finalPosition = { ...position, investedWon: position.investedWon - soldWon };
        }
        openPositions.set(code, finalPosition);
      }
    }

    // 오늘 하루치 성공/실패 순변화를 한 번에 반영 — 3)단계(오늘 신규 진입, sameDayClose
    // 즉시체결 포함)가 "오늘 이미 일어난 청산까지 반영된" 최신 카운터를 보도록 여기서
    // 클램프한다(영상 예시 — 같은 날 먼저 성공한 종목의 카운터를 그 다음 신규 진입이
    // 그대로 물려받음, 순서 무관하게 동일 결과가 나옴은 breakout-unit-tracker.mjs
    // nextBettingUnits 상단 주석 참고).
    if (useBettingUnits && bettingUnitDelta !== 0) {
      currentBettingUnits = Math.max(MIN_BETTING_UNITS, Math.min(TOTAL_BETTING_UNITS, currentBettingUnits + bettingUnitDelta));
    }

    // 3) 오늘 종가 기준 신규 신호 탐색
    //    - 'nextDayOpen'(기존): 바로 체결하지 않고 "내일 시가 진입"으로 예약.
    //    - 'sameDayClose': 장후시간외 종가 매수가 우선 시도된다고 가정 — 오늘 종가로
    //      즉시 체결(오늘 중 발견된 신호들끼리는 1)단계와 동일하게 RS 내림차순으로
    //      슬롯을 채운다). 실전 반영 시 이건 "장후시간외 우선 체결" 시나리오의
    //      상한선 근사(체결 성공률 100% 가정)라는 점에 유의 — 실제 체결률은 미실측.
    if (openPositions.size < maxConcurrentPositions) {
      const benchIdx = findIndexAtOrBefore(benchmarkSeries.dates, date);
      const benchmarkCloses = benchIdx >= 0 ? benchmarkSeries.closes.slice(0, benchIdx + 1) : [];
      const candidates = computeDailyCandidates(pool, seriesByCode, date, { marketCapFloor });
      const todaySignals = [];
      for (const cand of candidates) {
        if (openPositions.has(cand.code) || pendingEntries.some((p) => p.code === cand.code)) continue;
        const series = seriesByCode[cand.code];
        const closes = series.closes.slice(0, cand.idx + 1);
        const highs = series.highs.slice(0, cand.idx + 1);
        const lows = series.lows.slice(0, cand.idx + 1);
        // 거래량 확인(2026-09-19, useVolumeConfirmation) — "오늘"=cand.idx, 평균은
        // 어제까지(cand.idx 미포함)라 candidate.volumes는 today를 뺀 슬라이스여야
        // breakout-factor.mjs computeAvgVolume의 "마지막 원소=어제" 관례와 맞는다.
        const volumes = useVolumeConfirmation ? series.volumes.slice(0, cand.idx) : undefined;
        const todayVolume = useVolumeConfirmation ? series.volumes[cand.idx] : undefined;
        const signal = computeBreakoutEntrySignal(
          {
            closes, highs, lows, benchmarkCloses, marcap: cand.marcap, volumes, todayVolume,
          },
          {
            rsLookbackDays: RS_LOOKBACK_DAYS, rsPeriods, rsAnchorSmoothDays, minRelativeStrength,
            week52High: { lookbackDays: HIGH_LOOKBACK_DAYS }, marketCapFloor, consolidationMethod, volatility: volatilityOpts,
            volumeMultiplier,
          },
        );
        if (!signal.pass) continue;
        // ATR 가변손절(2026-09-19, useAdaptiveStop) — 신호 시점(cand.idx, "오늘")의
        // 가격·변동성으로 그 포지션 생애 전체에 쓸 손절폭을 확정한다. ATR 계산 불가
        // (데이터 부족)면 안전한 기존 고정값(STOP_LOSS_PCT, "넓은" 쪽)으로 폴백 —
        // 폴백 자체는 명시적(selectAdaptiveStopLossPct가 null을 돌려줄 때만, 조용히
        // 아무 값이나 쓰지 않음).
        let stopLossPct = STOP_LOSS_PCT;
        if (useAdaptiveStop) {
          const atr = computeATR(highs, lows, closes, closes.length - 1);
          const selected = selectAdaptiveStopLossPct(atr, closes[closes.length - 1]);
          if (selected != null) stopLossPct = selected;
        }
        todaySignals.push({
          code: cand.code, relativeStrength: signal.relativeStrength, closePrice: series.closes[cand.idx], stopLossPct,
        });
      }
      if (entryTiming === 'sameDayClose') {
        const sortedSignals = [...todaySignals].sort((a, b) => b.relativeStrength - a.relativeStrength);
        for (const { code, closePrice, stopLossPct } of sortedSignals) {
          if (openPositions.size >= maxConcurrentPositions) break;
          if (!(closePrice > 0)) continue; // 종가 결측 — 체결 안 함(추정 안 함)
          const sizeWon = sizeNewEntry(stopLossPct);
          if (!(sizeWon > 0)) continue;
          capital -= sizeWon;
          openPositions.set(code, {
            code, entryDate: date, entryPrice: closePrice, units: 1,
            highSinceEntry: closePrice, stopPrice: closePrice * (1 - stopLossPct), pyramided: false,
            partialSold: false, investedWon: sizeWon, bettingUnitsAtEntry: useBettingUnits ? currentBettingUnits : null,
            stopLossPct,
          });
        }
      } else {
        for (const { code, relativeStrength, stopLossPct } of todaySignals) pendingEntries.push({ code, relativeStrength, stopLossPct });
      }
    }

    const openValue = [...openPositions.values()].reduce((sum, pos) => {
      const series = seriesByCode[pos.code];
      const idx = findIndexAtOrBefore(series.dates, date);
      const close = idx >= 0 ? series.closes[idx] : pos.entryPrice;
      return sum + pos.investedWon * (close / pos.entryPrice);
    }, 0);
    equityCurve.push({ date, capital, openValue, totalEquity: capital + openValue });
  }

  const openPositionsAtEnd = [...openPositions.values()].map((pos) => ({
    code: pos.code, entryDate: pos.entryDate, entryPrice: pos.entryPrice,
    units: pos.units, investedWon: pos.investedWon,
  }));

  return {
    trades, equityCurve, finalCapital: capital, openPositionsAtEnd, skippedNoOpenPrice,
    finalBettingUnits: useBettingUnits ? currentBettingUnits : null,
  };
}
