// 퀀트 트랙 월간 랭킹 오케스트레이션 — 유니버스→유동성→종목별 OCF 조회→순위(구현계획서
// Phase 9). quant-factor-facts.mjs(랭킹 보고)와 quant-reconstitution-facts.mjs(리컨스티튜션
// 판정)가 완전히 동일한 로직을 공유한다 — 특히 아래 전역장애 가드(MAX_OCF_FAIL_RATIO)가
// 두 곳에 따로 복사돼 있으면 한쪽만 고쳐지는 회귀 위험이 있어 하나로 합침(2026-08-07).
import { fetchQuantUniverse, filterByLiquidity } from './quant-universe.mjs';
import { krCorpCodeByStock } from './instruments.mjs';
import { fetchOcfPointInTime } from './fundamentals.mjs';
import { rankByOcfToPrice } from './quant-factor.mjs';

// 조회대상 중 이 비율 이상이 실패(법인코드미해결+OCF조회실패)하면 결과를 신뢰할 수 없다고
// 보고 던진다 — DART_API_KEY 만료·전역 레이트리밋 같은 전역 장애가 "이번 달은 후보가
// 적네" 정도로 조용히 지나가는 걸 막는다. quant-universe.mjs의 MIN_FILL_RATIO/
// MAX_NULL_RATIO 가드와 같은 관례(코드리뷰 지적, 2026-08-07).
export const MAX_OCF_FAIL_RATIO = 0.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// candidates: fdr-universe.py 유동성필터 통과 후보([{Code, Name, Marcap, ...}]).
// onProgress(processedCount, total): 20건마다 호출(호출측 로깅용, 없으면 무시).
// onSampleError(name, error): 첫 실패 1건만 호출(전역 장애 원인 표본 — 호출측 로깅용).
export async function enrichWithOcf(candidates, asOfDate, { apiKey = process.env.DART_API_KEY, onProgress, onSampleError } = {}) {
  const out = [];
  let unresolvedCorp = 0, ocfFetchFailed = 0, sampleErrorLogged = false;
  for (const [i, c] of candidates.entries()) {
    const corpCode = krCorpCodeByStock(c.Code, apiKey);
    let operCf = null, disclosureDate = null;
    if (!corpCode) {
      unresolvedCorp++;
    } else {
      try {
        const r = await fetchOcfPointInTime(corpCode, asOfDate, apiKey);
        if (r) { operCf = r.operCf; disclosureDate = r.disclosureDate; } else ocfFetchFailed++;
      } catch (e) {
        ocfFetchFailed++; // 개별 종목 실패는 조용히 null — 전체 잡은 안 죽음(다른 *-facts.mjs와 동일 관례)
        if (!sampleErrorLogged) { onSampleError?.(c.Name, e); sampleErrorLogged = true; }
      }
    }
    out.push({ ...c, operCf, disclosureDate });
    if ((i + 1) % 20 === 0) onProgress?.(i + 1, candidates.length);
    await sleep(50); // OpenDart 배려(fdr-universe.py와 동일 관례)
  }
  const failRatio = candidates.length > 0 ? (unresolvedCorp + ocfFetchFailed) / candidates.length : 0;
  if (failRatio > MAX_OCF_FAIL_RATIO) {
    throw new Error(`OCF 조회 실패율 과다(${(failRatio * 100).toFixed(0)}% · 법인코드미해결 ${unresolvedCorp}건 · 조회실패 ${ocfFetchFailed}건) — DART_API_KEY 만료·레이트리밋 의심, 순위 신뢰불가`);
  }
  return { enriched: out, unresolvedCorp, ocfFetchFailed };
}

// limit이 있으면 유니버스 자체도 줄여서 빠른 확인용으로 쓴다(코스피:코스닥 = 200:150 원
// 비율 유지, 최소 1종목씩은 확보) — 안 그러면 350종목 전체 조회(약 1분) 뒤에야 몇 종목만
// 잘라내는 낭비가 난다.
export async function computeMonthlyRanking({ limit = null, asOfDate = new Date(), apiKey = process.env.DART_API_KEY, onProgress, onSampleError } = {}) {
  const universe = limit
    ? fetchQuantUniverse({ nKospi: Math.max(1, Math.ceil(limit * 200 / 350)), nKosdaq: Math.max(1, Math.ceil(limit * 150 / 350)) })
    : fetchQuantUniverse();
  const liquid = filterByLiquidity(universe);
  const targets = limit ? liquid.slice(0, limit) : liquid;

  const { enriched, unresolvedCorp, ocfFetchFailed } = await enrichWithOcf(targets, asOfDate, { apiKey, onProgress, onSampleError });
  const ranked = rankByOcfToPrice(enriched);

  return { universeCount: universe.length, liquidCount: liquid.length, targetCount: targets.length, unresolvedCorp, ocfFetchFailed, ranked };
}
