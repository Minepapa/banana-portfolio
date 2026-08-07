#!/usr/bin/env node
// quant-reconstitution-facts.mjs — 퀀트 트랙(Kairos) 월간 리컨스티튜션 판정 대화형 보고.
// quant-factor-facts.mjs(랭킹까지만)에 실제 KIS 잔고를 더해 매수·매도·유지·확인필요로
// 분류한다. "현재 보유종목" 추적은 Vault State/Holdings가 아니라 리컨스티튜션 시점마다
// KIS 잔고조회 API를 직접 호출(오너 확정, 2026-08-07 — 실시간 진실, 미러 지연 리스크 없음).
// 이 스크립트도 순위·분류·포지션사이징 밴드까지만 낸다 — 실제 수량·타이밍은 Kairos 재량.
//
// 사용법:
//   node scripts/tools/quant-reconstitution-facts.mjs                # 전체 350종목
//   node scripts/tools/quant-reconstitution-facts.mjs --limit 20      # 빠른 확인용
//   node scripts/tools/quant-reconstitution-facts.mjs --json
import { loadEnv } from '../lib/auth.mjs';
import { computeMonthlyRanking } from '../lib/quant-ranking.mjs';
import { hasKisCredentials, loadQuantAccount, getKisToken, getAccountBalance } from '../lib/kis.mjs';
import { computeReconstitution, positionBand, BUY_RANK, SELL_RANK } from '../lib/quant-reconstitution.mjs';

loadEnv(); // quant-factor-facts.mjs와 동일 이유(DART_API_KEY) — 이 스크립트도 직접 호출해야 함

const JSON_OUT = process.argv.includes('--json');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : null;
if (limitIdx >= 0 && !(Number.isInteger(LIMIT) && LIMIT > 0)) {
  console.error('❌ --limit 은 양의 정수여야 합니다.');
  process.exit(1);
}

const won = (n) => Math.round(n).toLocaleString('ko-KR');
const pct = (n) => `${(n * 100).toFixed(2)}%`;

async function main() {
  // 퀀트 계좌 미설정은 오류가 아니라 "아직 준비 안 됨" — IRP 대사(reconcile-irp.mjs)와
  // 동일 관례로 조용히 skip한다.
  if (!hasKisCredentials()) {
    console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵(설정 시 ~/.config/banana-portfolio/kis-key.json 생성)');
    return;
  }
  const quantAccount = loadQuantAccount();
  if (!quantAccount) {
    console.log('ℹ️ 퀀트 계좌정보(quantAccount) 미설정 — 스킵(kis-key.json에 {cano, acntPrdtCd, appkey, appsecret} 추가 시 활성화)');
    return;
  }

  // --limit은 quant-factor-facts.mjs에선 "상위 N개만 미리보기"라 무해하지만, 이 잡은 실계좌
  // 보유종목과 랭킹을 대조하므로 유니버스가 잘리면 실제로는 랭킹에 있었을 보유종목이
  // needsReview로 잘못 표시될 수 있다(코드리뷰 지적, 2026-08-07) — 눈에 띄게 경고.
  if (!JSON_OUT && LIMIT) {
    console.error('⚠️ --limit 설정: 유니버스가 축소돼 매수/매도/유지/확인필요 분류가 부정확할 수 있음(랭킹 미리보기 전용). 실제 판정은 --limit 없이 전체 실행할 것.');
  }
  if (!JSON_OUT) console.error('[1/2] 유니버스·유동성·OCF 조회 및 순위 산출 중...');
  const onProgress = !JSON_OUT ? (i, total) => console.error(`  ...${i}/${total}건 처리`) : undefined;
  const onSampleError = !JSON_OUT ? (name, e) => console.error(`  (표본 오류 — ${name}: ${e.message})`) : undefined;
  const { universeCount, liquidCount, targetCount, unresolvedCorp, ocfFetchFailed, ranked } =
    await computeMonthlyRanking({ limit: LIMIT, onProgress, onSampleError });

  if (!JSON_OUT) console.error('[2/2] KIS 실계좌 잔고 조회 중...');
  const { appkey, appsecret, cano, acntPrdtCd } = quantAccount;
  const kisToken = await getKisToken({ appkey, appsecret });
  const { holdings } = await getAccountBalance({ token: kisToken, appkey, appsecret, cano, acntPrdtCd });

  const { buys, sells, holds, needsReview } = computeReconstitution(ranked, holdings);
  const band = positionBand();

  if (JSON_OUT) {
    console.log(JSON.stringify({
      universeCount, liquidCount, targetCount, unresolvedCorp, ocfFetchFailed,
      holdingsCount: holdings.length, band, buys, sells, holds, needsReview,
    }, null, 2));
    return;
  }

  console.log(`\n[퀀트 트랙 리컨스티튜션] 유니버스 ${universeCount} → 유동성통과 ${liquidCount} → 순위산출 ${ranked.length}건 · 실계좌 보유 ${holdings.length}종목`);
  console.log(`  법인코드 매칭 실패 ${unresolvedCorp}건 · OCF 공시 미확인/조회실패 ${ocfFetchFailed}건`);
  console.log(`포지션 사이징 밴드: 종목당 ${won(band.min)}~${won(band.max)}원(기준 ${won(band.target)}원, 정확한 금액은 Kairos 재량)\n`);

  console.log(`매수(신규 진입, 상위${BUY_RANK}위 이내) ${buys.length}건`);
  for (const b of buys) console.log(`  ${b.name}(${b.code}) — ${b.rank}위, OCF/P ${pct(b.ocfToPrice)}`);

  console.log(`\n매도(청산, ${SELL_RANK}위 밖으로 밀림) ${sells.length}건`);
  for (const s of sells) console.log(`  ${s.name}(${s.code}) — 보유 ${s.qty}주, ${s.rank}위`);

  console.log(`\n유지(버퍼존, ${SELL_RANK}위 이내) ${holds.length}건`);
  for (const h of holds) console.log(`  ${h.name}(${h.code}) — 보유 ${h.qty}주, ${h.rank}위`);

  if (needsReview.length) {
    console.log(`\n⚠️ 확인필요(보유 중이나 이번 랭킹 결과에 없음) ${needsReview.length}건`);
    for (const n of needsReview) console.log(`  ${n.name}(${n.code}) — 보유 ${n.qty}주 — ${n.reason}`);
  }

  console.log('\n※ 이 보고는 분류·포지션사이징 밴드까지만 — 실제 수량·타이밍 판단은 Kairos 재량.');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
