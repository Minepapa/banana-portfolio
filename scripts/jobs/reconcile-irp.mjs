#!/usr/bin/env node
/**
 * IRP 계좌 잔고 자동대사 — KIS 잔고조회 API로 실제 IRP 보유수량+예수금을 가져와 시트 IRP
 * 탭과 대조한다. 왜: IRP는 월 25만원 적립식 자동매수(TIGER TDF2045 적격, profile/investor-profile.md
 * §2)가 있는데, 이 자동매수 체결이 카카오 알림 파이프라인(parse-notifications.mjs)에 안
 * 잡히거나 시트에 수동 반영이 누락되면 시트 수량이 조용히 실제 계좌와 어긋난다 — 이런
 * "조용한 어긋남"을 잡는 안전망(2026-07 환전 KRW 미차감 사고와 같은 종류의 실패 패턴).
 * ⚠️ 정정(2026-08-18) — 아래는 2026-07-26 당시 실측 기록인데, 오늘 같은 함수
 * (getAccountBalance, tr_id TTTC8434R)로 IRP·퀀트 계좌를 나란히 재조회하니 IRP도
 * dnca_tot_amt가 320,899원으로 정상 응답했다(오너 앱 스크린샷과 정확히 일치, 퀀트
 * 계좌도 동일 함수로 정상 조회됨 — 둘 다 같은 구조로 작동). 즉 "IRP 계좌 타입은
 * 예수금 필드가 원천적으로 0 고정"이라는 아래 결론은 틀렸다 — 당시엔 계좌 등록이나
 * 앱키 설정이 아직 안 끝난 과도기였을 가능성이 높다(파일 상단 계좌별 앱키 등록 주석
 * 참고). 예수금 대사(비교) 자체는 여전히 이 잡 스코프 밖(수량만 대사)이지만, 실제
 * "값을 가져오는 것" 자체는 가능한 것으로 확인됐다 — State/Holdings/IRP-예수금.md를
 * 이 API로 자동 갱신하는 잡은 아직 별도로 없음(오너 확인 후 배선 예정, update-cash-
 * from-ledger.mjs가 지금은 오너가 앱에서 직접 확인한 값을 수동 CashEvent로 받는
 * 방식만 씀). 아래는 원래(2026-07-26) 기록 그대로 보존:
 *
 * 예수금 대사는 현재 비활성화 — 2026-07-26 실측: 국내주식 잔고조회(TTTC8434R)가 IRP
 * 계좌에서 종목 잔고는 정확히 반환하지만(앱과 일치 확인) output2의 예수금 관련 필드
 * (dnca_tot_amt 등 4개)는 파라미터(INQR_DVSN/PRCS_DVSN)를 바꿔봐도 전부 "0" 고정 —
 * 실제 앱 화면(예수금 320,127원)과 다름. null이 아니라 "0"으로 응답하기 때문에 기존
 * null-스킵 가드로는 못 잡는 조용한 오답 — 그대로 뒀으면 매일 거짓 불일치 경보가 났을
 * 것. 퇴직연금 계좌 전용 별도 API가 있을 가능성이 높으나 공개 문서/예제에서 못 찾음 —
 * getAccountBalance()의 cash 필드는 그대로 두되(값 자체는 정확히 파싱함, 국내 위탁계좌
 * 등에서는 유효할 수 있음) 이 잡에서는 사용하지 않는다. 시트 IRP 예수금은 Frank가 앱
 * 스크린샷으로 직접 확인해 수동 정정(320,127원)했다.
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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, readHoldings } from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { hasKisCredentials, loadIrpAccount, getKisToken, getAccountBalance } from '../lib/kis.mjs';
import { IRP_ACCOUNT_NO } from '../lib/account-resolver.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildCashEventRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

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
  const { holdings: kisHoldings, cash } = await getAccountBalance({ token: kisToken, appkey, appsecret, cano, acntPrdtCd });

  // 예수금앵커 자동화(2026-08-18) — cash가 이제 신뢰 가능함이 실측으로 확인됐다(파일
  // 상단 정정 주석). NH 4계좌의 카카오 알림과 동일한 역할 — CashEvents에 기록만 해두면
  // update-cash-from-ledger.mjs가 그걸 최신 기준점으로 읽어 IRP 실잔고를 계산한다.
  // null(진짜 조회 실패)이면 기록하지 않는다 — 0으로 추정해 기존 앵커를 덮어쓰면 더 위험.
  if (cash != null) {
    // ⚠️ 버그 수정(2026-08-18, 배선 직후 발견) — toISOString()은 UTC라 KST보다 9시간
    // 느리다. 이 Vault의 모든 타임스탬프(카카오 알림 파싱·오너 수동 앵커 등)는 KST
    // 벽시계 기준이라, UTC로 쓰면 computeCashDelta의 사전식 비교가 실제보다 9시간
    // 이른 시각으로 착각해 그 사이(진짜로는 앵커 이전인) 체결·배당이 델타에 잘못
    // 포함될 위험이 있었다(order-gate.mjs checkMarketOpen과 동일 Asia/Seoul 관례로 통일).
    const kstParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => kstParts.find((p) => p.type === type).value;
    const nowTs = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    const { filename, content, dir } = buildCashEventRecord({ account: 'IRP', acctNo: IRP_ACCOUNT_NO, balance: cash, ts: nowTs });
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, filename), content);
    console.log(`  + [예수금앵커] IRP ${nowTs} 잔고 ${cash.toLocaleString()}원`);
  } else {
    console.log('  ⚠️ IRP 예수금 조회 실패(null) — CashEvent 기록 건너뜀(기존 기준점 유지)');
  }

  // 예수금(현금성) 행은 수량 개념이 없어 종목 대사 대상이 아니다 — readHoldings()가 qty를
  // 빈칸→0으로 채워서, 종목 루프에 그대로 두면 0=0으로 조용히 "일치" 취급된다. 이름
  // 포함매칭(includes)으로 걸러서 애초에 대사 대상에서 뺀다. 예수금 자체는 이제 위에서
  // CashEvent로 따로 기록되므로(2026-08-18), 여기 남은 건 "시트 vs KIS 종목 수량"만
  // 비교하는 순수 대사 로직 — 예수금 값끼리의 대사(비교)는 여전히 이 잡 스코프 밖.
  const holdingsRaw = await readHoldings(token);
  const sheetIrp = new Map();
  for (const h of holdingsRaw) {
    const irp = h.accounts.find(a => a.acct === 'IRP');
    if (!irp) continue;
    if (h.name.includes('예수금')) continue;
    sheetIrp.set(h.name, irp.qty);
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

  if (mismatches === 0) console.log(`✅ IRP 종목 대사 일치 (종목 ${allNames.size}개, 예수금 자체는 위에서 별도로 CashEvent 기록됨)`);
  else console.log(`⚠️ IRP 종목 대사 불일치 ${mismatches}건 (종목 ${allNames.size}개, 예수금 자체는 위에서 별도로 CashEvent 기록됨)`);
  await flushWarnings('reconcile-irp');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('reconcile-irp').catch(() => {});
  process.exit(1);
});
