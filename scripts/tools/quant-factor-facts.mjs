#!/usr/bin/env node
// quant-factor-facts.mjs — 퀀트 트랙(Kairos) OCF/P 랭킹 대화형 보고용 Node 결정론
// 사실 조립기. ledger-facts.mjs·rebalance-facts.mjs와 같은 패턴(Node는 사실만 조립,
// 판단은 LLM) — 순위까지만 내고, "진짜로 이 10종목을 살지"는 Kairos 재량.
//
// 흐름: 유니버스(시가총액 상위 350, 코스피200+코스닥150 근사) → 유동성 필터(30억원) →
// 종목별 실제공시일 기준 OCF 조회(fetchOcfPointInTime, 룩어헤드 방지) → OCF/P 순위.
//
// ⚠️ 350종목 × 최대 4회(공시일 확인 재시도) OpenDart 호출이라 시간이 걸린다(수 분 단위,
// fdr-universe.py의 시가총액·유동성 조회보다 오래 걸림 — 매달 1회만 도는 잡이라 감내).
//
// 사용법:
//   node scripts/tools/quant-factor-facts.mjs                # 전체 350종목
//   node scripts/tools/quant-factor-facts.mjs --limit 20      # 상위 20종목만(빠른 확인용)
//   node scripts/tools/quant-factor-facts.mjs --json
import { loadEnv } from '../lib/auth.mjs';
import { fetchQuantUniverse, filterByLiquidity } from '../lib/quant-universe.mjs';
import { krCorpCodeByStock } from '../lib/instruments.mjs';
import { fetchOcfPointInTime } from '../lib/fundamentals.mjs';
import { rankByOcfToPrice } from '../lib/quant-factor.mjs';

// DART_API_KEY는 repo .env에 있고, 다른 잡들처럼 loadEnv()로 명시 로드해야 한다 —
// 안 부르면 fetchOcfPointInTime이 매 종목마다 "DART_API_KEY 미설정"으로 조용히 실패해
// 순위가 0건으로 나온다(2026-08-07 직접 겪은 사고 — 별도 프로세스에서 미리 env를
// export해도 이 스크립트 자신의 프로세스엔 안 남는다는 걸 놓쳤음).
loadEnv();

const JSON_OUT = process.argv.includes('--json');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : null;
if (limitIdx >= 0 && !(Number.isInteger(LIMIT) && LIMIT > 0)) {
  console.error('❌ --limit 은 양의 정수여야 합니다.');
  process.exit(1);
}

// 조회대상 중 이 비율 이상이 실패(법인코드 미해결+OCF조회실패)하면 결과를 신뢰할 수
// 없다고 보고 던진다 — DART_API_KEY 만료·전역 레이트리밋 같은 전역 장애가 "이번 달은
// 후보가 적네" 정도로 조용히 지나가는 걸 막는다. quant-universe.mjs의
// MIN_FILL_RATIO/MAX_NULL_RATIO 가드와 같은 관례(코드리뷰 지적, 2026-08-07).
const MAX_OCF_FAIL_RATIO = 0.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const won = (n) => Math.round(n).toLocaleString('ko-KR');

async function enrichWithOcf(candidates, asOfDate) {
  const apiKey = process.env.DART_API_KEY;
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
        // 다만 원인 자체는 완전히 숨기지 않는다 — 첫 실패 1건만 표본으로 남겨, DART_API_KEY
        // 만료 같은 전역 장애를 "그냥 개별 종목 미스"로 오인하지 않게(코드리뷰 지적).
        if (!JSON_OUT && !sampleErrorLogged) { console.error(`  (표본 오류 — ${c.Name}: ${e.message})`); sampleErrorLogged = true; }
      }
    }
    out.push({ ...c, operCf, disclosureDate });
    if (!JSON_OUT && (i + 1) % 20 === 0) console.error(`  ...${i + 1}/${candidates.length}건 처리`);
    await sleep(50); // OpenDart 배려(fdr-universe.py와 동일 관례)
  }
  const failRatio = candidates.length > 0 ? (unresolvedCorp + ocfFetchFailed) / candidates.length : 0;
  if (failRatio > MAX_OCF_FAIL_RATIO) {
    throw new Error(`OCF 조회 실패율 과다(${(failRatio * 100).toFixed(0)}% · 법인코드미해결 ${unresolvedCorp}건 · 조회실패 ${ocfFetchFailed}건) — DART_API_KEY 만료·레이트리밋 의심, 순위 신뢰불가`);
  }
  return { enriched: out, unresolvedCorp, ocfFetchFailed };
}

async function main() {
  const asOfDate = new Date();
  if (!JSON_OUT) console.error('[1/3] 유니버스·유동성 조회 중...');
  // --limit이 있으면 유니버스 자체도 줄여서 빠른 확인용으로 쓴다(코스피:코스닥 = 200:150
  // 원 비율 유지, 최소 1종목씩은 확보) — 안 그러면 350종목 전체 조회(약 1분) 뒤에야
  // 몇 종목만 잘라내는 낭비가 난다(2026-08-07 첫 테스트에서 겪음).
  const universe = LIMIT
    ? fetchQuantUniverse({ nKospi: Math.max(1, Math.ceil(LIMIT * 200 / 350)), nKosdaq: Math.max(1, Math.ceil(LIMIT * 150 / 350)) })
    : fetchQuantUniverse();
  const liquid = filterByLiquidity(universe);
  const targets = LIMIT ? liquid.slice(0, LIMIT) : liquid;

  if (!JSON_OUT) console.error(`[2/3] 유동성 통과 ${liquid.length}종목 중 ${targets.length}종목 OCF 조회 중(공시일 확인 포함)...`);
  const { enriched, unresolvedCorp, ocfFetchFailed } = await enrichWithOcf(targets, asOfDate);

  if (!JSON_OUT) console.error('[3/3] OCF/P 순위 계산 중...');
  const ranked = rankByOcfToPrice(enriched);

  if (JSON_OUT) {
    console.log(JSON.stringify({ universeCount: universe.length, liquidCount: liquid.length, targetCount: targets.length, unresolvedCorp, ocfFetchFailed, ranked }, null, 2));
    return;
  }

  console.log(`\n[퀀트 트랙 OCF/P 랭킹] 유니버스 ${universe.length} → 유동성통과 ${liquid.length} → 조회대상 ${targets.length}`);
  console.log(`  법인코드 매칭 실패 ${unresolvedCorp}건 · OCF 공시 미확인/조회실패 ${ocfFetchFailed}건 · 순위 산출 ${ranked.length}건\n`);
  console.log('순위  종목명                    OCF/P     시가총액          공시일');
  for (const c of ranked.slice(0, 20)) {
    const zone = c.rank <= 10 ? '매수' : c.rank <= 20 ? '유지(버퍼)' : '';
    console.log(`${String(c.rank).padStart(3)}  ${c.Name.padEnd(20)}  ${(c.ocfToPrice * 100).toFixed(2)}%  ${won(c.Marcap).padStart(15)}원  ${c.disclosureDate ?? '-'}  ${zone}`);
  }
  console.log('\n※ 이 보고는 순위까지만 — 실제 매수·매도 판단은 Kairos 재량(버퍼존 매수10위/매도20위, 동일가중±50% 사이징).');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
