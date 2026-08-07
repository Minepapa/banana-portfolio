#!/usr/bin/env node
// quant-factor-facts.mjs — 퀀트 트랙(Kairos) OCF/P 랭킹 대화형 보고용 Node 결정론
// 사실 조립기. ledger-facts.mjs·rebalance-facts.mjs와 같은 패턴(Node는 사실만 조립,
// 판단은 LLM) — 순위까지만 내고, "진짜로 이 10종목을 살지"는 Kairos 재량.
//
// 흐름: 유니버스(시가총액 상위 350, 코스피200+코스닥150 근사) → 유동성 필터(30억원) →
// 종목별 실제공시일 기준 OCF 조회(fetchOcfPointInTime, 룩어헤드 방지) → OCF/P 순위.
// 오케스트레이션 본체는 quant-ranking.mjs(quant-reconstitution-facts.mjs와 공유).
//
// ⚠️ 350종목 × 최대 4회(공시일 확인 재시도) OpenDart 호출이라 시간이 걸린다(수 분 단위,
// fdr-universe.py의 시가총액·유동성 조회보다 오래 걸림 — 매달 1회만 도는 잡이라 감내).
//
// 사용법:
//   node scripts/tools/quant-factor-facts.mjs                # 전체 350종목
//   node scripts/tools/quant-factor-facts.mjs --limit 20      # 상위 20종목만(빠른 확인용)
//   node scripts/tools/quant-factor-facts.mjs --json
import { loadEnv } from '../lib/auth.mjs';
import { computeMonthlyRanking } from '../lib/quant-ranking.mjs';

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

const won = (n) => Math.round(n).toLocaleString('ko-KR');

async function main() {
  if (!JSON_OUT) console.error('[1/2] 유니버스·유동성·OCF 조회 중(공시일 확인 포함)...');
  const onProgress = !JSON_OUT ? (i, total) => console.error(`  ...${i}/${total}건 처리`) : undefined;
  const onSampleError = !JSON_OUT ? (name, e) => console.error(`  (표본 오류 — ${name}: ${e.message})`) : undefined;
  const { universeCount, liquidCount, targetCount, unresolvedCorp, ocfFetchFailed, ranked } =
    await computeMonthlyRanking({ limit: LIMIT, onProgress, onSampleError });

  if (!JSON_OUT) console.error('[2/2] OCF/P 순위 계산 완료');

  if (JSON_OUT) {
    console.log(JSON.stringify({ universeCount, liquidCount, targetCount, unresolvedCorp, ocfFetchFailed, ranked }, null, 2));
    return;
  }

  console.log(`\n[퀀트 트랙 OCF/P 랭킹] 유니버스 ${universeCount} → 유동성통과 ${liquidCount} → 조회대상 ${targetCount}`);
  console.log(`  법인코드 매칭 실패 ${unresolvedCorp}건 · OCF 공시 미확인/조회실패 ${ocfFetchFailed}건 · 순위 산출 ${ranked.length}건\n`);
  console.log('순위  종목명                    OCF/P     시가총액          공시일');
  for (const c of ranked.slice(0, 20)) {
    const zone = c.rank <= 10 ? '매수' : c.rank <= 20 ? '유지(버퍼)' : '';
    console.log(`${String(c.rank).padStart(3)}  ${c.Name.padEnd(20)}  ${(c.ocfToPrice * 100).toFixed(2)}%  ${won(c.Marcap).padStart(15)}원  ${c.disclosureDate ?? '-'}  ${zone}`);
  }
  console.log('\n※ 이 보고는 순위까지만 — 실제 매수·매도 판단은 Kairos 재량(버퍼존 매수10위/매도20위, 동일가중±50% 사이징).');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
