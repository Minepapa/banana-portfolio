#!/usr/bin/env node
/**
 * IRP(퇴직연금) 체결 자동기록 — KIS 퇴직연금 체결조회 API(TTTC2201R)로 당일 체결을
 * 직접 확인해 Facts/Ledger/Executions에 기록한다.
 *
 * 왜: `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`
 * 마이그레이션 2단계. IRP 체결(매월 26일경 TIGER TDF2045 자동매수)은 지금까지
 * 카카오 알림(한국투자증권 브로커 패턴, notification-parsers.mjs)에만 의존했다 —
 * 오너 지적으로 "IRP도 KIS API로 대체 가능한지" 재검토, 일반 국내주식 체결조회
 * (TTTC0081R)는 IRP에서 거부됨을 실측 확인했지만(퇴직연금계좌는 해당 서비스가
 * 불가합니다) KIS 공식 예제 저장소에서 퇴직연금 전용 API(TTTC2201R)를 발견해
 * 대체. watch-order-fill.mjs(퀀트 트랙)가 "체결 즉시 KIS API로 직접 확인해
 * Facts/Ledger에 기록"하는 것과 동일 철학 — 카카오 알림 파싱 없이 API로 직접
 * 원장을 채운다.
 *
 * ⚠️ 필드 구조 미실측 경고(2026-09-02) — scripts/lib/kis.mjs의
 * getIrpPensionExecutions/parseIrpPensionExecutions 헤더 주석 참고. KIS 공식
 * 예제(chk_pension_inquire_daily_ccld.py)의 COLUMN_MAPPING을 정본으로 필드명을
 * 확정했지만, 실제 체결 데이터가 있는 응답은 아직 못 봤다(오너 확인: "지금
 * 만들어봐. 내일 장 중에 테스트 매수 진행해볼게"). 다음 실제 체결 발생 시
 * 재검증 필요 — 특히 pchs_avg_pric(매입평균가격)이 "이번 체결 단가"인지
 * "계좌 누적 평단가"인지 명칭만으로는 모호.
 *
 * 멱등: buildExecutionRecord의 파일명 자체가 dedup 키(날짜+시간+매매구분+종목명+수량)
 * — 같은 체결을 다시 조회해도 이미 기록된 파일이 있으면 건너뛴다(parse-
 * notifications-to-vault.mjs·watch-order-fill.mjs와 동일 관례). 파일명이 같은데
 * 내용(dedupKey)이 다르면(파일명 충돌) 조용히 넘기지 않고 경고를 올린다.
 *
 * ⚠️ 전량체결 확정 행만 기록(2026-09-02, code-reviewer 지적으로 신설) — tot_ccld_qty는
 * 그 주문의 "누적" 총체결수량이라, 부분체결 상태를 그대로 기록하면 다음 폴링에서
 * 전량체결로 바뀌어도 파일명(주문시각 기준) dedup에 걸려 나머지 수량이 영구
 * 누락된다. fullyFilled(kis.mjs parseIrpPensionExecutions 참고)인 행만 기록해
 * 이 함정을 피한다 — 부분체결은 다음 폴링까지 대기.
 *
 * 범위: 날짜 범위 파라미터가 없는 API라 "당일"만 조회된다(kis.mjs 헤더 주석
 * 참고) — 매일 도는 스케줄(reconcile-irp.mjs와 동일 launchd 주기 권장)이어야
 * 그날 체결을 놓치지 않는다.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-irp-executions.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/reconcile-irp-executions.mjs --dry-run  # 조회만, 쓰기 없음
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasKisCredentials, loadIrpAccount, getKisToken, getIrpPensionExecutions } from '../lib/kis.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { IRP_ACCOUNT_NO } from '../lib/account-resolver.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BROKER = '한국투자증권';
const ACCOUNT_LABEL = 'IRP';

// KST 벽시계 기준 "YYYY-MM-DD" — reconcile-irp.mjs의 예수금앵커 타임스탬프와
// 동일 원칙(order-gate.mjs checkMarketOpen과 통일된 Asia/Seoul 관례, UTC로
// 쓰면 9시간 어긋나는 실사고가 이미 한 번 있었음, 위 파일 참고).
function kstToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// KIS ord_tmd(주문시각, "HHMMSS" 6자리)를 buildExecutionRecord가 기대하는
// "YYYY-MM-DD HH:MM:SS" 형식으로 조합. 순수함수 — 테스트 가능. orderTime이
// 6자리가 아니면(예상 밖 형식) 자정(00:00:00)으로 안전 폴백 — 추정 대신
// "시각을 모른다"는 걸 명시적으로 드러내되, dedup 파일명 생성 자체는 막지 않는다.
export function buildTradeDate(dateStr, orderTime) {
  const m = String(orderTime ?? '').trim().match(/^(\d{2})(\d{2})(\d{2})$/);
  const time = m ? `${m[1]}:${m[2]}:${m[3]}` : '00:00:00';
  return `${dateStr} ${time}`;
}

async function main() {
  if (!hasKisCredentials()) {
    console.log('ℹ️ KIS 크리덴셜 미설정 — 스킵');
    return;
  }
  const irpAccount = loadIrpAccount();
  if (!irpAccount) {
    console.log('ℹ️ IRP 계좌정보(irpAccount) 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret, cano, acntPrdtCd } = irpAccount;

  let token;
  try {
    token = await getKisToken({ appkey, appsecret });
  } catch (e) {
    collectWarning(`IRP 체결조회: KIS 토큰 발급 실패 — ${e.message}`);
    await flushWarnings('reconcile-irp-executions');
    return;
  }

  let executions, rawCount;
  try {
    ({ executions, rawCount } = await getIrpPensionExecutions({
      token, appkey, appsecret, cano, acntPrdtCd,
    }));
  } catch (e) {
    collectWarning(`IRP 체결조회 실패: ${e.message}`);
    await flushWarnings('reconcile-irp-executions');
    return;
  }

  // [핵심 안전장치] rawCount>0인데 executions가 비면 "체결 0건"이 아니라 필드명/구조가
  // 어긋나 전부 필터 탈락했다는 신호(kis.mjs parseIrpPensionExecutions 주석 참고) —
  // 내일 실측 검증이 이 경고 없이는 "0건"만 보고 원인 추적을 처음부터 다시 해야 한다.
  if (rawCount > 0 && executions.length === 0) {
    collectWarning(`IRP 체결조회: 응답 ${rawCount}행이 있는데 전부 필터 탈락 — 필드명/구조 확인 필요`);
  }

  const fullyFilled = executions.filter((e) => e.fullyFilled);
  if (!fullyFilled.length) {
    console.log(rawCount === 0 ? '오늘 IRP 체결 0건' : `전량체결 확정 행 없음(부분체결 ${executions.length}건 대기 중 — 다음 폴링에서 재확인)`);
    await flushWarnings('reconcile-irp-executions');
    return;
  }

  const today = kstToday();
  let recorded = 0, skipped = 0;
  for (const e of fullyFilled) {
    const { filename, content, dir, dedupKey } = buildExecutionRecord({
      tradeDate: buildTradeDate(today, e.orderTime),
      tradeType: e.tradeType,
      stockCode: e.stockCode,
      stockName: e.stockName,
      quantity: e.quantity,
      price: e.price,
      currency: 'KRW',
      broker: BROKER,
      account: ACCOUNT_LABEL,
      acctNo: IRP_ACCOUNT_NO,
    });
    const filepath = join(dir, filename);
    if (existsSync(filepath)) {
      // 파일명이 같아도 실제 내용(dedupKey)이 다르면 진짜 중복이 아니라 파일명 충돌
      // (예: 주문시각 파싱 실패로 여러 체결이 같은 00:00:00 폴백에 몰린 경우) —
      // 조용히 넘기지 않고 경고를 올린다(2026-09-02, code-reviewer 지적).
      const existing = parseFrontmatter(readFileSync(filepath, 'utf8'));
      if (existing.dedupKey !== dedupKey) {
        collectWarning(`IRP 체결기록: 파일명 충돌(내용 다름) — ${filepath} 기존 dedupKey="${existing.dedupKey}" vs 신규="${dedupKey}"`);
      } else {
        console.log(`  · 이미 기록됨(중복 아님) — ${e.stockName} ${e.quantity}주`);
      }
      skipped++;
      continue;
    }
    console.log(`  + [체결기록${DRY_RUN ? '(예정)' : ''}] ${e.tradeType} ${e.stockName} ${e.quantity}주 @${e.price}원 — ${filepath}`);
    if (!DRY_RUN) {
      mkdirSync(dir, { recursive: true });
      writeAtomic(filepath, content);
      recorded++;
    }
  }

  console.log(`\n✅ IRP 체결 ${recorded}건 신규 기록 · ${skipped}건 이미 존재` + (DRY_RUN ? ` (드라이런 — 쓰기 없음, 기록 대상 ${fullyFilled.length - skipped}건)` : ''));
  await flushWarnings('reconcile-irp-executions');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-irp-executions').catch(() => {});
    process.exit(1);
  });
}
