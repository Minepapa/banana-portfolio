#!/usr/bin/env node
/**
 * IRP 계좌 잔고 자동대사 — KIS 잔고조회 API로 실제 IRP 보유수량을 가져와 시트 IRP 탭과
 * 대조한다. 왜: IRP는 월 25만원 적립식 자동매수(TIGER TDF2045 적격, profile/investor-profile.md
 * §2)가 있는데, 이 자동매수 체결이 카카오 알림 파이프라인(parse-notifications.mjs)에 안
 * 잡히거나 시트에 수동 반영이 누락되면 시트 수량이 조용히 실제 계좌와 어긋난다 — 이런
 * "조용한 어긋남"을 잡는 안전망(2026-07 환전 KRW 미차감 사고와 같은 종류의 실패 패턴).
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
  const kisHoldings = await getAccountBalance({ token: kisToken, appkey, appsecret, cano, acntPrdtCd });

  const holdingsRaw = await readHoldings(token);
  const sheetIrp = new Map();
  for (const h of holdingsRaw) {
    const irp = h.accounts.find(a => a.acct === 'IRP');
    if (irp) sheetIrp.set(h.name, irp.qty);
  }
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

  if (mismatches === 0) console.log(`✅ IRP 대사 일치 (${allNames.size}종목)`);
  else console.log(`⚠️ IRP 대사 불일치 ${mismatches}건 (전체 ${allNames.size}종목)`);
  await flushWarnings('reconcile-irp');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('reconcile-irp').catch(() => {});
  process.exit(1);
});
