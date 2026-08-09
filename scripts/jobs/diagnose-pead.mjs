#!/usr/bin/env node
// PEAD(실적서프라이즈) 진단 — Phase 10 낙폭 원인분해(diagnose-backtest.mjs)에서 나온
// 워스트기여종목 15개가, SUE(실적서프라이즈) 필터를 적용했다면 낙폭구간
// (2017-08~2020-04) 동안 실제로 걸러졌을지 데이터로 확인한다(2026-08-09, 카이로스
// 제안+오너 승인). scripts/lib/pead.mjs 헤더 주석의 SUE 공식 출처 한계 참고.
//
// ⚠️ 정확한 매수·보유 진입일은 이 스크립트에서 재현하지 않는다(전체 유니버스 재계산
// 없이는 알 수 없음, diagnose-backtest.mjs의 시뮬레이션 결과는 저장되지 않고 요약
// (worstContributors: code/monthsHeld/cumulativeReturn)만 docs/backtest-diagnosis-
// 2016-2026.json에 남아있음). 대신 낙폭구간 전체(33개월)에 걸쳐 매달 SUE를 확인해
// "이 구간 동안 SUE가 음(-)이었던 달의 비율"을 본다 — 특정 진입시점 하나만 보는 것보다
// 오히려 이 종목들이 구간 내내 구조적으로 실적서프라이즈가 나빴는지 더 넓게 보여준다.
import { readFileSync } from 'node:fs';
import { loadEnv } from '../lib/auth.mjs';
import { krCorpCodeByStock } from '../lib/instruments.mjs';
import { fetchNetIncomeHistory, standaloneQuarterlySeries, computeSueSeries, sueAtOrBefore } from '../lib/pead.mjs';

loadEnv();

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function monthlyDates(startDate, endDate) {
  const dates = [];
  const s = new Date(`${startDate}T00:00:00.000Z`);
  let d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return dates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const diagPath = args.diag || new URL('../../docs/backtest-diagnosis-2016-2026.json', import.meta.url).pathname;
  const fetchFromYear = Number(args.fromYear ?? 2014); // SUE 12분기 트레일링 확보용(2015 데이터플로어 감안 여유분)
  const apiKey = process.env.DART_API_KEY;

  const diag = JSON.parse(readFileSync(diagPath, 'utf8'));
  const { peakDate, troughDate } = diag.diagnosis2_drawdownAttribution.window;
  const contributors = diag.diagnosis2_drawdownAttribution.worstContributors;
  const windowMonths = monthlyDates(peakDate, troughDate);
  console.error(`[준비] 낙폭구간 ${peakDate}~${troughDate}(${windowMonths.length}개월), 워스트기여종목 ${contributors.length}개`);

  const results = [];
  for (const c of contributors) {
    const corpCode = krCorpCodeByStock(c.code, apiKey);
    if (!corpCode) {
      results.push({ code: c.code, error: 'corp_code 조회 실패' });
      continue;
    }
    const history = await fetchNetIncomeHistory(corpCode, { fromYear: fetchFromYear, toYear: 2020 }, apiKey);
    const standalone = standaloneQuarterlySeries(history);
    const sueSeries = computeSueSeries(standalone);

    const monthly = windowMonths.map((date) => {
      const found = sueAtOrBefore(sueSeries, date);
      return { date, sue: found?.sue ?? null, asOfDisclosure: found?.disclosureDate ?? null };
    });
    const available = monthly.filter((m) => m.sue != null);
    const negative = available.filter((m) => m.sue < 0);

    results.push({
      code: c.code,
      monthsHeld: c.monthsHeld,
      cumulativeReturn: c.cumulativeReturn,
      sueCoverage: { availableMonths: available.length, totalMonths: monthly.length, coverageRatio: available.length / monthly.length },
      negativeSueRatio: available.length ? negative.length / available.length : null,
      monthly,
    });
    console.error(`[완료] ${c.code}: SUE 확보 ${available.length}/${monthly.length}개월, 음(-)비율 ${available.length ? (negative.length / available.length * 100).toFixed(0) : 'N/A'}%`);
  }

  console.log(JSON.stringify({ window: { peakDate, troughDate }, results }, null, 2));
  console.error('\n※ 이 진단은 SUE 공식 출처(원 논문 미확인, Foster-Olsen-Shevlin 표준정의 사용)와');
  console.error('   정확한 매수 진입일 미재현(구간 전체 월별 SUE로 대체)이라는 두 가지 한계가 있음.');
  console.error('   해석·재검토 판단은 Kairos+오너 몫.');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
