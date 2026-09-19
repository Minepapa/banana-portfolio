#!/usr/bin/env node
/**
 * 위탁 계좌 외화RP 보유수량 — NH PLUG 종합거래내역 API(iem_llf_cd='08')로 조회해
 * State/Holdings/위탁-외화-RP.md(오너 수동 갱신)와 대조. 읽기 전용(Vault 쓰기
 * 없음, 단 불일치 발견 시 job-alerts.mjs를 통해 텔레그램 경고는 발송됨).
 *
 * 왜: 2026-09-19 오너 요청으로 라이브 검증한 결과, NH PLUG API로 외화RP 거래이력을
 * 조회해 현재 보유수량을 유도할 수 있음을 확인했다([[project-nh-fx-rp-not-
 * queryable]] 결론 뒤집힘, scripts/lib/nhplug-common.mjs 신설).
 *
 * ⚠️ 1차 구현(latestForeignRpBalance, "최신 거래 1건 = 전체 잔고")은 오너가 NH 앱
 * 스크린샷으로 직접 반증 — 같은 계좌에 만기일이 다른 RP 로트가 동시에 여러 개
 * 있을 수 있다(실측: 652.47 USD 만기 2026-09-23 + 5,353.15 USD 만기 2026-10-02
 * = 6,005.62, 오너의 수동 기록과 정확히 일치). `reconstructForeignRpLots`(현재
 * 열린 로트 전부를 매수/매도 금액매칭으로 재구성)로 교체 — 상세 원리는 그 함수
 * 주석 참고.
 *
 * 자동 덮어쓰기는 여전히 안 한다 — 로트 재구성 로직이 이번에 실측 1건으로만
 * 검증됐고(오너가 우연히 스크린샷을 보내줘서 발견), FX 밸류에이션(avgPrice·
 * invest·evalAmount, 환율 필요)을 이 잡이 아직 계산 안 해서 qty만 patch하면
 * 레코드가 내부 불일치 상태가 된다. 오너가 값을 재확인한 뒤 수동으로 State/
 * Holdings 파일을 고치거나, 밸류에이션까지 포함한 정식 쓰기 기능을 요청하면
 * 그때 배선한다.
 *
 * 사용법: node scripts/jobs/reconcile-nh-fx-rp.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getTotalTransaction, reconstructForeignRpLots } from '../lib/nhplug-common.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { holdingFilename } from '../lib/holdings-vault-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

// KST 기준 YYYYMMDD — reconcile-nh-dividends.mjs·reconcile-nh-cash.mjs kstNow()와
// 동일 관례(UTC 기준이면 KST 새벽엔 하루 어긋남).
function ymdKst(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

// NH 응답 숫자 필드는 콤마 포함 문자열일 수 있다(reconcile-nh-executions.mjs num()과
// 동일 패턴 — 맨 Number()는 "5,353.15"를 NaN으로 만든다. feedback-sheets-numeric-
// parsing 메모리와 동일 함정).
function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
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
    collectWarning('NH 외화RP대조: 위탁 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요)');
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
  if (truncated) {
    collectWarning('NH 외화RP대조: 페이지 한도 도달 — 일부 과거 거래 누락 가능(기간을 줄여 재조회 권장)');
  }

  const { lots, total, currency } = reconstructForeignRpLots(rows);
  if (lots.length === 0) {
    console.log('ℹ️ 조회 기간 내 열린 외화RP 로트 없음 — 현재 보유수량을 유도할 근거 없음');
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }

  console.log(`NH API 유도값: 로트 ${lots.length}개, 합계 ${total} ${currency}`);
  for (const l of lots) console.log(`  - ${l.amount} ${l.currency}(${l.productName ?? '-'}) 개설일 ${l.openedDate}`);

  const dir = VAULT_PATHS.state.holdings;
  const filepath = join(dir, holdingFilename('위탁', '외화 RP'));
  if (!existsSync(filepath)) {
    console.log('ℹ️ State/Holdings에 기존 위탁-외화 RP 기록 없음 — 대조 불가(신규 생성은 이 잡의 범위 밖, 위 헤더 주석 참고)');
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }
  const current = parseFrontmatter(readFileSync(filepath, 'utf8'));
  console.log(`현재 State/Holdings 기록: ${current.qty} (${current.updatedAt} 갱신)`);

  const derivedQty = num(total);
  const currentQty = num(current.qty);
  if (derivedQty === null || currentQty === null) {
    collectWarning(`NH 외화RP대조: 숫자 파싱 실패(derived=${total}, current=${current.qty}) — 대조 불가`);
    await flushWarnings('reconcile-nh-fx-rp');
    return;
  }

  const diff = derivedQty - currentQty;
  if (Math.abs(diff) < 0.01) {
    console.log('✅ 일치(오차 0.01 미만)');
  } else if (diff > 0) {
    const msg = `NH 외화RP대조: API 유도값이 ${diff.toFixed(2)} 더 큼(API ${derivedQty} vs 기록 ${currentQty}) — API가 더 최근 매수를 반영했을 가능성, 현재 기록이 뒤처졌을 수 있음`;
    console.log(`ℹ️ ${msg}`);
    collectWarning(msg);
  } else {
    const msg = `NH 외화RP대조: API 유도값이 ${Math.abs(diff).toFixed(2)} 더 작음(API ${derivedQty} vs 기록 ${currentQty}) — 로트 재구성 창(400일) 밖에서 개설된 로트가 아직 안 잡혔을 수 있음. 이 값으로 자동 덮어쓰지 않음. NH 앱에서 실제 잔고 직접 확인 필요`;
    console.log(`⚠️ ${msg}`);
    collectWarning(msg);
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
