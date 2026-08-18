#!/usr/bin/env node
/**
 * 계좌별 예수금(현금) 잔고 계산 → State/Holdings/{계좌}-예수금.md (예수금앵커 배선 4단계)
 *
 * 지금까지 배선된 조각을 실제로 조립하는 마지막 단계 — Facts/Ledger의 세 원장을 읽어
 * 계좌별 실제 잔고를 계산한다:
 *   - CashEvents(예수금앵커): NH 4계좌(위탁·ISA·금현물·CMA)의 실제 입출금 알림 원문.
 *     계좌는 파싱 시점에 이미 확정돼 있다(nh-accounts.mjs 전체계좌번호매칭).
 *   - Executions(체결): 계좌는 update-holdings-from-executions.mjs가 영구기록한다
 *     (2026-08-18 확장). 매수는 현금유출(-), 매도는 현금유입(+).
 *   - Dividends(배당): 계좌는 같은 잡이 영구기록한다. 항상 현금유입(+).
 *
 * NH 4계좌는 "가장 최근 앵커 알림 잔고 + 그 시각 이후 흐름 합산"(cash-ledger.mjs
 * resolveNhCashAnchor+computeCashDelta+settleCash) — v1의 날짜절삭 버그를 전체
 * 타임스탬프 비교로 구조적으로 막는다(cash-ledger.mjs 헤더 주석 참고).
 *
 * 연금저축은 카카오 입출금 알림 자체가 없어(오너 확인, 2026-08-17) 앵커가 없다 —
 * 마이그레이션 시점(0원) 기준 복식부기로 배당·매도(+)·매수(−) 전액을 반영한다
 * (resolvePensionCashLedger, 2026-08-16 사고의 정확한 수정).
 *
 * ⚠️ 범위: 이 잡은 위탁·ISA·금현물·CMA·연금저축 5계좌의 "각자 실제 잔고"만 계산해
 * 그대로 저장한다(감사 정확성 우선 — 계좌 하나엔 그 계좌의 진짜 숫자만 남긴다).
 * "금현물 대기현금을 위탁과 합쳐서 본다"는 정책(오너 확정)은 여기서 물리적으로
 * 합치지 않는다 — cash-ledger.mjs의 resolveDesignatedCashBalance가 그 관점만 별도
 * 계산해주고, 실제 소비(신규현금배분 판단)는 new-cash-allocation.mjs 재작성 몫이다.
 *
 * ⚠️ 알려진 한계(2026-08-18): 펀드적립(연금저축 VIP 펀드)·환전은 아직 파싱은 되지만
 * (notification-parsers.mjs parseFundBuy/parseExchange) Facts/Ledger에 배선 안 됨
 * (parse-notifications-to-vault.mjs 범위 밖, 의도적 — 헤더 주석 참고) — 이 두 종류가
 * 실제로 발생한 계좌(연금저축 등)는 그만큼 잔고가 소폭 부정확할 수 있다.
 *
 * 매 실행마다 기준점+델타를 처음부터 다시 계산해 전체를 덮어쓴다("지금 상태" 원칙,
 * vault-paths.mjs state.* 관례와 동일) — 누적 증분이 아니라 순수 재계산이라 같은
 * 입력이면 항상 같은 출력이 나온다(2026-08-17 신규현금배분 10배 부풀림 사고— 증분
 * 누적 방식의 위험성을 겪은 뒤 의도적으로 선택한 설계).
 *
 * 사용법:
 *   node scripts/jobs/update-cash-from-ledger.mjs            # 실제로 반영
 *   node scripts/jobs/update-cash-from-ledger.mjs --dry-run  # 계산만, 쓰기 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { NH_ACCOUNT_MAP } from '../lib/nh-accounts.mjs';
import { resolveNhCashAnchor, computeCashDelta, settleCash, resolvePensionCashLedger } from '../lib/cash-ledger.mjs';
import { buildCashHoldingRecord, holdingFilename } from '../lib/holdings-vault-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const NH_ACCOUNTS = [...new Set(Object.values(NH_ACCOUNT_MAP))]; // 위탁·ISA·금현물·CMA
const PENSION_ACCOUNT = '연금저축';

function readVaultFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const filepath = join(dir, f);
    return parseFrontmatter(readFileSync(filepath, 'utf8'));
  });
}

// 이전 실행에서 이미 써둔 예수금 파일이 있으면 그 앵커 정보를 "저장값" 폴백으로
// 읽는다 — NH 4계좌는 실제로 항상 CashEvents가 있어(4계좌 전부 실알림 확인,
// cash-ledger.mjs 헤더 주석) 정상 가동 중엔 거의 쓰일 일이 없지만, 최초 실행 등
// CashEvents가 아직 하나도 없는 과도기를 안전하게 넘기기 위한 안전망이다.
function loadStoredAnchor(account) {
  const filepath = join(VAULT_PATHS.state.holdings, holdingFilename(account, '예수금'));
  if (!existsSync(filepath)) return null;
  const parsed = parseFrontmatter(readFileSync(filepath, 'utf8'));
  if (!Number.isFinite(parsed.anchorBase)) return null;
  return { base: parsed.anchorBase, baseTs: parsed.anchorTs ?? '', source: parsed.anchorSource ?? '' };
}

// 계좌별 현금흐름(체결+배당) — legacy(마이그레이션 스냅샷) 제외: 그 시점 값은 이미
// 별도 스냅샷으로 반영돼 있어 델타로 다시 더하면 이중계상된다. 체결은 매수(-)/매도(+),
// 배당은 항상(+). 계좌가 아직 안 풀린(account:null) 레코드는 어느 계좌 것인지 몰라
// 자동으로 전부 제외된다(추정 없음 — update-holdings-from-executions.mjs가 풀어줄
// 때까지 이 잡의 계산에서는 조용히 빠짐, 다음 실행에 자연히 반영됨).
function buildFlows(account, executions, dividends) {
  const flows = [];
  for (const e of executions) {
    if (e.legacy || e.account !== account) continue;
    const amount = (e.quantity ?? 0) * (e.price ?? 0);
    if (!Number.isFinite(amount)) continue;
    flows.push({ ts: e.tradeDate, amount: e.tradeType === '매도' ? amount : -amount });
  }
  for (const d of dividends) {
    if (d.legacy || d.account !== account) continue;
    const amount = d.afterTaxAmount ?? 0;
    if (!Number.isFinite(amount)) continue;
    flows.push({ ts: `${d.date} ${d.receivedTime || '00:00:00'}`, amount });
  }
  return flows;
}

function writeCash(cash) {
  const { filename, content, dir } = buildCashHoldingRecord(cash);
  if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
}

async function main() {
  const executions = readVaultFiles(VAULT_PATHS.facts.ledger.executions);
  const dividends = readVaultFiles(VAULT_PATHS.facts.ledger.dividends);
  const cashEvents = readVaultFiles(VAULT_PATHS.facts.ledger.cashEvents);
  console.log(`🔎 체결 ${executions.length}건 · 배당 ${dividends.length}건 · 예수금앵커 ${cashEvents.length}건 로드`);

  let written = 0, skippedNoAnchor = 0, negativeWarnings = 0;

  for (const account of NH_ACCOUNTS) {
    const accountEvents = cashEvents
      .filter((c) => c.account === account)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const latestAlarm = accountEvents.length > 0
      ? accountEvents[accountEvents.length - 1]
      : null;
    const anchor = resolveNhCashAnchor({
      stored: loadStoredAnchor(account),
      latestAlarm: latestAlarm ? { balance: latestAlarm.balance, ts: latestAlarm.ts } : null,
    });

    if (anchor.base === null) {
      console.log(`  ⚠️  ${account}: 기준점 없음(예수금앵커 알림도, 기존 저장값도 없음) — 건너뜀`);
      skippedNoAnchor++;
      continue;
    }

    const flows = buildFlows(account, executions, dividends);
    const delta = computeCashDelta({ anchorTs: anchor.baseTs, flows });
    const settled = settleCash(anchor.base, delta);
    const flag = settled.negative ? ' ⚠️ 마이너스(데이터 점검 필요)' : '';
    console.log(`  ${account}: 기준 ${anchor.base.toLocaleString()}원(${anchor.baseTs || '이관'}, ${anchor.source}) + 델타 ${delta.toLocaleString()}원 → ${settled.cash.toLocaleString()}원${flag}`);
    if (settled.negative) negativeWarnings++;

    writeCash({
      account, balance: settled.cash, raw: settled.raw, negative: settled.negative,
      anchorBase: anchor.base, anchorTs: anchor.baseTs, anchorSource: anchor.source,
    });
    written++;
  }

  // 연금저축 — 알림 기반 앵커가 없어 항상 0원 기준 복식부기(cash-ledger.mjs 헤더 주석).
  const pensionFlows = buildFlows(PENSION_ACCOUNT, executions, dividends);
  const pension = resolvePensionCashLedger({ flows: pensionFlows });
  const pensionFlag = pension.negative ? ' ⚠️ 마이너스(데이터 점검 필요)' : '';
  console.log(`  ${PENSION_ACCOUNT}: 복식부기 델타합산 → ${pension.cash.toLocaleString()}원${pensionFlag}`);
  if (pension.negative) negativeWarnings++;
  writeCash({
    account: PENSION_ACCOUNT, balance: pension.cash, raw: pension.raw, negative: pension.negative,
    anchorBase: 0, anchorTs: '', anchorSource: '복식부기(알림없음)',
  });
  written++;

  console.log(
    `\n✅ 예수금 ${written}계좌 계산 완료 · 기준점없음 ${skippedNoAnchor}건 · 마이너스경고 ${negativeWarnings}건` +
    (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
