#!/usr/bin/env node
/**
 * 계좌별 예수금(현금) 잔고 계산 → State/Holdings/{계좌}-예수금.md (예수금앵커 배선 4단계)
 *
 * 지금까지 배선된 조각을 실제로 조립하는 마지막 단계 — Facts/Ledger의 세 원장을 읽어
 * 계좌별 실제 잔고를 계산한다:
 *   - CashEvents(예수금앵커): "이 시각에 이 계좌 잔고가 이 값이었다"는 사실 기록.
 *     NH 4계좌(위탁·ISA·금현물·CMA)는 카카오 입출금 알림에서 자동 파싱(nh-accounts.mjs
 *     전체계좌번호매칭), 연금저축·IRP는 알림이 없어(2026-08-18 오너 확인) 오너가 앱에서
 *     직접 확인한 값을 수동으로 기록한다 — 자동/수동 구분 없이 그냥 "가장 최근 값"이
 *     기준점이 된다(cash-ledger.mjs resolveCashAnchor).
 *   - Executions(체결): 계좌는 update-holdings-from-executions.mjs가 영구기록한다
 *     (2026-08-18 확장). 매수는 현금유출(-), 매도는 현금유입(+).
 *   - Dividends(배당): 계좌는 같은 잡이 영구기록한다. 항상 현금유입(+).
 *
 * ⚠️ 설계 통합(2026-08-18) — 처음엔 "NH 4계좌(자동 알림)"과 "연금저축(알림 없음,
 * 0원-이후-복식부기)"을 별도 로직으로 나눴었다. 그런데 오너가 IRP(한국투자증권,
 * 알림 없음·매월 26일 고정 25만원 자동입금)까지 "모든 계좌 동일하게" 원했고, 연금저축도
 * 실은 잔고 확인이 가능함이 드러났다(MMF 보유 평가금액이 곧 예수금 — 배당·수익금이
 * 자동으로 MMF에 쌓이고 매수 시 MMF를 먼저 매도하는 구조). "자동 알림 유무"가 아니라
 * "기준점을 어떻게 얻는가"만 다를 뿐 델타 계산은 6계좌 전부 동일해야 맞다 —
 * 계좌별 특수 함수(resolvePensionCashLedger 등) 없이 전부 같은 루프를 돈다.
 * 알림 없는 계좌(연금저축·IRP)는 오너가 확인한 값을 수동 CashEvent로 넣어두면
 * (자동 알림과 완전히 같은 레코드 모양) 그게 그대로 기준점이 된다.
 *
 * 기준점+델타 계산은 전체 타임스탬프 비교라 v1의 날짜절삭 버그가 구조적으로 재발
 * 불가능하다(cash-ledger.mjs 헤더 주석 참고).
 *
 * ⚠️ 범위: 이 잡은 6계좌(위탁·ISA·금현물·CMA·연금저축·IRP)의 "각자 실제 잔고"만
 * 계산해 그대로 저장한다(감사 정확성 우선 — 계좌 하나엔 그 계좌의 진짜 숫자만 남긴다).
 * "금현물 대기현금을 위탁과 합쳐서 본다"는 정책(오너 확정)은 여기서 물리적으로
 * 합치지 않는다 — cash-ledger.mjs의 resolveDesignatedCashBalance가 그 관점만 별도
 * 계산해주고, 실제 소비(신규현금배분 판단)는 new-cash-allocation.mjs 재작성 몫이다.
 *
 * ⚠️ 알려진 한계(2026-08-18):
 * - 펀드적립(연금저축 VIP 펀드)·환전은 아직 파싱은 되지만(notification-parsers.mjs
 *   parseFundBuy/parseExchange) Facts/Ledger에 배선 안 됨(parse-notifications-to-vault.mjs
 *   범위 밖, 의도적) — 이 두 종류가 실제로 발생한 계좌는 그만큼 잔고가 소폭 부정확할 수 있다.
 * - 연금저축·IRP는 지금 자동 CashEvent가 없어 오너가 수동으로 갱신해줘야 최신 상태
 *   유지됨. 둘 다 알림 없는 고정성 자동입금이 있다 — IRP는 매월 26일 25만원 고정,
 *   연금저축은 매월 21일(연봉 연동 비율이라 매달 조금씩 다름, 2026년 기준 48만~50만원
 *   추정) — 어느 쪽도 정확한 금액을 추정해 자동 반영하지 않는다.
 * - IRP는 사실 KIS API(getAccountBalance, tr_id TTTC8434R)로 예수금 자동조회가 가능함이
 *   확인됐다(2026-08-18 — reconcile-irp.mjs의 2026-07-26 "API로 조회 불가" 기록은 그
 *   시점의 일시적 상태였던 것으로 정정됨, 같은 파일 헤더 정정 주석 참고). 다만 이 잡
 *   자체를 API 자동조회로 바꾸는 배선은 아직 안 함(오너 확인 후 진행 예정) — 지금은
 *   NH 4계좌와 동일하게 수동 CashEvent만 쓴다.
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
import { resolveCashAnchor, computeCashDelta, settleCash } from '../lib/cash-ledger.mjs';
import { buildCashHoldingRecord, holdingFilename } from '../lib/holdings-vault-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// 위탁·ISA·금현물·CMA(자동 알림) + 연금저축·IRP(수동 스냅샷, 2026-08-18 추가) — 6계좌
// 전부 동일 로직(resolveCashAnchor+computeCashDelta+settleCash)을 탄다.
const ALL_ACCOUNTS = [...new Set(Object.values(NH_ACCOUNT_MAP)), '연금저축', 'IRP'];

function readVaultFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const filepath = join(dir, f);
    return parseFrontmatter(readFileSync(filepath, 'utf8'));
  });
}

// 이전 실행에서 이미 써둔 예수금 파일이 있으면 그 앵커 정보를 "저장값" 폴백으로
// 읽는다 — CashEvents가 아직 하나도 없는 과도기(최초 실행 등)를 안전하게 넘기기
// 위한 안전망. 정상 가동 중엔 CashEvents가 항상 있어(자동이든 수동이든) 거의 안 쓰임.
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

  for (const account of ALL_ACCOUNTS) {
    const accountEvents = cashEvents
      .filter((c) => c.account === account)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const latestEvent = accountEvents.length > 0
      ? accountEvents[accountEvents.length - 1]
      : null;
    const anchor = resolveCashAnchor({
      stored: loadStoredAnchor(account),
      latestEvent: latestEvent ? { balance: latestEvent.balance, ts: latestEvent.ts } : null,
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

  console.log(
    `\n✅ 예수금 ${written}계좌 계산 완료 · 기준점없음 ${skippedNoAnchor}건 · 마이너스경고 ${negativeWarnings}건` +
    (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
