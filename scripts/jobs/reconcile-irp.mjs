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
 * ⚠️ 재정정(2026-08-18, 같은 날 몇 시간 뒤) — 위 "정정"이 성급했다. 재활성화 직후
 * 같은 계좌를 다시 호출했더니 dnca_tot_amt가 "0"으로 돌아왔다(직전 두 번은 320,899로
 * 정상, 실제 앱과 일치 확인됨 — 그 사이 실제로 돈이 빠질 이유 없음). 즉 2026-07-26
 * 원본 기록이 말한 "이 필드가 가끔 0으로 온다"는 여전히 유효한 현상이었다 — 단지
 * "항상 0"이 아니라 "간헐적으로 0"이라는 게 이번에 새로 드러난 정확한 실태. 잘못된
 * 0을 그대로 기록했으면 다음 예수금 계산이 기준점을 0으로 잘못 잡을 뻔했다(발견
 * 즉시 정리). 아래 cash>0 가드가 그 재발 방지책 — "0으로 추정하지 않는다"는 이
 * 코드베이스 원칙(parseBalanceResponse의 null 처리와 동일 정신)을 "필드가 없을
 * 때"뿐 아니라 "이 계좌에서 이 필드가 간헐적으로 신뢰 불가함이 이미 실측된 경우"
 * 까지 확장 적용한다.
 *
 * ⚠️ 설계 재정정(2026-09-03, 마이그레이션 3단계) — 처음(2026-08-18)엔 이 조회값을
 * CashEvent로 기록해 update-cash-from-ledger.mjs의 기준점+델타 재구성 루프에
 * 태웠다. Strategy 문서(`Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-
 * 역할축소-결정.md`) 재검토 결과 오너 확정 원문이 "예수금 앵커는 통일 루프 깸"
 * 이었음이 명확해져(code-reviewer 지적, 2026-09-03 오너 재확인) — API로 직접
 * 조회 가능한 계좌는 재구성 루프를 아예 안 타야 한다. 이제 State/Holdings/
 * IRP-예수금.md를 이 조회값으로 직접 덮어쓴다(CashEvent·update-cash-from-
 * ledger.mjs 완전 배제) — `reconcile-nh-cash.mjs`(위탁·CMA·금현물)와 같은
 * 원칙. cash>0 가드는 그대로 유지 — 신뢰 불가한 값이면 기존 State/Holdings
 * 파일을 그대로 둔다(덮어쓰지 않음, 이전엔 "기존 앵커 유지"였던 것과 동일한
 * 효과를 직접 파일 스킵으로 달성).
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
 * ⚠️ 대사 기준(2026-08-22 변경) — 종목 수량 대사(아래 buildIrpMismatches)는 원래 v1
 * 구글시트(계좌별 탭)를 "장부"로 삼아 KIS 실계좌와 비교했는데, 그 시트는 v2 전환 이후
 * 더 이상 갱신되지 않아 조용히 낡아가고 있었다. Phase 8·9로 State/Holdings가 IRP
 * 실보유를 이미 반영하고 있어(update-holdings-from-executions.mjs가 계좌번호
 * 43****82-29 매칭으로 유지) 이제 그쪽을 기준으로 쓴다 — 구글시트 의존 제거.
 *
 * 사용:
 *   node scripts/jobs/reconcile-irp.mjs            # 실제로 반영
 *   node scripts/jobs/reconcile-irp.mjs --dry-run  # 조회만, 쓰기 없음(2026-09-03
 *     신설 — intraday-portfolio-sync.mjs가 이 잡을 안전하게 테스트할 수 있도록)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { hasKisCredentials, loadIrpAccount, getKisToken, getAccountBalance } from '../lib/kis.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { buildCashHoldingRecord } from '../lib/holdings-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// IRP 보유(State/Holdings) — 순수 함수. 2026-08-22 이전엔 v1 구글시트(계좌별 탭)를
// 장부 기준으로 썼는데, Phase 8·9 완료로 State/Holdings가 이미 IRP 실보유를 반영하고
// 있어 더 이상 시트를 거칠 이유가 없다(v1 시트는 더 갱신되지 않아 조용히 낡아가는 중이었음).
// isCashLike(예수금)은 종목 대사 대상이 아니라 제외(holdings-vault-writer.mjs 관례).
export function readIrpHoldings(holdingsDir = VAULT_PATHS.state.holdings) {
  if (!existsSync(holdingsDir)) return [];
  return readdirSync(holdingsDir).filter((f) => f.endsWith('.md'))
    .map((f) => parseFrontmatter(readFileSync(join(holdingsDir, f), 'utf8')))
    .filter((h) => h.account === 'IRP' && !h.isCashLike);
}

// vaultHoldings: readIrpHoldings() 반환값. kisHoldings: getAccountBalance().holdings({name,qty}[]).
// 순수 — 양쪽 다 이름 기준으로 합쳐 수량이 다른 종목만 반환한다.
export function buildIrpMismatches(vaultHoldings, kisHoldings) {
  const vaultByName = new Map((vaultHoldings || []).map((h) => [h.name, h.qty ?? 0]));
  const kisByName = new Map((kisHoldings || []).map((h) => [h.name, h.qty]));
  const allNames = new Set([...vaultByName.keys(), ...kisByName.keys()]);
  const mismatches = [];
  for (const name of allNames) {
    const vaultQty = vaultByName.get(name) ?? 0;
    const kisQty = kisByName.get(name) ?? 0;
    if (vaultQty !== kisQty) mismatches.push({ name, vaultQty, kisQty });
  }
  return { mismatches, totalNames: allNames.size };
}

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

  const { appkey, appsecret, cano, acntPrdtCd } = irpAccount;
  const kisToken = await getKisToken({ appkey, appsecret });
  const { holdings: kisHoldings, cash } = await getAccountBalance({ token: kisToken, appkey, appsecret, cano, acntPrdtCd });

  // 예수금 자동화(2026-08-18 신설, 2026-09-03 설계 재정정 — 파일 상단 주석 참고) —
  // cash가 신뢰 가능함이 실측으로 확인됐다. State/Holdings/IRP-예수금.md를 이 값으로
  // 직접 덮어쓴다(CashEvent·update-cash-from-ledger.mjs 완전 배제, "통일 루프 깸").
  // null(진짜 조회 실패)이면 기록하지 않는다 — 0으로 추정해 기존 값을 덮어쓰면 더 위험.
  // ⚠️ cash===0도 같은 이유로 기록하지 않는다(2026-08-18 재정정, 파일 상단 주석) —
  // 이 필드가 이 계좌에서 간헐적으로 0을 반환함이 실측됐다(직전 두 번은 320,899로
  // 정상, 세 번째 호출만 0 — 그 사이 실제로 돈이 빠질 이유 없음). 알려진 한계: IRP
  // 예수금이 진짜 정확히 0원이 되는 상황(전액 매수 직후 등)은 이 가드 때문에 자동
  // 갱신을 못 받는다 — 그 경우 오너의 수동 스냅샷(update-cash-from-ledger.mjs가
  // 이미 지원하는 수동 CashEvent 경로)으로 갱신해야 한다.
  if (cash != null && cash > 0) {
    // ⚠️ 버그 수정(2026-08-18, 배선 직후 발견) — toISOString()은 UTC라 KST보다 9시간
    // 느리다. 이 Vault의 모든 타임스탬프(카카오 알림 파싱·오너 수동 앵커 등)는 KST
    // 벽시계 기준이라, UTC로 쓰면 anchorTs가 실제보다 9시간 이른 시각으로 착각돼
    // 감사 기록(언제 이 값을 조회했는지)이 어긋난다(order-gate.mjs checkMarketOpen과
    // 동일 Asia/Seoul 관례로 통일). 2026-09-03 이전엔 이 값이 computeCashDelta의
    // 델타 재구성 기준점으로도 쓰였으나(사전식 비교라 9시간 어긋나면 실제 델타
    // 계산까지 틀렸을 것), 이제는 State/Holdings에 직접 쓰는 감사용 anchorTs일
    // 뿐이라도 KST 통일은 여전히 지킨다.
    const kstParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => kstParts.find((p) => p.type === type).value;
    const nowTs = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    const { filename, content, dir } = buildCashHoldingRecord({
      account: 'IRP', balance: cash, raw: cash, negative: cash < 0,
      anchorBase: cash, anchorTs: nowTs, anchorSource: 'KIS API 직접조회',
    });
    console.log(`  + [예수금${DRY_RUN ? '(예정)' : ''}] IRP ${nowTs} 잔고 ${cash.toLocaleString()}원`);
    if (!DRY_RUN) {
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, filename), content);
    }
  } else if (cash === 0) {
    console.log('  ⚠️ IRP 예수금이 0으로 응답(이 계좌에서 간헐적으로 발생하는 걸로 실측됨) — 신뢰 불가로 기록 건너뜀(기존 State/Holdings 값 유지)');
  } else {
    console.log('  ⚠️ IRP 예수금 조회 실패(null) — 기록 건너뜀(기존 State/Holdings 값 유지)');
  }

  // 예수금(현금성) 행은 수량 개념이 없어 종목 대사 대상이 아니다 — readIrpHoldings()가
  // isCashLike로 이미 걸러준다(holdings-vault-writer.mjs 관례). 예수금 자체는 이제 위에서
  // State/Holdings에 직접 기록되므로(2026-08-18 신설, 2026-09-03 CashEvent 경로 폐지),
  // 여기 남은 건 "Vault State/Holdings vs KIS
  // 종목 수량"만 비교하는 순수 대사 로직(2026-08-22, v1 시트 기준을 대체) — 예수금
  // 값끼리의 대사(비교)는 여전히 이 잡 스코프 밖.
  const { mismatches, totalNames } = buildIrpMismatches(readIrpHoldings(), kisHoldings);
  for (const m of mismatches) {
    collectWarning(`IRP 대사 불일치: ${m.name} — Vault ${m.vaultQty}주 vs KIS 실계좌 ${m.kisQty}주`);
  }

  if (mismatches.length === 0) console.log(`✅ IRP 종목 대사 일치 (종목 ${totalNames}개, 예수금 자체는 위에서 별도로 State/Holdings에 직접 기록됨)`);
  else console.log(`⚠️ IRP 종목 대사 불일치 ${mismatches.length}건 (종목 ${totalNames}개, 예수금 자체는 위에서 별도로 State/Holdings에 직접 기록됨)`);
  await flushWarnings('reconcile-irp');
}

// 2026-08-22 — entrypoint 가드 추가(다른 잡들과 동일 관례, update-cash-from-ledger.mjs
// 등). 이게 없으면 테스트가 이 파일을 import(readIrpHoldings·buildIrpMismatches 사용)만
// 해도 main()이 실행돼 KIS 네트워크 호출·process.exit이 side effect로 발생한다 —
// 순수 함수를 분리해도 이 가드가 없으면 테스트 자체가 불가능했다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-irp').catch(() => {});
    process.exit(1);
  });
}
