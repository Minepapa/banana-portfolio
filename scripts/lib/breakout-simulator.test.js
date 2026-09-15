import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvgTradingValue,
  updatePositionForDay,
  computeDailyCandidates,
  runBreakoutBacktest,
  RS_LOOKBACK_DAYS,
} from './breakout-simulator.mjs';
import { TOTAL_BETTING_UNITS, MIN_BETTING_UNITS } from './breakout-unit-tracker.mjs';

test('computeAvgTradingValue: 정상 계산', () => {
  const closes = [100, 100, 100, 100, 100];
  const volumes = [10, 20, 30, 40, 50];
  const avg = computeAvgTradingValue(closes, volumes, 4, 5);
  assert.ok(Math.abs(avg - (100 * (10 + 20 + 30 + 40 + 50)) / 5) < 1e-6);
});

test('computeAvgTradingValue: 윈도우 미충족(신규상장 직후 등)이면 null', () => {
  const closes = [100, 100];
  const volumes = [10, 20];
  assert.equal(computeAvgTradingValue(closes, volumes, 1, 20), null);
});

test('updatePositionForDay: 저가가 손절선 안 건드리면 유지', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false };
  const { position: next, exit } = updatePositionForDay(position, { high: 10100, low: 9900, close: 10050 });
  assert.equal(exit, null);
  assert.equal(next.highSinceEntry, 10100);
});

test('updatePositionForDay: 저가가 손절선 건드리면 청산', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false };
  const { exit } = updatePositionForDay(position, { high: 10000, low: 9100, close: 9150 });
  assert.notEqual(exit, null);
  assert.equal(exit.exitPrice, 9200);
});

test('updatePositionForDay: 트레일링스탑은 래칫(고점 갱신 시에만 상향)', () => {
  let position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false };
  // 1R(10800) 도달 → 손절선 본전(10000)으로 상향
  ({ position } = updatePositionForDay(position, { high: 10800, low: 10500, close: 10700 }));
  assert.equal(position.stopPrice, 10000);
  // 다음날 되돌림이 커도(다시 10800을 못 넘음) 손절선은 유지(래칫 — 안 내려감)
  ({ position } = updatePositionForDay(position, { high: 10200, low: 10050, close: 10100 }));
  assert.equal(position.stopPrice, 10000);
});

test('updatePositionForDay: 하루 안에 고가가 래칫 조건을 만족하고 저가가 그 새 손절선을 건드려도, 청산은 어제까지의 손절선 기준(일중 순서 알 수 없음 — 실제 백테스트에서 발견된 회귀 버그)', () => {
  // 어제 손절선 9200(최초, 1R 미도달). 오늘 고가 10800(1R 도달 → 새 손절선 10000)인데
  // 오늘 저가도 10000 이하(9900) — 오늘 하루 안에 오른 뒤 다시 그만큼 빠졌다는 뜻인데,
  // "고가가 먼저"라고 가정해 오늘 새로 잡은 손절선(10000)으로 청산시키면 손익 0%가
  // 되지만, 실제로는 저가가 먼저 왔을 수도 있어(일봉만으론 알 수 없음) 이렇게 청산을
  // 유리하게 잡으면 안 된다 — 어제 확정된 손절선(9200)으로만 판정해야 한다.
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false };
  const { exit } = updatePositionForDay(position, { high: 10800, low: 9100, close: 10000 });
  assert.notEqual(exit, null);
  assert.equal(exit.exitPrice, 9200); // 오늘 새로 올라간 손절선(10000)이 아니라 어제 것
});

test('updatePositionForDay: 3R 도달 시 유닛 추가(피라미딩), 1회만', () => {
  let position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false };
  ({ position } = updatePositionForDay(position, { high: 12400, low: 12000, close: 12300 }));
  assert.equal(position.units, 2);
  assert.equal(position.pyramided, true);
  // 이미 피라미딩했으면 더 안 늘어남
  ({ position } = updatePositionForDay(position, { high: 13000, low: 12800, close: 12900 }));
  assert.equal(position.units, 2);
});

test('updatePositionForDay: 3R 도달 시 50% 부분익절 트리거(1회성), 이후 유지되는 포지션은 계속 트레일링', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200, units: 1, pyramided: false, partialSold: false };
  const { position: next, exit, partialExit } = updatePositionForDay(position, { high: 12400, low: 12000, close: 12300 });
  assert.equal(exit, null);
  assert.notEqual(partialExit, null);
  assert.ok(Math.abs(partialExit.exitPrice - 12400) < 1e-6); // 정확히 3R가(진입가+24%)
  assert.equal(partialExit.sellFraction, 0.5);
  assert.equal(next.partialSold, true);
  assert.equal(next.stopPrice, 11600); // 트레일링은 그대로 진행(3R 도달→2R가)

  // 다음날 다시 3R 이상이어도 두 번째 부분익절은 안 생김(1회성)
  const { partialExit: second } = updatePositionForDay(next, { high: 13000, low: 12800, close: 12900 });
  assert.equal(second, null);
});

test('computeDailyCandidates: 상장폐지 종목·시가총액 미달·유동성 미달 전부 제외', () => {
  const pool = [
    { code: 'A', name: 'A사', sharesOutstanding: 1_000_000_000, listingDate: null, delistingDate: null }, // 대형주+유동성 충분, 통과 예상
    { code: 'B', name: 'B사', sharesOutstanding: 1_000_000_000, listingDate: null, delistingDate: '2019-01-01' }, // 이미 상장폐지
    { code: 'C', name: 'C사', sharesOutstanding: 1_000, listingDate: null, delistingDate: null }, // 시가총액 미달
    { code: 'D', name: 'D사', sharesOutstanding: 1_000_000_000, listingDate: null, delistingDate: null }, // 시가총액은 통과하나 거래량 미미(유동성 미달)
  ];
  const closes = new Array(25).fill(1000);
  const lowVolumes = new Array(25).fill(1); // 거래대금 미미 → 유동성 미달
  const dates = closes.map((_, i) => `2020-01-${String(i + 1).padStart(2, '0')}`);
  const bigVolumes = new Array(25).fill(10_000_000); // 유동성 충분
  const seriesByCode = {
    A: { dates, closes, highs: closes, lows: closes, volumes: bigVolumes },
    C: { dates, closes, highs: closes, lows: closes, volumes: bigVolumes },
    D: { dates, closes, highs: closes, lows: closes, volumes: lowVolumes },
  };
  const candidates = computeDailyCandidates(pool, seriesByCode, dates[24], { marketCapFloor: 1_000_000_000_000 });
  assert.deepEqual(candidates.map((c) => c.code), ['A']);
});

function nthDateString(startDate, n) {
  const d = new Date(`${startDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('runBreakoutBacktest: 신호(종가)→다음날 시가 진입→트레일링스탑 청산까지 전체 흐름', () => {
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [100];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  // 260일간 조용한 흐름(52주 신고가·변동성확장 기준선 충족용) + 259일째 돌파(종가로 신호 확정)
  // + 260일째: 그 신호로 예약된 진입이 이날 시가에 체결된 뒤, 같은 날 안에 급락해 손절.
  for (let i = 1; i <= 260; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05; // 돌파(종가 기준 신호 확정 — 진입은 아직 안 함)
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else {
      const openPrice = closes[closes.length - 1]; // 전날 종가 근처에서 시가 형성(갭 없음) — 예약 진입 체결가
      const c = openPrice * 0.85; // 진입 당일 장중 급락(손절 유발)
      opens.push(openPrice); closes.push(c); highs.push(openPrice); lows.push(c * 0.98); volumes.push(50_000_000);
    }
  }
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }]; // 종가~100원×20억주=시총 2000억원↑(마켓캡 하한 통과용)
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) }; // 벤치마크는 안 움직임(RS 항상 유리)

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
  });

  assert.ok(result.trades.length >= 1, '최소 1건 진입/청산이 발생해야 함');
  const trade = result.trades[0];
  assert.equal(trade.code, 'A');
  assert.equal(trade.entryDate, dates[260], '진입일은 신호가 뜬 259일이 아니라 다음 거래일(260일)이어야 함');
  assert.ok(trade.pnlWon < 0, '급락 후 손절이라 손실 거래여야 함');
  assert.equal(result.equityCurve.length, dates.length);

  // rsPeriods 배선 검증(2026-09-15 코드리뷰 MEDIUM 지적 — runBreakoutBacktest→
  // computeBreakoutEntrySignal로 가는 경로가 테스트 0건이었음) — 기존 기본값(단일
  // RS_LOOKBACK_DAYS 시점)과 동치인 rsPeriods를 명시로 넘겨도 완전히 같은 결과가
  // 나와야 배선이 올바른 것.
  const resultViaPeriods = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    rsPeriods: [{ days: RS_LOOKBACK_DAYS, weight: 1 }],
  });
  assert.deepEqual(resultViaPeriods.trades, result.trades);
});

test('runBreakoutBacktest: 3R 도달 시 50% 부분익절 거래가 별도로 기록되고, 나머지 50%는 계속 트레일링 후 청산', () => {
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [100];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  for (let i = 1; i <= 262; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05; // 돌파(신호 확정)
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else if (i === 260) {
      const openPrice = closes[closes.length - 1]; // 예약 진입 체결가(entryPrice)
      opens.push(openPrice); closes.push(openPrice); highs.push(openPrice * 1.01); lows.push(openPrice * 0.99); volumes.push(50_000_000); // 진입일은 잔잔
    } else if (i === 261) {
      const entryPrice = closes[260];
      opens.push(closes[closes.length - 1]);
      closes.push(entryPrice * 1.22); highs.push(entryPrice * 1.25); lows.push(entryPrice * 1.20); volumes.push(50_000_000); // 3R(+24%) 돌파 → 부분익절 트리거
    } else {
      const entryPrice = closes[260];
      opens.push(closes[closes.length - 1]);
      closes.push(entryPrice * 1.10); highs.push(entryPrice * 1.16); lows.push(entryPrice * 1.10); volumes.push(50_000_000); // 2R(+16%) 손절선까지 급락
    }
  }
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }];
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
  });

  const entryPrice = closes[260];
  const partial = result.trades.find((t) => t.reason === '3R 부분익절(50%)');
  assert.notEqual(partial, undefined, '3R 부분익절 거래가 기록돼야 함');
  assert.ok(Math.abs(partial.exitPrice - entryPrice * 1.24) < 1, '부분익절가는 정확히 3R가');
  assert.ok(partial.pnlWon > 0);

  const final = result.trades.find((t) => t.reason === '트레일링스탑' && t.exitDate > partial.exitDate);
  assert.notEqual(final, undefined, '나머지 50%도 결국 트레일링스탑으로 청산돼야 함');
  assert.ok(Math.abs(final.exitPrice - entryPrice * 1.16) < 1, '남은 절반의 손절선은 3R 도달 후 2R가로 래칫돼 있어야 함');
  assert.ok(Math.abs(partial.investedWon - final.investedWon) < 1, '부분익절·잔여 청산 두 거래의 투입금이 원래 포지션의 절반씩으로 같아야 함');
});

test('runBreakoutBacktest: useBettingUnits=true면 첫 진입은 1유닛(=Max2%룰 최대한도÷5)으로만 들어가고, 3R 성공 후 카운터가 오른다', () => {
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [100];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  for (let i = 1; i <= 262; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05; // 돌파(신호 확정)
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else if (i === 260) {
      const openPrice = closes[closes.length - 1];
      opens.push(openPrice); closes.push(openPrice); highs.push(openPrice * 1.01); lows.push(openPrice * 0.99); volumes.push(50_000_000);
    } else if (i === 261) {
      const entryPrice = closes[260];
      opens.push(closes[closes.length - 1]);
      closes.push(entryPrice * 1.22); highs.push(entryPrice * 1.25); lows.push(entryPrice * 1.20); volumes.push(50_000_000); // 3R(+24%) 돌파 → 성공 크레딧
    } else {
      const entryPrice = closes[260];
      opens.push(closes[closes.length - 1]);
      closes.push(entryPrice * 1.10); highs.push(entryPrice * 1.16); lows.push(entryPrice * 1.10); volumes.push(50_000_000);
    }
  }
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }];
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    useBettingUnits: true,
  });

  // ceiling = 40,000,000 × 0.02 / 0.08 = 10,000,000 → 1유닛(MIN_BETTING_UNITS=1/TOTAL_BETTING_UNITS=5) = 2,000,000
  const ceiling = (40_000_000 * 0.02) / 0.08;
  const firstEntryExpected = ceiling * (MIN_BETTING_UNITS / TOTAL_BETTING_UNITS);
  const partial = result.trades.find((t) => t.reason === '3R 부분익절(50%)');
  assert.notEqual(partial, undefined);
  assert.equal(partial.bettingUnitsAtEntry, MIN_BETTING_UNITS, '이 백테스트의 첫(유일한) 거래이므로 1유닛에서 시작해야 함');
  assert.ok(Math.abs(partial.investedWon * 2 - firstEntryExpected) < 1, '진입 투입금은 최대한도의 1/5(1유닛)이어야 함(2로 곱한 건 부분익절이 절반이라서)');
  assert.equal(result.finalBettingUnits, MIN_BETTING_UNITS + 1, '3R 성공 1건 후 카운터가 1→2로 올라가야 함');
});

test('runBreakoutBacktest: 성공(3R) 후 실패(-8%손절) 순서로 카운터가 1→2→1로 실제 차감된다(실패 경로 배선 검증)', () => {
  // 이 테스트가 존재하는 이유(2026-09-14 코드리뷰 지적) — 기존 테스트는 성공 경로만
  // 탔다: 실패 시 카운터를 깎는 코드 한 줄을 통째로 지워도 그 테스트들은 전부
  // 통과했다. 이 테스트는 그 한 줄이 실제로 배선돼 있는지를 검증한다.
  const TOTAL_DAYS = 275;
  const quietWiggle = (prevClose, i) => prevClose * (i % 2 === 0 ? 1.001 : 0.999);

  // A: day259에 돌파 → day260 진입 → day261에 3R 도달(성공, 카운터 1→2). 이후는
  // 조용히 유지(다시 건드리지 않음 — partialSold=true라 나중에 청산돼도 무관).
  const aDates = [nthDateString('2020-01-01', 0)];
  const aOpens = [100]; const aCloses = [100]; const aHighs = [100]; const aLows = [100]; const aVolumes = [50_000_000];
  // B: day264에 돌파 → day265 진입(이때 A는 이미 성공해 카운터=2, B는 2유닛으로
  // 시작) → day266에 -8% 손절(3R는 안 건드림, 실패 — 카운터 2→1).
  const bDates = [nthDateString('2020-01-01', 0)];
  const bOpens = [100]; const bCloses = [100]; const bHighs = [100]; const bLows = [100]; const bVolumes = [50_000_000];

  for (let i = 1; i < TOTAL_DAYS; i++) {
    aDates.push(nthDateString('2020-01-01', i));
    bDates.push(nthDateString('2020-01-01', i));

    if (i === 259) { // A 돌파
      const c = aCloses[aCloses.length - 1] * 1.05;
      aOpens.push(aCloses[aCloses.length - 1]); aCloses.push(c); aHighs.push(c * 1.01); aLows.push(aCloses[aCloses.length - 2]); aVolumes.push(50_000_000);
    } else if (i === 260) { // A 진입 체결일(조용)
      const openPrice = aCloses[aCloses.length - 1];
      aOpens.push(openPrice); aCloses.push(openPrice); aHighs.push(openPrice * 1.01); aLows.push(openPrice * 0.99); aVolumes.push(50_000_000);
    } else if (i === 261) { // A 3R 도달(성공)
      const entryPrice = aCloses[260];
      aOpens.push(aCloses[aCloses.length - 1]);
      aCloses.push(entryPrice * 1.22); aHighs.push(entryPrice * 1.25); aLows.push(entryPrice * 1.20); aVolumes.push(50_000_000);
    } else { // 나머지는 전부 조용(신규 신호·재청산 유발 안 함)
      const c = quietWiggle(aCloses[aCloses.length - 1], i);
      aOpens.push(aCloses[aCloses.length - 1]); aCloses.push(c); aHighs.push(c * 1.001); aLows.push(c * 0.999); aVolumes.push(50_000_000);
    }

    if (i === 264) { // B 돌파
      const c = bCloses[bCloses.length - 1] * 1.05;
      bOpens.push(bCloses[bCloses.length - 1]); bCloses.push(c); bHighs.push(c * 1.01); bLows.push(bCloses[bCloses.length - 2]); bVolumes.push(50_000_000);
    } else if (i === 265) { // B 진입 체결일(조용)
      const openPrice = bCloses[bCloses.length - 1];
      bOpens.push(openPrice); bCloses.push(openPrice); bHighs.push(openPrice * 1.01); bLows.push(openPrice * 0.99); bVolumes.push(50_000_000);
    } else if (i === 266) { // B -8% 손절(3R는 전혀 안 건드림 — 명백한 실패)
      const entryPrice = bCloses[265];
      bOpens.push(bCloses[bCloses.length - 1]);
      bCloses.push(entryPrice * 0.95); bHighs.push(entryPrice * 1.02); bLows.push(entryPrice * 0.90); bVolumes.push(50_000_000);
    } else {
      const c = quietWiggle(bCloses[bCloses.length - 1], i);
      bOpens.push(bCloses[bCloses.length - 1]); bCloses.push(c); bHighs.push(c * 1.001); bLows.push(c * 0.999); bVolumes.push(50_000_000);
    }
  }

  const pool = [
    { code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
    { code: 'B', name: 'B사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
  ];
  const seriesByCode = {
    A: { dates: aDates, opens: aOpens, closes: aCloses, highs: aHighs, lows: aLows, volumes: aVolumes },
    B: { dates: bDates, opens: bOpens, closes: bCloses, highs: bHighs, lows: bLows, volumes: bVolumes },
  };
  const benchmarkSeries = { dates: aDates, closes: new Array(aDates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: aDates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    useBettingUnits: true,
  });

  const bEntry = result.trades.find((t) => t.code === 'B' && t.reason === '트레일링스탑');
  assert.notEqual(bEntry, undefined, 'B가 손절로 청산돼야 함');
  assert.equal(bEntry.bettingUnitsAtEntry, MIN_BETTING_UNITS + 1, 'B는 A의 성공 크레딧을 물려받아 2유닛으로 시작해야 함');
  assert.equal(result.finalBettingUnits, MIN_BETTING_UNITS, 'A 성공(1→2) 후 B 실패(2→1)로 결국 1로 돌아와야 함');
});

test('runBreakoutBacktest: useBettingUnits=false(기본값)면 finalBettingUnits는 null', () => {
  const dates = [nthDateString('2020-01-01', 0), nthDateString('2020-01-01', 1)];
  const pool = [];
  const seriesByCode = {};
  const benchmarkSeries = { dates, closes: [100, 100] };
  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
  });
  assert.equal(result.finalBettingUnits, null);
});

test('runBreakoutBacktest: Open 데이터 없는 종목은 예약 진입을 스킵(추정 안 함)', () => {
  const dates = [nthDateString('2020-01-01', 0)];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  for (let i = 1; i <= 260; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else {
      const c = closes[closes.length - 1] * 1.05;
      closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    }
  }
  const opens = new Array(dates.length).fill(null); // Open 컬럼 없는 구버전 캐시 상황 재현
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }];
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
  });

  assert.equal(result.trades.length, 0);
  assert.ok(result.skippedNoOpenPrice >= 1);
});

// 259일째(돌파일)까지 동일한 흐름(조용한 25일+돌파)을 재현하되, 0~199일 구간의
// 절대가격 수준만 다르게 줘서 RS(60일 구간, 259-60=199일 시점 대비 상승률)를
// 의도적으로 갈라놓는다 — 52주신고가·변동성확장 판정은 최근 구간(200일 이후)만
// 보므로 영향 없음.
function buildRsDifferentiatedSeries(basePriceBefore200) {
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [basePriceBefore200];
  const closes = [basePriceBefore200];
  const highs = [basePriceBefore200];
  const lows = [basePriceBefore200];
  const volumes = [50_000_000];
  for (let i = 1; i <= 260; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 200) {
      opens.push(basePriceBefore200); closes.push(basePriceBefore200);
      highs.push(basePriceBefore200); lows.push(basePriceBefore200); volumes.push(50_000_000);
    } else if (i < 259) {
      const prev = i === 200 ? 100 : closes[closes.length - 1];
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = prev * wiggle;
      opens.push(prev); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else {
      opens.push(closes[closes.length - 1]); closes.push(closes[closes.length - 1]);
      highs.push(closes[closes.length - 1]); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    }
  }
  return { dates, opens, closes, highs, lows, volumes };
}

test('runBreakoutBacktest: 하루에 신호가 여러 건 겹치고 슬롯이 모자라면 RS(상대강도) 더 강한 종목부터 채운다', () => {
  const seriesB = buildRsDifferentiatedSeries(80); // 199일 시점 80원 → 259일 시점까지 더 많이 오른 셈 = RS 더 높음
  const seriesC = buildRsDifferentiatedSeries(100); // 199일 시점 100원 → RS 더 낮음
  const dates = seriesB.dates;
  const pool = [
    { code: 'B', name: 'B사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
    { code: 'C', name: 'C사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
  ];
  const seriesByCode = { B: seriesB, C: seriesC };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    maxConcurrentPositions: 1, // 슬롯 1개뿐 — 둘 다 신호가 떠도 하나만 체결 가능
  });

  const entered = result.trades.map((t) => t.code).concat(result.openPositionsAtEnd.map((p) => p.code));
  assert.ok(entered.includes('B'), 'RS가 더 높은 B가 체결돼야 함');
  assert.ok(!entered.includes('C'), 'RS가 더 낮은 C는 슬롯 부족으로 밀려야 함');
});

test("runBreakoutBacktest: entryTiming='sameDayClose'면 신호 확정일 종가로 즉시 체결(다음날 시가 대기 없음)", () => {
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [100];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  for (let i = 1; i <= 260; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05; // 돌파(종가로 신호 확정)
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else {
      opens.push(closes[closes.length - 1]); closes.push(closes[closes.length - 1]);
      highs.push(closes[closes.length - 1]); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    }
  }
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }];
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    entryTiming: 'sameDayClose',
  });

  const entered = result.openPositionsAtEnd.find((p) => p.code === 'A');
  assert.notEqual(entered, undefined, '신호 확정 즉시 체결돼야 함');
  assert.equal(entered.entryDate, dates[259], '진입일이 신호 확정일(다음 거래일이 아님)이어야 함');
  assert.ok(Math.abs(entered.entryPrice - closes[259]) < 1e-6, '진입가가 신호 확정일 종가여야 함');
});

test("runBreakoutBacktest: entryTiming='sameDayClose'에서도 useBettingUnits가 적용된다(진입 지점 2곳이 어긋나지 않는지 검증)", () => {
  // 2026-09-14 코드리뷰 지적 — nextDayOpen 경로만 테스트가 있었고 sameDayClose
  // 경로는 사이징 로직을 원래 computePositionSize로 되돌려도 아무 테스트도 실패하지
  // 않는 상태였다. 두 진입 지점이 공유 클로저(sizeNewEntry)를 쓰도록 고친 뒤,
  // 이 테스트로 실제 배선을 확인한다.
  const dates = [nthDateString('2020-01-01', 0)];
  const opens = [100];
  const closes = [100];
  const highs = [100];
  const lows = [100];
  const volumes = [50_000_000];
  for (let i = 1; i <= 260; i++) {
    dates.push(nthDateString('2020-01-01', i));
    if (i < 259) {
      const wiggle = i % 2 === 0 ? 1.001 : 0.999;
      const c = closes[closes.length - 1] * wiggle;
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.001); lows.push(c * 0.999); volumes.push(50_000_000);
    } else if (i === 259) {
      const c = closes[closes.length - 1] * 1.05; // 돌파(종가로 신호 확정)
      opens.push(closes[closes.length - 1]); closes.push(c); highs.push(c * 1.01); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    } else {
      opens.push(closes[closes.length - 1]); closes.push(closes[closes.length - 1]);
      highs.push(closes[closes.length - 1]); lows.push(closes[closes.length - 1]); volumes.push(50_000_000);
    }
  }
  const pool = [{ code: 'A', name: 'A사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null }];
  const seriesByCode = { A: { dates, opens, closes, highs, lows, volumes } };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    entryTiming: 'sameDayClose', useBettingUnits: true,
  });

  const ceiling = (40_000_000 * 0.02) / 0.08;
  const entered = result.openPositionsAtEnd.find((p) => p.code === 'A');
  assert.notEqual(entered, undefined);
  assert.equal(entered.units, 1); // position.units(불타기 카운트)는 무관 — 항상 1에서 시작
  assert.ok(Math.abs(entered.investedWon - ceiling / 5) < 1, '첫 거래이므로 1유닛(=최대한도의 1/5)으로 들어가야 함 — 기존 방식(풀사이즈)이었다면 이 값의 5배였을 것');
});

test("runBreakoutBacktest: entryTiming='sameDayClose'에서도 슬롯 부족 시 RS 더 강한 종목부터 당일 체결", () => {
  const seriesB = buildRsDifferentiatedSeries(80); // RS 더 높음
  const seriesC = buildRsDifferentiatedSeries(100); // RS 더 낮음
  const dates = seriesB.dates;
  const pool = [
    { code: 'B', name: 'B사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
    { code: 'C', name: 'C사', sharesOutstanding: 2_000_000_000, listingDate: null, delistingDate: null },
  ];
  const seriesByCode = { B: seriesB, C: seriesC };
  const benchmarkSeries = { dates, closes: new Array(dates.length).fill(100) };

  const result = runBreakoutBacktest({
    pool, seriesByCode, benchmarkSeries, tradingDates: dates,
    initialCapital: 40_000_000, marketCapFloor: 100_000_000_000, riskPerTradePct: 0.02,
    maxConcurrentPositions: 1, entryTiming: 'sameDayClose',
  });

  const entered = result.trades.map((t) => t.code).concat(result.openPositionsAtEnd.map((p) => p.code));
  assert.ok(entered.includes('B'), 'RS가 더 높은 B가 당일 종가로 체결돼야 함');
  assert.ok(!entered.includes('C'), 'RS가 더 낮은 C는 슬롯 부족으로 밀려야 함');
  const positionB = result.openPositionsAtEnd.find((p) => p.code === 'B');
  assert.equal(positionB.entryDate, dates[259], '체결일은 신호 확정일 당일이어야 함(다음날 아님)');
});
