#!/usr/bin/env node
/**
 * 위탁·CMA·금현물 예수금 — NH PLUG API 직접조회 → State/Holdings/{계좌}-예수금.md 직접기록.
 *
 * 왜: `Log/Strategy/2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`
 * 마이그레이션 3단계. 오너 확정 원문: "예수금 앵커는 통일 루프 깸. 계좌별
 * 분기." — API로 직접 조회 가능한 계좌는 update-cash-from-ledger.mjs의
 * 기준점+델타 재구성 루프를 아예 타지 않는다. API 응답 자체가 이미 "지금 이
 * 순간의 정확한 예수금"이라 그 위에 델타를 더 얹을 이유가 없고(오히려 시차
 * 버그의 원천), 이 프로젝트가 예수금 이중반영 실사고 2건을 겪은 지점이 정확히
 * "기준점+델타 재구성" 방식이었다(Strategy 문서 "왜" 절 참고) — 재구성 로직
 * 자체를 없애 그 사고 클래스를 구조적으로 제거한다.
 *
 * ⚠️ 설계 정정(2026-09-03) — 처음엔 reconcile-irp.mjs(KIS, IRP)가 이미 쓰던
 * "CashEvent로 기록 → update-cash-from-ledger.mjs가 기준점으로 읽어 델타
 * 재구성"과 같은 패턴으로 만들었었다(code-reviewer 지적으로 발견: 이러면
 * "통일 루프 깸"이 스펙과 다르게 "루프 안에 API 소스 하나 추가"로 축소됨,
 * 게다가 그 CashEvent의 balance 정의(dca=당일예수금)가 카카오 경로의 기존
 * 정의(출금가능금액)와 달라 같은 계좌에서 최신값 경쟁이 벌어지면 서로 다른
 * 정의의 숫자가 뒤섞임). 오너 확인(2026-09-03) 후 스펙대로 델타 완전 제거로
 * 재설계 — State/Holdings를 직접 쓰고 CashEvent·update-cash-from-ledger.mjs를
 * 아예 거치지 않는다. `reconcile-irp.mjs`도 같은 턴에 동일하게 재설계.
 *
 * 카카오 알림 파싱(parseCashAlarm)은 그대로 둔다(제거는 5단계, "안정화 후" —
 * Strategy 문서 참고) — 그 경로가 계속 Facts/Ledger/CashEvents에 기록하더라도
 * 이 세 계좌는 이제 update-cash-from-ledger.mjs가 그 파일들을 안 읽으므로
 * (ALL_ACCOUNTS에서 제외, update-cash-from-ledger.mjs 참고) 무해하게 무시된다.
 *
 * IRP·연금저축·ISA는 스코프 밖: IRP는 reconcile-irp.mjs가 동일 원칙(직접기록,
 * 델타 없음)으로 별도 처리, 연금저축은 애초에 NH 계좌가 아님(삼성증권), ISA는
 * NH가 /n2/acctinfo 계좌목록 API에 아예 노출하지 않아(2026-09-03 라이브 확인)
 * 여전히 카카오/수동 기준점+델타 방식(update-cash-from-ledger.mjs)을 쓴다.
 *
 * ⚠️ 예수금 필드 선택(2026-09-03, code-reviewer 지적으로 정정) — 처음엔
 * dca(당일예수금)만 썼는데, 카카오 경로(notification-parsers.mjs parseCashAlarm)
 * 는 처음부터 줄곧 "출금가능금액"(drn_pbl_amt)을 기준으로 기록해왔다. 위탁·CMA
 * 라이브 조회에서 이 시점엔 두 값이 우연히 같았지만(신용·미결제 거래가 없어서),
 * dca는 결제(T+2) 반영 전 값이라 매수 직후 며칠간 실제보다 부풀려질 수 있다
 * (nxt_dd_dca/nxt2_dd_dca triple의 존재 자체가 이 결제 시차 구조의 증거,
 * cash-base.mjs의 "매도 후 미결제 예수금" 함정과 동일 계열). drn_pbl_amt를
 * 우선 사용해 카카오 경로와 정의를 통일한다. 단 금현물 응답엔 drn_pbl_amt
 * 필드 자체가 없음을 라이브 조회로 확인(2026-09-03) — 이 경우만 dca로 폴백
 * (extractNhCashDeposit 참고).
 *
 * 안전: 조회 전용(매매 API 미사용). 계좌 하나가 실패해도 나머지는 계속 진행.
 *
 * 사용법:
 *   node scripts/jobs/reconcile-nh-cash.mjs            # 실제로 State/Holdings 기록
 *   node scripts/jobs/reconcile-nh-cash.mjs --dry-run  # 조회만, 쓰기 없음
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getKrBalance } from '../lib/nhplug-krstock.mjs';
import { getGoldBalance } from '../lib/nhplug-krgold.mjs';
import { resolveNhAccountsByLabel } from '../lib/nh-accounts.mjs';
import { buildCashHoldingRecord } from '../lib/holdings-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// 이 잡이 대사하는 계좌 — ISA·연금저축·IRP는 위 헤더 주석 참고, 스코프 밖.
const NH_CASH_ACCOUNTS = new Set(['위탁', 'CMA', '금현물']);

// 계좌잔고(getKrBalance) / 예수금및잔고(getGoldBalance) 응답 Output_0 → 예수금(원).
// 순수함수 — 테스트 가능. drn_pbl_amt(출금가능금액) 우선, 없으면(금현물 응답엔
// 이 필드 자체가 없음, 라이브 확인) dca(당일예수금)로 폴백 — 위 헤더 주석의 필드
// 선택 근거 참고. 둘 다 없으면(구조 변경 등 신호) throw — 0으로 추정하지 않는다.
// 값 자체가 0인 건 허용(전액 매수 등 실제로 가능한 상태이므로 price>0류 가드를
// 쓰면 안 됨 — `??`는 null/undefined에서만 다음으로 넘어가고 0은 그대로 보존한다).
export function extractNhCashDeposit(output0) {
  const raw = output0?.drn_pbl_amt ?? output0?.dca;
  if (raw == null) throw new Error('NH 계좌잔고 응답에 drn_pbl_amt(출금가능금액)·dca(예수금) 필드 모두 없음 — 구조 확인 필요');
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`NH 계좌잔고 예수금 값이 숫자가 아님: ${raw}`);
  return n;
}

// listNhAccounts() 결과 → {계좌명: 실계좌번호} 맵. NH_CASH_ACCOUNTS 밖의 계좌(모의
// 투자·아직 매핑 안 된 신규 계좌 등)는 조용히 제외.
// ⚠️ 공용 모듈로 승격(2026-09-03) — 마스킹 충돌 가드를 포함한 실제 로직은
// nh-accounts.mjs의 resolveNhAccountsByLabel로 옮겼다(reconcile-nh-executions.mjs가
// 두 번째 소비처가 되며 DRY). 이 함수는 얇은 래퍼로 남겨 기존 이름·테스트를 그대로 유지.
export function resolveNhCashAccountMap(accounts) {
  return resolveNhAccountsByLabel(accounts, NH_CASH_ACCOUNTS);
}

function kstNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function main() {
  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const byLabel = resolveNhCashAccountMap(accounts);

  for (const label of NH_CASH_ACCOUNTS) {
    if (!byLabel.has(label)) {
      collectWarning(`NH 예수금조회: ${label} 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요)`);
    }
  }

  let written = 0;
  for (const [label, actNo] of byLabel) {
    // 계좌별로 조회 직후 시각을 찍는다(루프 진입 전 한 번만 찍으면 3계좌 순차
    // 조회 사이에 생긴 체결이 "조회 시점 이후"로 잘못 해석될 여지가 있었음 —
    // 지금은 델타 재구성 자체가 없어져 그 위험은 사라졌지만, anchorTs는 여전히
    // "이 잔고가 언제 기준의 값인지"를 감사용으로 정확히 남겨야 한다).
    const ts = kstNow();
    try {
      const body = label === '금현물'
        ? await getGoldBalance({ token, actNo })
        : await getKrBalance({ token, actNo });
      const cash = extractNhCashDeposit(body?.Output_0);
      if (cash === 0) {
        collectWarning(`NH 예수금조회: ${label} 예수금이 0으로 응답 — 실제 0원인지 확인 필요(기록은 그대로 진행)`);
      }
      const { filename, content, dir } = buildCashHoldingRecord({
        account: label, balance: cash, raw: cash, negative: cash < 0,
        anchorBase: cash, anchorTs: ts, anchorSource: 'NH API 직접조회',
      });
      console.log(`  + [예수금] ${label} ${ts} 잔고 ${cash.toLocaleString()}원`);
      if (!DRY_RUN) {
        mkdirSync(dir, { recursive: true });
        writeAtomic(join(dir, filename), content);
      }
      written++;
    } catch (e) {
      collectWarning(`NH 예수금조회 실패(${label}): ${e.message}`);
    }
  }

  const flag = written === 0 && byLabel.size > 0 ? '⚠️' : '✅';
  console.log(`\n${flag} NH 예수금 ${written}/${byLabel.size}계좌 기록` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
  await flushWarnings('reconcile-nh-cash');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-nh-cash').catch(() => {});
    process.exit(1);
  });
}
