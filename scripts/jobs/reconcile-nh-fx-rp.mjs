#!/usr/bin/env node
/**
 * 위탁 계좌 외화RP 보유수량 — NH PLUG 종합거래내역 API(iem_llf_cd='08')로 조회해
 * State/Holdings/위탁-외화-RP.md의 qty를 직접 기록한다(2026-09-19, 오너 지시 —
 * "예수금이나 금현물 시세와 마찬가지로 외화RP도 주기적으로 확인해서 자동 갱신").
 *
 * 왜: NH PLUG API로 외화RP 거래이력을 조회해 현재 보유수량을 유도할 수 있음을
 * 확인했다([[project-nh-fx-rp-not-queryable]] 결론 뒤집힘, scripts/lib/nhplug-
 * common.mjs 신설). 1차 구현("최신 거래 1건=전체 잔고")은 오너가 NH 앱 스크린샷으로
 * 반증(같은 계좌에 만기 다른 로트가 동시에 여러 개 있을 수 있음), 2차 구현(금액
 * 매칭)도 RP 이자로 매도금액≠매수원금이라 실패 확인 — 3차 FIFO(reconstructForeignRpLots)
 * 로 실계좌 값과 정확히 일치 검증 완료(상세는 그 함수 주석 참고).
 *
 * ⚠️ qty만 patch하고 avgPrice·curPrice는 안 건드린다(의도적) — 이 프로젝트는
 * "수량/잔고 확정"(reconcile-*)과 "시세·환율 밸류에이션"(update-holdings-prices.mjs)
 * 을 서로 다른 잡의 책임으로 분리하는 기존 관례를 따른다(reconcile-nh-cash.mjs가
 * 예수금만 쓰고 시세를 안 건드리는 것과 동일 원칙). 단, invest·evalAmount는 파일의
 * **기존 curPrice**(마지막으로 알려진 환율)로 즉시 재계산해 같이 쓴다(2026-09-19
 * 코드리뷰 MEDIUM 지적 — qty만 바뀌고 invest/evalAmount가 옛 qty 기준으로 남으면,
 * update-holdings-prices.mjs 다음 실행(최대 10분, 환율 조회가 실패하면 무기한)
 * 까지 레코드가 내부 불일치 상태가 되고 그 사이 new-cash-allocation(16:13, 이
 * 잡보다 4분 뒤) 같은 실제 판단 경로가 그 evalAmount를 읽는다). 새 환율을 직접
 * 조회하진 않는다 — 그건 여전히 update-holdings-prices.mjs 몫(관심사 분리 유지,
 * 이 잡이 환율 API 토큰까지 필요로 하지 않게).
 *
 * ⚠️ 안전장치(2026-09-19 코드리뷰 CRITICAL/HIGH 반영 — 아래 decideFxRpWrite 참고):
 * ① 페이지네이션 데이터가 잘렸으면(truncated) 쓰지 않음. ② 조회기간 내 RP 거래
 * 자체가 없으면 쓰지 않음. ③ **거래는 있는데 열린 로트가 0개면 쓰지 않고 경고**
 * (1차 구현 당시 있었다가 리팩터링 중 실수로 빠졌던 가드 — 데이터는 있는데 로트
 * 파싱만 실패하는 경우(cur_cd 결측·적요 표기 변경 등)와 "진짜 전량상환"을 구분
 * 못 해서, 전자일 때 qty=0을 조용히 써버리면 실보유 830만원어치가 사라진 것처럼
 * 기록되고 그 evalAmount가 rebalance-gap.mjs의 자산군 갭 계산에 들어가 잘못된
 * 매수 제안까지 만들 수 있었다). ④ 로트들의 통화가 혼재하면(향후 원화 외 다른
 * 외화가 섞이는 경우 대비) 쓰지 않음. ⑤ 기존값 대비 변동폭이 50% 넘으면 쓰지
 * 않고 경고(FIFO 매칭 실패가 과대계상 쪽으로도 실패한 전례 있음 — 2차 구현이
 * 총액을 5배로 부풀렸던 사고, nhplug-common.mjs reconstructForeignRpLots 주석
 * 참고). ⑥ 기존 State/Holdings 파일이 없으면 신규 생성은 이 잡의 범위 밖. ⑦ 실제로
 * qty를 바꾼 경우(위 조건 다 통과) 반드시 collectWarning으로 기존→신규 값을
 * 오너에게 통지(2026-09-19 코드리뷰 HIGH 지적 — 예전 읽기전용 버전은 불일치를
 * 무조건 텔레그램으로 알렸는데, 쓰기 버전으로 바뀌며 통지 채널이 통째로 사라져
 * 있었다. 실보유 수량이 바뀌었다는 사실 자체는 로그 파일이 아니라 오너가 보는
 * 채널에 남아야 한다).
 *
 * 사용법: node scripts/jobs/reconcile-nh-fx-rp.mjs [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getTotalTransaction, reconstructForeignRpLots } from '../lib/nhplug-common.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { holdingFilename } from '../lib/holdings-vault-writer.mjs';
import { patchFrontmatterFileSafely } from '../lib/state-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const LARGE_CHANGE_RATIO = 0.5; // 기존값 대비 이 비율 넘게 변하면 자동 쓰기 대신 오너 확인 요청

// NH 응답 숫자 필드는 콤마 포함 문자열일 수 있다(reconcile-nh-executions.mjs num()과
// 동일 패턴 — 맨 Number()는 "5,353.15"를 NaN으로 만든다. feedback-sheets-numeric-
// parsing 메모리와 동일 함정).
//
// ⚠️ null/undefined/빈 문자열을 먼저 걸러야 한다(2026-09-19 자체 테스트로 발견한
// 버그) — String(null ?? '')가 ''이 되고 Number('')는 NaN이 아니라 0이라, 이 가드
// 없이는 num(null)이 0을 반환해 "값이 없음"과 "값이 0"을 구분 못 하게 된다.
export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// KST 기준 YYYYMMDD — reconcile-nh-dividends.mjs·reconcile-nh-cash.mjs kstNow()와
// 동일 관례(UTC 기준이면 KST 새벽엔 하루 어긋남).
export function ymdKst(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

// 쓸지 말지 순수 판정(2026-09-19 코드리뷰 MEDIUM 지적 — 이 판정 로직에 있던 CRITICAL
// 버그(로트 0개 가드 소실)가 테스트 없이 리팩터링 중 조용히 들어왔다. main()에서
// 분리해 테스트 가능하게 함).
//
// rows: getTotalTransaction 원시 결과(빈 배열이면 "RP 거래 자체 없음").
// truncated: 페이지네이션 불완전 여부.
// lots/total/currency: reconstructForeignRpLots 결과.
// currentQty: State/Holdings 기존 qty(숫자, 파싱 실패 시 null).
//
// 반환: { write: boolean, reason: string, derivedQty: number|null }
export function decideFxRpWrite({ rows, truncated, lots, total, currency, currentQty }) {
  if (truncated) return { write: false, reason: 'truncated', derivedQty: null };
  if (!rows || rows.length === 0) return { write: false, reason: 'no-rp-transactions', derivedQty: null };
  // ⚠️ CRITICAL(2026-09-19 코드리뷰) — rows.length>0인데 lots.length===0인 경로가
  // 실재한다(cur_cd 결측·적요 표기 변경·매도만 창 안에 잡힌 경계 케이스 등). 데이터
  // 이상과 "진짜 전량상환"을 구분할 방법이 없어 항상 쓰지 않고 경고한다 — 연 몇 회
  // 수준일 진짜 전량상환은 오너가 경고를 보고 수동으로 0을 넣으면 된다.
  if (!lots || lots.length === 0) return { write: false, reason: 'no-open-lots', derivedQty: null };
  if (!lots.every((l) => l.currency === currency)) return { write: false, reason: 'mixed-currency', derivedQty: null };
  const derivedQty = total;
  if (!Number.isFinite(derivedQty)) return { write: false, reason: 'invalid-derived-qty', derivedQty: null };
  if (currentQty != null && currentQty !== 0) {
    const changeRatio = Math.abs(derivedQty - currentQty) / Math.abs(currentQty);
    if (changeRatio > LARGE_CHANGE_RATIO) return { write: false, reason: 'large-change', derivedQty };
  }
  if (currentQty != null && Math.abs(derivedQty - currentQty) < 0.01) return { write: false, reason: 'unchanged', derivedQty };
  return { write: true, reason: 'ok', derivedQty };
}

async function main() {
  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const byLabel = resolveNhAccountsByLabel(accounts, new Set(['위탁']));
  const actNo = byLabel.get('위탁');
  if (!actNo) {
    collectWarning('NH 외화RP갱신: 위탁 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요)');
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }

  // 400일 — "자유약정형" RP는 관측상 만기(약 28일)마다 자동 롤오버(매도+동액 매수)
  // 하므로, 창이 한 만기주기보다 충분히 길면 현재 열린 로트가 전부 창 안에서 최소
  // 한 번은 열림을 보인다(reconstructForeignRpLots 주석 참고). 페이지네이션은
  // nhplug-common.mjs가 처리.
  const end = new Date();
  const start = new Date(end.getTime() - 400 * 86400000);
  const { rows, truncated } = await getTotalTransaction({
    token, actNo, iqrStaDt: ymdKst(start), iqrEndDt: ymdKst(end), iemLlfCd: '08', actTrdDtlCd: '00',
  });

  const { lots, total, currency } = reconstructForeignRpLots(rows);
  console.log(`NH API 유도값: 로트 ${lots.length}개, 합계 ${total} ${currency ?? '(로트 없음)'}`);
  for (const l of lots) console.log(`  - ${l.amount} ${l.currency}(${l.productName ?? '-'}) 개설일 ${l.openedDate}`);

  const dir = VAULT_PATHS.state.holdings;
  const filepath = join(dir, holdingFilename('위탁', '외화 RP'));
  if (!existsSync(filepath)) {
    console.log('ℹ️ State/Holdings에 기존 위탁-외화 RP 기록 없음 — 신규 생성은 이 잡의 범위 밖(수동으로 먼저 만들 것)');
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }
  const current = parseFrontmatter(readFileSync(filepath, 'utf8'));
  const currentQty = num(current.qty);
  if (currentQty === null && current.qty != null) {
    collectWarning(`NH 외화RP갱신: 기존 qty 파싱 실패(값="${current.qty}") — 파일 손상 가능성, 수동 확인 필요`);
  }

  const decision = decideFxRpWrite({ rows, truncated, lots, total, currency, currentQty });
  console.log(`현재 기록: ${current.qty ?? '(없음)'} → 유도값 ${decision.derivedQty ?? '(계산 불가)'} — 판정: ${decision.reason}`);

  if (!decision.write) {
    const reasonMsg = {
      truncated: '페이지 한도 도달 — 일부 과거 거래 누락 가능해 쓰지 않음(기간을 줄여 재조회 권장)',
      'no-rp-transactions': '조회기간(400일) 내 외화RP 거래 자체가 없음 — "한 번도 안 삼"과 "소스 이상"을 구분 못 해 쓰지 않음',
      'no-open-lots': `거래이력은 있는데 열린 로트가 0개로 계산됨 — 데이터 이상(적요·통화필드 변경 등)과 진짜 전량상환을 구분 못 해 쓰지 않음. 현재 기록(${current.qty})이 여전히 맞는지 NH 앱에서 직접 확인 필요`,
      'mixed-currency': '로트 통화가 혼재돼 있어 합계가 무의미할 수 있음 — 쓰지 않음, 수동 확인 필요',
      'invalid-derived-qty': '유도값 계산 실패 — 쓰지 않음',
      'large-change': `유도값이 기존 기록과 ${(LARGE_CHANGE_RATIO * 100).toFixed(0)}% 넘게 차이남(현재 ${currentQty} → 유도 ${decision.derivedQty}) — 자동 쓰기 대신 확인 요청`,
    }[decision.reason];
    if (reasonMsg && decision.reason !== 'unchanged') {
      console.log(`⚠️ ${reasonMsg}`);
      collectWarning(`NH 외화RP갱신: ${reasonMsg}`);
    } else if (decision.reason === 'unchanged') {
      console.log(`✅ 변경 없음`);
    }
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }

  const derivedQty = decision.derivedQty;
  console.log(`qty 갱신: ${current.qty ?? '(없음)'} → ${derivedQty}`);
  if (!DRY_RUN) {
    // invest·evalAmount는 파일의 기존 curPrice(마지막으로 알려진 환율)로 즉시
    // 재계산해 같이 쓴다 — update-holdings-prices.mjs의 recomputeFxCashValuation과
    // 동일 공식(invest=evalAmount=rate×qty, profitAmount·profitPct=0, 외화 현금성
    // 보유는 항상 원가를 현재 환율로 재기준). avgPrice·curPrice(환율 자체)는 이
    // 잡이 새로 조회하지 않으므로 안 건드림 — 다음 update-holdings-prices.mjs
    // 실행이 진짜 최신 환율로 다시 갱신한다(위 헤더 주석).
    const patch = { qty: derivedQty, updatedAt: new Date().toISOString() };
    const knownRate = num(current.curPrice);
    if (knownRate != null) {
      patch.invest = knownRate * derivedQty;
      patch.evalAmount = patch.invest;
      patch.profitAmount = 0;
      patch.profitPct = 0;
    }
    const ok = await patchFrontmatterFileSafely(filepath, patch);
    if (!ok) {
      collectWarning('NH 외화RP갱신: 쓰기 직전 파일이 사라짐(경합) — 이번 실행 스킵');
      await flushWarnings('reconcile-nh-fx-rp');
      return;
    }
    // 실제로 값이 바뀌는 모든 쓰기는 오너에게 통지(2026-09-19 코드리뷰 HIGH 지적 —
    // 읽기전용 시절엔 불일치를 항상 텔레그램으로 알렸는데, 쓰기로 전환되며 그 통지
    // 채널이 사라져 "실보유 수량이 바뀌었다"는 사실이 로그 파일에만 남을 뻔했다).
    collectWarning(`NH 외화RP갱신: qty ${current.qty ?? '(없음)'} → ${derivedQty} 자동 갱신 완료(로트 ${lots.length}개)`);
    console.log('✅ qty 갱신 완료');
  } else {
    console.log('ℹ️ 드라이런 — 실제로는 위 값으로 qty를 갱신했을 것(쓰기 없음)');
  }
  await flushWarnings('reconcile-nh-fx-rp');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-nh-fx-rp').catch(() => {});
    process.exit(1);
  });
}
