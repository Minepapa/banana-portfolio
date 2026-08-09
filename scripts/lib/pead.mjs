// PEAD(실적발표 후 주가표류) 진단 전용 — 낙폭구간 워스트기여종목에 SUE(실적서프라이즈)
// 필터를 적용했을 때 실제로 걸러졌을지 데이터로 확인한다(2026-08-09, 카이로스 제안+오너
// 승인). 채택된 정식 팩터가 아니라 05 백테스트 후보 검증용 진단 도구 — OCF/P 프로덕션
// 캐시(ocf-history-cache.mjs)와는 완전히 별도 경로, 그쪽 스키마·데이터는 건드리지 않는다.
//
// ⚠️ SUE 공식 출처 한계(정직히 명시): 이 프로젝트가 PEAD 채택 근거로 인용한 두 한국 논문
// (Goh & Jeon 2017, Pacific-Basin Finance Journal; Shin·Shin·Kim 2019, Sustainability)의
// 원문 방법론(SUE 정확 공식·드리프트 기간·분위수 구성)은 유료장벽으로 확인하지 못했다
// (document-specialist 조사, 2026-08-09 — WebFetch·Playwright 모두 시도, ScienceDirect는
// 초록만 공개·MDPI는 봇차단). 여기 쓰는 SUE는 Foster·Olsen·Shevlin(1984)의 "계절성
// 랜덤워크" 정의 — PEAD 문헌에서 가장 널리 쓰이는 교과서적 공식이지만, 위 두 논문이 실제로
// 이 공식을 그대로 썼다는 보장은 없다. 오너 승인 하에 이 한계를 감수하고 진행(2026-08-09).
import { extractNetIncome, fetchCfListWithDisclosureDate } from './fundamentals.mjs';

const QUARTERLY_ORDER = ['11013', '11012', '11014', '11011'];
const Q_ORDER_IDX = Object.fromEntries(QUARTERLY_ORDER.map((c, i) => [c, i]));
// 회계연도 내 4개 보고서 종류를 공시 순서대로(1분기→반기→3분기→사업보고서, ocf-history-cache.mjs
// QUARTERLY_ORDER·fundamentals.mjs reprtCodeForDate 컨벤션과 동일 코드값).
const SAME_YEAR_PRIOR_REPORT = { 11012: '11013', 11014: '11012', 11011: '11014' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// corpCode 하나의 [fromYear,toYear] 분기별 누적 당기순이익 이력 — ocf-history-cache.mjs
// fetchOcfHistory와 동일 네트워크 패턴(fetchCfListWithDisclosureDate 재사용 — 정정공시로
// 공시일이 밀리는 문제 보정 포함, fundamentals.mjs 헤더 주석 참고), extractOcf 대신
// extractNetIncome으로 같은 응답에서 다른 항목을 뽑을 뿐이다(같은 fnlttSinglAcntAll.json
// 호출 — 별도 API 부담 없음). 이 진단은 소수 종목(낙폭구간 워스트기여종목)만 대상이라
// ocf-history-cache.mjs 같은 대량 캐시·크래시 안전 배치 설계는 필요 없다(스코프 의도적 축소).
export async function fetchNetIncomeHistory(corpCode, { fromYear, toYear }, apiKey, { onProgress } = {}) {
  const out = [];
  let attempted = 0;
  const total = (toYear - fromYear + 1) * QUARTERLY_ORDER.length;
  for (let year = fromYear; year <= toYear; year++) {
    for (const reprtCode of QUARTERLY_ORDER) {
      attempted++;
      const period = { bsnsYear: String(year), reprtCode };
      const result = await fetchCfListWithDisclosureDate(corpCode, period, apiKey).catch(() => null);
      if (result) {
        const { list, disclosureDate } = result;
        const netIncome = extractNetIncome(list);
        if (disclosureDate && netIncome != null) out.push({ bsnsYear: period.bsnsYear, reprtCode, disclosureDate, netIncome });
      }
      onProgress?.(attempted, total);
      await sleep(50); // OpenDart 배려(ocf-history-cache.mjs와 동일 관례)
    }
  }
  out.sort((a, b) => a.disclosureDate.localeCompare(b.disclosureDate));
  return out;
}

// 누적치 이력 → 단독분기 이력 + quarterIndex(연도*4+분기서수, 결측분기가 있어도 "4분기 전"
// 비교가 배열 인덱스가 아니라 실제 회계분기 기준으로 정확히 맞도록). 1분기(11013)는 이미
// 단독이라 그대로, 그 외는 "같은 해 직전 리포트" 누적치를 자체 이력 안에서 찾아 빼서 환산
// (fundamentals.mjs quarterStandalone과 동일 원리 — 별도 API 호출 없이 이미 수집한 이력
// 내에서 직접 계산). 같은 해 직전 리포트가 이력에 없으면(공시 누락 등) null(추정 안 함).
export function standaloneQuarterlySeries(history) {
  const byKey = new Map((history ?? []).map((h) => [`${h.bsnsYear}-${h.reprtCode}`, h]));
  const out = (history ?? []).map((h) => {
    const priorCode = SAME_YEAR_PRIOR_REPORT[h.reprtCode];
    let standalone;
    if (!priorCode) {
      standalone = h.netIncome; // 1분기: 이미 단독분기
    } else {
      const prior = byKey.get(`${h.bsnsYear}-${priorCode}`);
      standalone = prior ? h.netIncome - prior.netIncome : null;
    }
    return {
      bsnsYear: h.bsnsYear, reprtCode: h.reprtCode, disclosureDate: h.disclosureDate,
      quarterIndex: Number(h.bsnsYear) * 4 + Q_ORDER_IDX[h.reprtCode],
      standalone,
    };
  });
  return out.sort((a, b) => a.quarterIndex - b.quarterIndex);
}

function sampleStd(values) {
  if (values.length < 2) return null;
  const m = values.reduce((s, x) => s + x, 0) / values.length;
  const variance = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// SUE(Standardized Unexpected Earnings, Foster·Olsen·Shevlin 1984 계절성 랜덤워크 정의):
// SUE_t = (E_t − E_t-4) / σ(과거 8분기의 같은 전년동기차분, t-1..t-8 각각의 (E−E-4)).
// quarterIndex로 조회하므로 standaloneQuarterlySeries의 결측(gap)이 있어도 "4분기 전"이
// 잘못된 이웃 인덱스를 가리키지 않는다(정확히 그 회계분기가 없으면 그 자체로 계산 불가 →
// null, 보간하지 않음). 최소 13개 분기(현재+과거12) quarterIndex가 모두 존재해야 계산됨.
export function computeSueSeries(standaloneSeries) {
  const s = standaloneSeries ?? [];
  const byQ = new Map(s.map((e) => [e.quarterIndex, e]));
  return s.map((e) => {
    let sue = null;
    if (e.standalone != null) {
      const diffs = [];
      let ok = true;
      for (let d = 0; d <= 8; d++) {
        const cur = byQ.get(e.quarterIndex - d);
        const prior = byQ.get(e.quarterIndex - d - 4);
        if (!cur || !prior || cur.standalone == null || prior.standalone == null) { ok = false; break; }
        diffs.push(cur.standalone - prior.standalone);
      }
      if (ok) {
        const target = diffs[0];              // d=0: 이번 분기의 전년동기 대비 차분
        const historyDiffs = diffs.slice(1);   // d=1..8: 과거 8분기의 같은 차분(표준화 기준)
        const sigma = sampleStd(historyDiffs);
        if (sigma != null && sigma > 0) sue = target / sigma;
      }
    }
    return { ...e, sue };
  });
}

// targetDate 이하 공시일 중 가장 최근 SUE — ocf-history-cache.mjs findOcfAtOrBefore와
// 동일한 룩어헤드 방지 원칙(공시일 기준으로만 "그 시점에 이미 알려져 있던" 값만 고른다).
export function sueAtOrBefore(sueSeries, targetDate) {
  let best = null;
  for (const h of sueSeries ?? []) {
    if (h.sue == null) continue;
    if (h.disclosureDate <= targetDate && (!best || h.disclosureDate > best.disclosureDate)) best = h;
  }
  return best;
}
