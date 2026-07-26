#!/usr/bin/env node
/**
 * IRP 계좌 잔고 자동대사 — KIS 잔고조회 API로 실제 IRP 보유수량+예수금을 가져와 시트 IRP
 * 탭과 대조한다. 왜: IRP는 월 25만원 적립식 자동매수(TIGER TDF2045 적격, profile/investor-profile.md
 * §2)가 있는데, 이 자동매수 체결이 카카오 알림 파이프라인(parse-notifications.mjs)에 안
 * 잡히거나 시트에 수동 반영이 누락되면 시트 수량이 조용히 실제 계좌와 어긋난다 — 이런
 * "조용한 어긋남"을 잡는 안전망(2026-07 환전 KRW 미차감 사고와 같은 종류의 실패 패턴).
 * 예수금도 대사 대상 — 적립금이 매수 전 잠깐 현금으로 대기하는 시점의 드리프트까지 잡는다.
 *
 * 스코프: "계좌 잔고·체결 자동대사"는 원래 4계좌(위탁/연금저축/ISA/IRP) 전체를 노렸으나,
 * KIS API로 조회 가능한 건 한투에 있는 계좌뿐이다 — 위탁·ISA는 NH투자증권, 연금저축은
 * 삼성증권이라 KIS로는 조회 불가(계좌 구조 확인: profile/investor-profile.md §2). IRP만
 * 한투라 이 잡도 IRP 전용. 체결내역 대사(주문별 매칭)는 이번 스코프 밖 — 수량 스냅샷 대조만.
 *
 * 안전: 매매 API 미사용, 조회 전용. 계좌번호(CANO/ACNT_PRDT_CD)+전용 앱키는 kis-key.json에
 * 별도 irpAccount 필드로 로컬 설정(설정 안 돼 있으면 정상 skip — API키만 있고 계좌 미등록인
 * 상태를 실패로 취급하지 않음, hasKisCredentials 미설정 스킵과 동일 원칙). IRP는 최상위
 * appkey(시세 조회용)가 아니라 irpAccount 자체의 appkey/appsecret을 쓴다 — KIS가 앱키를
 * 계좌 단위로 등록시켜(2026-07 실측: 최상위 앱키로는 INVALID_CHECK_ACNO 거부, IRP 전용으로
 * 새로 신청한 앱키로 바꾸니 통과), 시세용 앱키로는 이 계좌를 애초에 조회할 수 없다.
 *
 * 사용: node scripts/jobs/reconcile-irp.mjs [token]
 */
import { getToken, readHoldings } from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { hasKisCredentials, loadIrpAccount, getKisToken, getAccountBalance } from '../lib/kis.mjs';

async function main() {
  if (!hasKisCredentials()) {
    console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵(설정 시 ~/.config/banana-portfolio/kis-key.json 생성)');
    return;
  }
  const irpAccount = loadIrpAccount();
  if (!irpAccount) {
    console.log('ℹ️ IRP 계좌정보(irpAccount) 미설정 — 스킵(kis-key.json에 {cano, acntPrdtCd, appkey, appsecret} 추가 시 활성화)');
    return;
  }

  const explicitToken = process.argv[2];
  const token = await getToken(explicitToken?.trim() || null, { allowBrowser: false });

  const { appkey, appsecret, cano, acntPrdtCd } = irpAccount;
  const kisToken = await getKisToken({ appkey, appsecret });
  const { holdings: kisHoldings, cash: kisCash } = await getAccountBalance({ token: kisToken, appkey, appsecret, cano, acntPrdtCd });

  // 예수금(현금성) 행은 종목 수량 대사 대상이 아니다 — readHoldings()가 qty를 빈칸→0으로
  // 채워서 항상 0으로 보이므로, 종목 루프에 그대로 두면 실제 예수금이 얼마든 "일치"로
  // 오판된다. invest(원화 금액)만 따로 뽑아 KIS output2.dnca_tot_amt와 금액으로 비교한다.
  // 이름은 정확히 '예수금'이 아니라 포함 매칭(includes) — 정확히 일치하는 이름으로만 잡으면
  // 시트 라벨이 미세하게 바뀌었을 때(예: "예수금(KRW)") 그 행이 조용히 종목 루프로 새어들어가
  // sheetCash가 기본값 0으로 고정되고, 실제로 예수금이 있어도 대사가 항상 스킵되는 채로
  // "일치"로 잘못 표시된다 — 진짜 드리프트를 놓치는 방향이라 코드리뷰에서 지적됨.
  const holdingsRaw = await readHoldings(token);
  const sheetIrp = new Map();
  let sheetCash = 0; // readHoldings가 qty·invest 둘 다 0인 행은 아예 안 돌려주므로, 못 찾으면 진짜 0원
  let foundCashRow = false;
  for (const h of holdingsRaw) {
    const irp = h.accounts.find(a => a.acct === 'IRP');
    if (!irp) continue;
    if (h.name.includes('예수금')) { sheetCash = irp.invest; foundCashRow = true; continue; }
    sheetIrp.set(h.name, irp.qty);
  }
  // 시트에 IRP 예수금 행 자체가 없는데 KIS는 예수금이 있다고 응답하면(위 foundCashRow=false
  // 케이스), sheetCash 기본값 0과 비교해 정상적으로 불일치가 잡히므로 별도 경고는 불필요 —
  // 다만 "행이 아예 없어서 0으로 간주"와 "행이 있고 실제로 0"을 구분해 디버깅에 남긴다.
  if (!foundCashRow) console.log('IRP 시트에 예수금 행 없음 — 0원으로 간주하고 대사');
  const kisByName = new Map(kisHoldings.map(h => [h.name, h.qty]));
  const allNames = new Set([...sheetIrp.keys(), ...kisByName.keys()]);

  let mismatches = 0;
  for (const name of allNames) {
    const sheetQty = sheetIrp.get(name) ?? 0;
    const kisQty = kisByName.get(name) ?? 0;
    if (sheetQty !== kisQty) {
      mismatches++;
      collectWarning(`IRP 대사 불일치: ${name} — 시트 ${sheetQty}주 vs KIS 실계좌 ${kisQty}주`);
    }
  }

  const cashChecked = kisCash != null;
  if (!cashChecked) {
    console.log('KIS 예수금(output2) 데이터 없음 — 예수금 대사 스킵');
  } else if (sheetCash !== kisCash) {
    mismatches++;
    collectWarning(`IRP 예수금 대사 불일치: 시트 ${sheetCash.toLocaleString('en-US')}원 vs KIS 실계좌 ${kisCash.toLocaleString('en-US')}원`);
  }

  // 예수금 대사가 스킵됐으면 "일치" 요약에서도 그 사실이 드러나야 한다 — 스킵을 "일치"로
  // 뭉뚱그리면 안전망이 실제로 뭘 확인했는지 스스로 부정확하게 보고하게 된다(코드리뷰 지적).
  const cashLabel = cashChecked ? '예수금' : '예수금(스킵)';
  if (mismatches === 0) console.log(`✅ IRP 대사 일치 (종목 ${allNames.size}개 + ${cashLabel})`);
  else console.log(`⚠️ IRP 대사 불일치 ${mismatches}건 (종목 ${allNames.size}개 + ${cashLabel} 대상)`);
  await flushWarnings('reconcile-irp');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('reconcile-irp').catch(() => {});
  process.exit(1);
});
