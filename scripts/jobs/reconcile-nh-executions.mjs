#!/usr/bin/env node
/**
 * 위탁·금현물 체결 — NH PLUG API(당일 체결조회)로 직접 폴링 → Facts/Ledger/Executions 기록.
 *
 * 왜: `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`
 * 마이그레이션 4단계. 지금까지 위탁·금현물 체결은 카카오 알림(NH투자증권 브로커
 * 패턴, notification-parsers.mjs parseExecution)에만 의존했다 — `reconcile-irp-
 * executions.mjs`(IRP, KIS 전용 API)·`watch-order-fill.mjs`(퀀트, KIS)와 동일
 * 철학으로, 카카오 알림 파싱 없이 API로 직접 원장을 채운다. CMA는 스코프 밖
 * (Strategy 문서: "CMA는 체결 자체가 없는 계좌라 제외").
 *
 * 카카오 알림 파싱(NH투자증권 패턴)은 그대로 둔다(제거는 5단계, "안정화 후" —
 * Strategy 문서 참고) — 두 경로가 같은 체결을 각자 별도 파일로 기록할 수 있다
 * (`buildExecutionRecord`의 dedupKey·파일명이 `tradeDate|tradeType|stockName|
 * quantity`(+이 잡만 쓰는 orderNo)로 결정되는데, 두 소스의 tradeDate 계산 방식이
 * 달라 — 카카오는 실제 체결시각, 이 잡은 시각 정보가 없어 00:00:00 — 같은 체결이
 * 서로 다른 파일명으로 남는다).
 *
 * ⚠️ **정정(2026-09-03, code-reviewer 지적으로 발견)** — "파일이 2개라도 이중계상은
 * 아니다"라고 처음 적었던 건 틀렸다. `update-holdings-from-executions.mjs`가 미처리
 * 체결마다 State/Holdings에 applyBuy/applySell을 적용하는데, 원래 이 잡이 잡는 중복은
 * legacy(v1 마이그레이션 스냅샷)뿐이었다 — 카카오·NH API가 각각 만든 두 "살아있는"
 * 체결 파일은 서로를 모르고 **둘 다 적용**돼 수량이 실제로 두 배(매수) 또는 실현손익이
 * 중복 기록(매도)될 뻔했다(라이브 Vault의 실제 체결 1건으로 재현 확인). 이제
 * `update-holdings-from-executions.mjs`의 `findMatchingKnownExecution`이 legacy뿐
 * 아니라 "이미 holdingsApplied된 다른 소스의 체결"까지 대조해 이중 적용을 막는다
 * (2026-09-03 동시 수정 — 그 파일의 헤더 주석 참고). 이 잡을 배선하기 전에 그 수정이
 * 먼저 들어가 있어야 한다.
 *
 * ⚠️ 응답 필드 구조(2026-09-03, 라이브 조회로 실측 확인 — 위탁 실제 체결 1건
 * "메리츠금융지주 매도 30주 @132,000원"으로 검증) — getKrDailyOrderExecution/
 * getGoldExecution 둘 다 완전히 동일한 Output_0 필드 구조를 반환한다:
 * itg_orr_no(통합주문번호)·iem_cd(종목코드)·iem_nm(종목명)·sby_dit_cd_nm(매매구분명,
 * "현금매도"/"현금매수")·orr_qty(주문수량)·tot_cns_qty(총체결수량)·
 * cns_avg_uit_pr(체결평균단가). 실제 사례에서 orr_qty===tot_cns_qty===30,
 * cns_avg_uit_pr===132000으로 Vault에 이미 기록된 카카오 파싱 결과와 정확히
 * 일치함을 확인 — 이 잡은 필드명이 검증된 상태로 시작한다(IRP Phase 2와 달리
 * 미실측 경고 불필요).
 *
 * ⚠️ 체결 시각 필드가 없음 — 이 응답엔 체결/주문 시각을 담은 필드가 아예 없다
 * (IRP의 ord_tmd 같은 필드조차 없음). 그래서 tradeDate의 시각 부분은 항상
 * "00:00:00"으로 채운다(추정하지 않음, 이 코드베이스 원칙 — 있지도 않은 시각을
 * 지어내지 않는다). 같은 날 같은 종목·수량·방향의 체결이 2건 이상 있으면 시각까지
 * 겹쳐 파일명이 충돌할 수 있어, `itg_orr_no`(통합주문번호)를 `buildExecutionRecord`
 * 의 새 선택 필드 `orderNo`로 넘겨 그 경우에도 항상 서로 다른 레코드로 구분되게
 * 한다(ledger-vault-writer.mjs 2026-09-03 확장, 이 잡이 첫 소비처).
 *
 * ⚠️ 부분체결 폴링 멱등성 — tot_cns_qty는 그 주문의 누적 체결수량이라
 * (reconcile-irp-executions.mjs가 이미 겪은 것과 동일 클래스), 전량체결
 * (tot_cns_qty===orr_qty)인 행만 기록한다. 부분체결은 다음 폴링에서 재확인.
 *
 * 안전: 조회 전용(매매 API 미사용). 계좌 하나가 실패해도 나머지는 계속 진행.
 * 범위: 날짜 범위 파라미터가 없는 API라(orrDt 단일 날짜) 당일 조회만 된다 —
 * 매일 폴링해야 그날 체결을 놓치지 않는다(reconcile-irp-executions.mjs와 동일).
 *
 * ⚠️ "체결 없음" 응답 패턴이 IRP(KIS)와 반대(2026-09-03 라이브 확인) — KIS는
 * 당일 체결이 없으면 rt_cd:'0'(성공)+output:[](빈 배열)로 응답하지만, NH는
 * 업무거부(rsp_cd '11512', "데이터가 존재하지 않습니다")로 응답한다(위탁·금현물
 * 둘 다 동일 코드로 확인). `e.businessRejection===true && e.code==='11512'`일
 * 때만 정상적인 "오늘 체결 0건"으로 취급하고 collectWarning을 안 올린다 —
 * businessRejection 조건까지 함께 확인하는 이유(code-reviewer 지적, 2026-09-03):
 * `err.code`에 `rsp_cd`가 실리는 분기는 nhplug.mjs의 업무거부(businessRejection)
 * 분기 하나뿐이지만, 그 계약이 앞으로도 유지된다고 이 파일만으로는 보장 못 하므로
 * 명시적으로 좁혀서 인증실패·네트워크 오류 등이 우연히 같은 코드값을 갖더라도
 * 절대 조용히 삼켜지지 않게 한다. 그 외 실패는 그대로 경고.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-nh-executions.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/reconcile-nh-executions.mjs --dry-run  # 조회만, 쓰기 없음
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getKrDailyOrderExecution } from '../lib/nhplug-krstock.mjs';
import { getGoldExecution } from '../lib/nhplug-krgold.mjs';
import { resolveNhAccountsByLabel, maskNhActNo } from '../lib/nh-accounts.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BROKER = 'NH투자증권';

// CMA 제외 — 위 헤더 주석 참고(체결 자체가 없는 계좌).
const NH_EXECUTION_ACCOUNTS = new Set(['위탁', '금현물']);

// KIS 응답의 output/output1 패턴과 달리 NH krstock·krgold 체결조회는 둘 다
// Output_0(대문자, 배열)에 담아 준다 — nhplug.mjs callNh의 공용 응답 형태.
// 순수함수 — 테스트 가능. tot_cns_qty(총체결수량)가 0(또는 결측)인 행은 미체결이라
// 제외 — 추정 대신 확인(이 코드베이스 원칙, parseIrpPensionExecutions와 동일 관례).
//
// [핵심 안전장치] sby_dit_cd_nm(매매구분명) 화이트리스트(2026-09-03, code-reviewer
// 지적) — "매도"·"매수" 둘 다 아닌 값(결측·신용/대주 등 이 잡이 실측한 적 없는 표기)
// 이 오면 tradeType을 매수로 단정하지 않고 null로 남긴다. 매매구분은 보유수량의
// 부호를 결정하는 값이라 오판이 applyBuy/applySell을 통째로 뒤집을 수 있어, 여기서만은
// "매도가 아니면 매수"라는 단순 폴백을 안 쓴다(추정 대신 확인 원칙).
export function parseNhExecutionRows(rows) {
  const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const quantity = num(row.tot_cns_qty);
      const orderQty = num(row.orr_qty);
      const price = num(row.cns_avg_uit_pr);
      const dirRaw = String(row.sby_dit_cd_nm ?? '');
      const tradeType = dirRaw.includes('매도') ? '매도' : dirRaw.includes('매수') ? '매수' : null;
      return {
        orderNo: String(row.itg_orr_no ?? '').trim(),
        stockCode: String(row.iem_cd ?? '').trim(),
        stockName: String(row.iem_nm ?? '').trim(),
        tradeType,
        quantity,
        orderQty,
        fullyFilled: quantity != null && orderQty != null && quantity === orderQty,
        price,
      };
    })
    // tradeType!=null: 위 화이트리스트에서 탈락한 행 제외. orderNo!=='': 이 잡의
    // 유일한 파일명 충돌 방지 수단(시각이 전부 00:00:00이라 orderNo로만 구분됨,
    // 위 헤더 주석 참고)이라 결측이면 안전하게 기록을 건너뛴다(2026-09-03 code-
    // reviewer 지적 — 실측상 항상 존재하는 필드지만 이 잡에서는 선택이 아니라
    // 필수이므로 결측을 구조 이상 신호로 취급, 아래 rawRows.length>0&&executions.
    // length===0 경고가 이 경우도 함께 잡아준다).
    .filter((e) => e.tradeType != null && e.orderNo !== '' && e.quantity != null && e.quantity > 0 && e.price != null && e.price > 0);
}

function kstTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { dashed: `${get('year')}-${get('month')}-${get('day')}`, compact: `${get('year')}${get('month')}${get('day')}` };
}

async function main() {
  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });

  const byLabel = resolveNhAccountsByLabel(accounts, NH_EXECUTION_ACCOUNTS);
  for (const label of NH_EXECUTION_ACCOUNTS) {
    if (!byLabel.has(label)) {
      collectWarning(`NH 체결조회: ${label} 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요)`);
    }
  }

  const { dashed: today, compact: orrDt } = kstTodayParts();
  let recorded = 0, skipped = 0, partial = 0;

  for (const [label, actNo] of byLabel) {
    let rawRows;
    try {
      // ostCnsDit: '2'(체결)로 명시 — 기본값 '0'(전체)이면 미체결 주문 행까지 같이
      // 와서, 그날 지정가 주문이 하나도 체결 안 된 평범한 날에도 rawRows.length>0인데
      // 전부 quantity=0으로 필터 탈락해 아래 "구조 이상" 경고가 오탐 발사된다(2026-09-03
      // code-reviewer 지적 — 이 경고의 전제는 "성공 응답에 담긴 행은 전부 체결"인데
      // 기본값 '0'은 그 전제를 깬다).
      const body = label === '금현물'
        ? await getGoldExecution({ token, actNo, orrDt, ostCnsDit: '2' })
        : await getKrDailyOrderExecution({ token, actNo, orrDt, ostCnsDit: '2' });
      rawRows = body?.Output_0;
    } catch (e) {
      // ⚠️ NH는 "당일 체결 없음"을 성공+빈배열이 아니라 업무거부(rsp_cd 11512,
      // "데이터가 존재하지 않습니다")로 응답한다(2026-09-03 라이브 확인 — IRP의
      // KIS API와 반대 패턴, KIS는 output:[]로 성공 응답). businessRejection===true
      // 까지 함께 확인해야 하는 이유는 위 헤더 주석 참고 — 그 외 실패는 그대로 경고.
      if (e.businessRejection === true && e.code === '11512') {
        console.log(`  · ${label}: 오늘 체결 없음(NH 11512)`);
        continue;
      }
      collectWarning(`NH 체결조회 실패(${label}): ${e.message}`);
      continue;
    }

    // [핵심 안전장치] 성공 응답인데 Output_0이 배열이 아니면(봉투 구조 변경 등)
    // 조용히 "0건"으로 넘어가지 않고 경고 — 이 잡의 전제상(11512 아니면 성공 응답은
    // 항상 배열을 가져야 함) 여기 도달했는데 배열이 아니면 그 자체가 이상 신호다.
    if (!Array.isArray(rawRows)) {
      collectWarning(`NH 체결조회(${label}): 성공 응답인데 Output_0 배열이 없음 — 응답 봉투 구조 확인 필요`);
      continue;
    }

    const executions = parseNhExecutionRows(rawRows);
    // [핵심 안전장치] 원본 행이 있는데 파싱 결과가 비면(필드명 불일치 등 구조 이상
    // 신호) "오늘 체결 0건"과 구분해 노출 — reconcile-irp-executions.mjs와 동일 안전장치.
    if (rawRows.length > 0 && executions.length === 0) {
      collectWarning(`NH 체결조회(${label}): 응답 ${rawRows.length}행이 있는데 전부 필터 탈락 — 필드명/구조 확인 필요`);
    }

    for (const e of executions) {
      if (!e.fullyFilled) { partial++; continue; }
      const { filename, content, dir, dedupKey } = buildExecutionRecord({
        tradeDate: `${today} 00:00:00`,
        tradeType: e.tradeType,
        stockCode: e.stockCode,
        stockName: e.stockName,
        quantity: e.quantity,
        price: e.price,
        currency: 'KRW',
        broker: BROKER,
        account: label,
        acctNo: maskNhActNo(actNo) || '',
        orderNo: e.orderNo,
      });
      const filepath = join(dir, filename);
      if (existsSync(filepath)) {
        const existing = parseFrontmatter(readFileSync(filepath, 'utf8'));
        if (existing.dedupKey !== dedupKey) {
          collectWarning(`NH 체결기록: 파일명 충돌(내용 다름) — ${filepath} 기존 dedupKey="${existing.dedupKey}" vs 신규="${dedupKey}"`);
        } else {
          console.log(`  · 이미 기록됨(중복 아님) — ${label} ${e.stockName} ${e.quantity}주`);
        }
        skipped++;
        continue;
      }
      console.log(`  + [체결기록${DRY_RUN ? '(예정)' : ''}] ${label} ${e.tradeType} ${e.stockName} ${e.quantity}주 @${e.price}원 — ${filepath}`);
      if (!DRY_RUN) {
        mkdirSync(dir, { recursive: true });
        writeAtomic(filepath, content);
      }
      recorded++;
    }
  }

  // [핵심 안전장치] 지정가 주문이 부분체결 상태로 장 마감(또는 잔량 취소)되면
  // tot_cns_qty<orr_qty가 영구 고정돼 이 잡은 그 체결을 영원히 기록하지 않는다
  // (2026-09-03 code-reviewer 지적 — partial++만으로는 stdout에만 남고 launchd
  // 잡의 stdout은 아무도 안 봐서 오너에게 알림이 안 감). 카카오 경로가 지금은 이
  // 구멍을 메우고 있지만 5단계에서 사라지므로, 여기서도 명시적으로 경보한다.
  if (partial > 0) {
    collectWarning(`NH 체결조회: 부분체결 ${partial}건 미기록 — 잔량 취소/미체결로 끝났으면 영구 누락이므로 수동 확인 필요`);
  }

  console.log(`\n✅ NH 체결 ${recorded}건 신규 기록 · ${skipped}건 이미 존재 · ${partial}건 부분체결 대기` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
  await flushWarnings('reconcile-nh-executions');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-nh-executions').catch(() => {});
    process.exit(1);
  });
}
