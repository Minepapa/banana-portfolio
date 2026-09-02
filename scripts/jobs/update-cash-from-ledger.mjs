#!/usr/bin/env node
/**
 * 예수금(현금) 잔고 계산 → State/Holdings/{계좌}-예수금.md (예수금앵커 배선 4단계)
 *
 * Facts/Ledger의 세 원장을 읽어 계좌별 실제 잔고를 계산한다:
 *   - CashEvents(예수금앵커): "이 시각에 이 계좌 잔고가 이 값이었다"는 사실 기록.
 *   - Executions(체결): 계좌는 update-holdings-from-executions.mjs가 영구기록한다
 *     (2026-08-18 확장). 매수는 현금유출(-), 매도는 현금유입(+).
 *   - Dividends(배당): 계좌는 같은 잡이 영구기록한다. 항상 현금유입(+).
 *
 * ⚠️ 범위 축소(2026-09-03, 마이그레이션 3단계) — 원래(2026-08-18 확정) 이 잡은
 * 6계좌(위탁·ISA·금현물·CMA·연금저축·IRP) 전부를 "기준점+델타" 재구성 루프로
 * 동일하게 처리했다. Strategy 문서(`Log/Strategy/2026-09-02-NH-API-우선-KIS-
 * 카카오파싱-역할축소-결정.md`)의 오너 확정 원문("예수금 앵커는 통일 루프 깸.
 * 계좌별 분기")에 따라, **API로 직접 예수금 조회가 가능한 계좌는 이 루프를
 * 아예 안 탄다** — 위탁·CMA·금현물은 `reconcile-nh-cash.mjs`(NH PLUG API),
 * IRP는 `reconcile-irp.mjs`(KIS API)가 각각 조회 즉시 State/Holdings를 직접
 * 덮어쓴다(CashEvent를 거치지 않음). 이 재구성 루프를 없앤 이유는 정확히 이
 * 프로젝트가 예수금 이중반영 실사고 2건을 겪은 지점이 "기준점+델타 재구성"
 * 방식이었기 때문(Strategy 문서 "왜" 절 참고) — API 응답 자체가 이미 "지금
 * 이 순간의 정확한 예수금"이라 그 위에 델타를 얹으면 시차 버그의 원천만 남는다.
 *
 * 이 잡은 이제 **API가 없는 2계좌(연금저축·ISA)만** 처리한다 — 둘 다 NH가
 * 아직 지원하지 않아(연금저축은 애초에 삼성증권 계좌, ISA는 NH가 API 계좌목록
 * 자체에 노출 안 함, 2026-09-03 라이브 확인) 여전히 카카오 알림(ISA는
 * nh-accounts.mjs 전체계좌번호매칭 자동 파싱)/수동 기준점(연금저축, 오너가 앱
 * 확인 후 수동 CashEvent)+델타 방식이 유일한 경로다. 이 재구성 방식 자체가
 * 잘못된 게 아니라 "API가 없을 때의 차선책"이라는 원래 설계 취지에 맞게 범위가
 * 좁혀진 것 — 기준점+델타 계산은 전체 타임스탬프 비교라 v1의 날짜절삭 버그가
 * 구조적으로 재발 불가능하다(cash-ledger.mjs 헤더 주석 참고).
 *
 * ⚠️ 알려진 한계(2026-08-22):
 * - 펀드적립(연금저축 VIP 펀드)·환전은 2026-08-22부로 계좌귀속까지 배선 완료
 *   (account-resolver.mjs FUND_PURCHASE_ACCOUNT·EXCHANGE_ACCOUNT, parse-notifications-
 *   to-vault.mjs가 파싱 시점에 바로 채움) — 아래 buildFlows가 두 원장을 읽어 델타에
 *   반영한다. 단 두 이벤트 모두 원문에 시각 정보가 없어(날짜만) 00:00:00으로 채우는
 *   한계는 남아있다(buildFlows 주석 참고, goldBuy가 이미 겪었던 것과 같은 계열).
 * - 연금저축은 자동 CashEvent가 없어 오너가 수동으로 갱신해줘야 최신 상태
 *   유지됨(매월 21일경 연봉 연동 자동입금, 알림 없음 — 정확한 금액을 추정해 자동
 *   반영하지 않는다).
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
import { resolveCashAnchor, computeCashDelta, settleCash } from '../lib/cash-ledger.mjs';
import { buildCashHoldingRecord, holdingFilename } from '../lib/holdings-vault-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// ISA(카카오 자동 알림)·연금저축(수동 스냅샷) — API 직접조회가 없는 2계좌만.
// 위탁·CMA·금현물·IRP는 2026-09-03부로 각자의 API 직접조회 잡(reconcile-nh-cash.mjs·
// reconcile-irp.mjs)이 State/Holdings를 직접 덮어써 이 재구성 루프를 안 탄다(파일
// 상단 "범위 축소" 주석 참고).
const ALL_ACCOUNTS = ['ISA', '연금저축'];

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

// 계좌별 현금흐름(체결+배당+펀드적립+환전) — legacy(마이그레이션 스냅샷) 제외: 그 시점
// 값은 이미 별도 스냅샷으로 반영돼 있어 델타로 다시 더하면 이중계상된다. 체결은
// 매수(-)/매도(+), 배당은 항상(+). 계좌가 아직 안 풀린(account:null) 레코드는 어느
// 계좌 것인지 몰라 자동으로 전부 제외된다(추정 없음 — update-holdings-from-executions.mjs가
// 풀어줄 때까지 이 잡의 계산에서는 조용히 빠짐, 다음 실행에 자연히 반영됨).
export function buildFlows(account, executions, dividends, fundPurchases, exchanges) {
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
  // 펀드적립(연금저축 VIP펀드 매수) — 계좌 귀속은 파싱 시점에 이미 확정됨(account-
  // resolver.mjs FUND_PURCHASE_ACCOUNT, 2026-08-22 배선). 적립식 매수뿐이라 항상
  // 현금유출(-)만 있다. ⚠️ 알림 원문에 매수신청일만 있고 시각이 없어(notification-
  // parsers.mjs parseFundBuy 주석) 00:00:00으로 채운다 — 같은 날 안에서 앵커보다 늦게
  // 일어난 매수면 이 flow가 앵커 이전으로 오판돼 델타에서 빠질 수 있다(goldBuy가 이미
  // 겪었던 것과 같은 계열의 한계이나, 여긴 원문 자체에 시각이 없어 코드로 더 못 고침).
  for (const f of fundPurchases) {
    if (f.legacy || f.account !== account) continue;
    const amount = f.amount ?? 0;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    flows.push({ ts: `${f.date} 00:00:00`, amount: -amount });
  }
  // 환전 — 계좌 귀속은 위탁 1:1 확정(account-resolver.mjs EXCHANGE_ACCOUNT, 2026-08-22
  // 오너 확인). 외화매수(원화→USD)는 현금유출(-), 외화매도(USD→원화)는 현금유입(+).
  // won이 파싱 실패로 null이면(원문에 원화금액 줄이 없는 변종) 건너뛴다 — usd금액에
  // 임의 환율을 가정해 원화를 역산하면 실제 체결환율과 달라 부정확해질 위험이 있어
  // 추정하지 않는다. 시각 정보 없는 한계는 펀드적립과 동일(위 주석 참고).
  for (const x of exchanges) {
    if (x.legacy || x.account !== account) continue;
    const won = x.won;
    if (!Number.isFinite(won) || won <= 0) continue;
    flows.push({ ts: `${x.date} 00:00:00`, amount: x.kind === '외화매수' ? -won : won });
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
  const fundPurchases = readVaultFiles(VAULT_PATHS.facts.ledger.fundPurchases);
  const exchanges = readVaultFiles(VAULT_PATHS.facts.ledger.exchanges);
  console.log(
    `🔎 체결 ${executions.length}건 · 배당 ${dividends.length}건 · 예수금앵커 ${cashEvents.length}건 · ` +
    `펀드적립 ${fundPurchases.length}건 · 환전 ${exchanges.length}건 로드`,
  );

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

    const flows = buildFlows(account, executions, dividends, fundPurchases, exchanges);
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
