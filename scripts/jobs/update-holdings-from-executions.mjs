#!/usr/bin/env node
/**
 * 신규 체결(카카오 파싱 + NH/KIS API 직접조회) → State/Holdings 반영 (구현계획서 Phase 8)
 *
 * Phase 2가 "계좌 귀속·보유종목갱신은 Phase 8·9 몫"이라며 의도적으로 비워둔 부분을
 * 마저 연결한다. docs/ARCHITECTURE-V2.md "체결 기록 권위 소스" 절의 원칙(State는 항상
 * 실제 체결량 그대로)을 수행하는 잡.
 *
 * 범위: Facts/Ledger/Executions 중 legacy(Phase 7 마이그레이션 스냅샷)가 아니고 아직
 * holdingsApplied 안 된 것만 대상 — legacy는 이미 그 시점 스냅샷이 State/Holdings로
 * 직접 옮겨졌으므로 체결을 다시 재생하면 이중 반영된다(제외 이유).
 *
 * ⚠️ 크로스소스 이중반영 방지(2026-09-03, code-reviewer 지적으로 발견 — 마이그레이션
 * 4단계 `reconcile-nh-executions.mjs` 리뷰 도중) — 카카오 파싱과 NH/KIS API 직접조회
 * (`reconcile-nh-executions.mjs`·`reconcile-irp-executions.mjs`)가 같은 실제 체결을
 * 각자 별도 파일로 기록할 수 있다(의도된 병행기간, `Log/Strategy/2026-09-02-NH-API-
 * 우선-KIS-카카오파싱-역할축소-결정.md` 참고 — 신규 경로가 안정화된 뒤 카카오를
 * 정리하는 5단계 전까지는 두 소스가 나란히 돈다). `findMatchingKnownExecution`이
 * legacy뿐 아니라 "이미 holdingsApplied된 다른 소스의 체결"까지 대조 대상에 넣어
 * (날짜 일단위·구분·종목명·수량 기준, legacy dedup과 동일 원칙) 같은 실제 거래가
 * applyBuy/applySell로 두 번 적용되는 걸 막는다 — 실제 라이브 Vault 데이터(2026-09-02
 * 메리츠금융지주 매도 30주, 카카오로 이미 반영됨)로 재현·검증 완료.
 *
 * ⚠️ 실행 시작 시 항상 먼저 로트 통합(consolidateLots)부터 한다 — 독립 코드리뷰
 * (oh-my-claudecode:code-reviewer) 지적, 2026-08-05: Phase 7 마이그레이션이 계좌당
 * 종목 하나에 여러 파일(예: 위탁 삼성전자 40주@50,450원 + 30주@54,700원 로트 2개)을
 * 만들어둔 경우가 있는데, 원래는 (계좌,종목)키로 Map을 만들 때 나중 로트가 앞 로트를
 * 조용히 덮어써 새 체결이 들어오면 한쪽 로트가 통째로 유실되는 심각한 버그가 있었다
 * (Phase 7 로트유실 사고와 같은 클래스가 다른 자리에서 재발). 통합 후엔 계좌당 종목
 * 하나 = 파일 하나 불변식이 항상 성립한다.
 *
 * 계좌 귀속: account-resolver.mjs — 삼성증권→연금저축·한국투자증권→IRP는 확정, NH는
 * 기존 State/Holdings 보유현황(+stockCode/ticker 일치)으로 좁힌다. 그래도 못 풀리면
 * (신규 종목 첫 매수 등) **추정하지 않고 건너뛴다** — holdingsApplied를 안 찍어서 다음
 * 실행에서 다시 시도되고(그 사이 수동으로 보유 파일을 만들어두면 풀릴 수 있음), warning
 * 으로 로그에 남는다.
 *
 * 매수: 가중평균 합침(holdings-updater.mjs applyBuy). 매도: 평단가 유지+수량비례축소,
 * 실현손익을 Facts/Ledger/Profits에 별도 기록(applySell). 매도수량이 보유수량을
 * 초과하면(데이터 불일치) 마찬가지로 추정하지 않고 건너뛴다.
 *
 * 멱등: 체결 파일의 holdingsApplied 플래그가 1차 방어, 보유 파일의 appliedDedupKeys
 * (체결 dedupKey 목록)가 2차 방어다(코드리뷰 지적, 2026-08-05) — 보유 파일 쓰기는
 * 성공했는데 그 직후 플래그 쓰기가 실패/중단되면, 다음 실행에서 같은 체결이 다시
 * 선택되지만 보유 쪽 appliedDedupKeys가 이미 그 dedupKey를 갖고 있으면 재적용 없이
 * 플래그만 (재)기록한다 — 수량이 두 번 반영되는 사고를 막는다.
 *
 * ⚠️ 범위 확장(2026-08-18, 예수금앵커 배선 — 오너 확정): 이 잡이 이미 체결마다 계좌를
 * 풀고 있으면서도(resolveExecutionAccount) 그 결과를 체결 원본(Facts/Ledger/Executions)
 * 프론트매터엔 기록하지 않았다 — holdingsApplied 플래그만 남기고 계좌는 매번 휘발됐다.
 * cash-ledger.mjs(예수금 기준점+델타 계산)가 "이 흐름이 어느 계좌 것인지"를 알아야
 * 하는데, 배당(Facts/Ledger/Dividends)은 지금까지 이걸 처리하는 잡 자체가 없었다(계좌
 * null인 채 영구 방치). 새 잡을 또 만드는 대신(같은 계좌귀속 판정을 두 잡이 따로 하면
 * 데이터가 갈릴 위험) 이 잡을 확장한다:
 *   1) 체결 처리 시 이제 account를 체결 원본 프론트매터에도 영구 기록한다(더 이상 휘발
 *      안 됨 — 계좌귀속불가로 건너뛴 체결은 그대로 account 없이 남아 다음 실행에 재시도).
 *   2) 체결 처리가 끝난 뒤(최신 보유현황 확보 후) 배당도 마저 훑어 계좌를 확정한다.
 *      resolveExecutionAccount를 그대로 재사용(stockCode 없이 호출, 종목명·acctNo 매칭은
 *      함수 내부가 판단). ⚠️ 2026-08-18 당시엔 "NH 배당 알림엔 계좌번호가 원문에 아예
 *      없다"고 판단해 acctNo 없이 호출했으나(종목명 매칭 폴백만 의존), 이건 틀린
 *      가정이었다 — 2026-08-19 오너 제보로 "2090289***2 정*호 님 계좌로" 형태의 계좌
 *      번호가 실제로 있는 걸 확인(notification-parsers.mjs parseDividend·nh-accounts.mjs
 *      extractNhAccountNo 참고). 이제 acctRaw를 채워 넘긴다 — 계좌번호로 확정되면
 *      정식명 vs 보유파일 축약명 불일치로 실패하던 이름매칭 폴백을 아예 안 거친다.
 *      배당은 보유수량·평단가에 영향이 없으므로(현금만 늘림) holdingsApplied가 아니라
 *      account 필드 자체의 유무로 멱등 판정한다(체결처럼 별도 플래그 불필요).
 *
 * 사용법:
 *   node scripts/jobs/update-holdings-from-executions.mjs            # 실제로 반영
 *   node scripts/jobs/update-holdings-from-executions.mjs --dry-run  # 계산만, 쓰기 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { resolveExecutionAccount, QUANT_TRACK_LABEL, IRP_ACCOUNT_LABEL } from '../lib/account-resolver.mjs';
import { applyBuy, applySell, consolidateLots } from '../lib/holdings-updater.mjs';
import { writeHoldingSafely, holdingFilename, parseAppliedDedupKeys } from '../lib/holdings-vault-writer.mjs';
import { buildProfitRecord } from '../lib/ledger-vault-writer.mjs';
import { fetchUsdKrwRate } from '../lib/fundamentals.mjs';
// 그래프 뷰 다중축 태그(2026-09-05) — 계좌 지연귀속 지점마다 태그도 같이 재계산해야
// 한다(2026-09-05 코드리뷰 HIGH 지적 — account:null로 쓰여진 뒤 여기서 나중에 채워지는
// 레코드가, 쓰기 시점 스냅샷인 tags를 그대로 두면 계좌 축이 영구히 빠진 채 남는다).
import { buildVaultTags } from '../lib/vault-tags.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

function readVaultFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const filepath = join(dir, f);
    const content = readFileSync(filepath, 'utf8');
    return { filepath, content, parsed: parseFrontmatter(content) };
  });
}

export function pickUnprocessedExecutions(executionFiles) {
  return executionFiles
    .filter(({ parsed }) => !parsed.legacy && !parsed.holdingsApplied)
    .sort((a, b) => String(a.parsed.tradeDate).localeCompare(String(b.parsed.tradeDate))
      || String(a.parsed.recordedAt).localeCompare(String(b.parsed.recordedAt)));
}

// ⚠️ 실사고 수정(2026-08-18) — "알람" 시트가 이미 "체결내역" 시트로 넘어간 옛 행을
// 그대로 갖고 있어서(v1이 알람→체결내역 처리 후 알람 행을 안 지움), v1→v2 마이그레이션
// (체결내역 기준 스냅샷)이 이미 반영한 체결을 카카오 파이프라인이 나중에 "새 체결"로
// 다시 발견해 applyBuy/applySell로 재적용하는 사고가 실제로 났다(실측 52건, 보유종목
// 12개·실현손익 6건 오염 — Aug-17 실행분 vault 백업 git 이력으로 대조·복구 완료).
// 날짜(일단위)·구분·종목명·수량이 legacy 레코드와 같으면 "이미 반영된 사건"으로 보고
// holdingsApplied만 찍고 실제 적용(applyBuy/applySell)은 건너뛴다.
//
// ⚠️ 버그 수정(2026-08-18, 재활성화 직후 오너가 보내준 실제 앱 스크린샷 대조로 발견) —
// 처음엔 단가(price)까지 완전일치를 요구했는데, 해외주식은 legacy(마이그레이션, v1
// "체결내역" 시트 — 원화환산가 저장)와 live(카카오 알림 재파싱 — 원문 USD 단가 그대로
// 저장) 사이에 통화 자체가 달라(예: 마이크로소프트 2026-05-12 매수 2주가 legacy엔
// price:585919(원), live엔 price:410.565(달러)) 숫자가 절대 같아질 수 없다 — 그래서
// 이 조건 때문에 해외주식 중복 7건이 전부 탐지를 피해 그대로 재적용됐다(마이크로소프트
// +2·알파벳 Class A +8·엔비디아 +5주, 실제 앱 잔고와 다름을 오너 스크린샷으로 확인).
// 단가 비교를 뺀다 — 날짜(초단위 포함)·구분·종목명·수량이 같은 두 개의 서로 다른
// 진짜 거래가 우연히 존재할 확률은 무시할 수준이고(이 프로젝트 자체의 dedupKey 관례
// — ledger-vault-writer.mjs buildExecutionRecord — 도 애초에 단가 없이 이 넷만으로
// 유일성을 정의한다, 여기서도 그 관례를 그대로 따르는 게 맞다).
// matchesKnownExecution의 실제 매치 레코드 버전(불리언 대신 레코드 자체 반환) — 매치된
// 쪽에만 남아있는 정보(예: account, v1 마이그레이션 시점엔 알던 계좌)를 재사용하기 위해
// 2026-08-19 추가(아래 findLegacyAccountFallback 참고). 판정 조건은 matchesKnownExecution
// 과 완전히 동일 — 둘이 서로 다른 기준으로 갈리면 "중복으로는 잡았는데 계좌는 못 씀" 같은
// 불일치가 생기므로 하나만 정의하고 matchesKnownExecution이 이걸 재사용한다.
//
// ⚠️ 개명(2026-09-03, "Legacy"→"Known") — 원래는 v1 마이그레이션 스냅샷(legacy)과만
// 대조했다. code-reviewer 지적으로 발견: 카카오 파싱과 reconcile-nh-executions.mjs
// (NH API 직접조회, 위탁·금현물 체결을 API로 직접 폴링)가 같은 실제 체결을 각자 별도
// 파일로 기록할 수 있는데(마이그레이션 병행기간 중 의도된 상황, Strategy 문서 참고),
// legacy만 보던 이전 로직은 이 크로스소스 중복을 못 잡아 같은 체결이 applyBuy/applySell
// 로 두 번 적용될 뻔했다(실제 라이브 Vault 데이터로 재현 확인 — 2026-08-18 legacy
// 중복 실사고와 동일 클래스). 판정 기준(날짜 일단위·구분·종목명·수량, 단가·정확한
// 시각은 소스마다 표현이 달라 비교 안 함) 자체는 "legacy 여부"와 무관하게 "같은 실제
// 거래를 가리키는가"를 정확히 판별하므로, 함수 이름과 인자 의미를 legacy 전용에서
// "이미 알려진(= legacy 스냅샷이거나 다른 소스가 이미 holdingsApplied 처리한) 체결
// 전체"로 넓힌다 — 함수 로직 자체는 무변경, 호출부가 넘기는 배열 구성만 넓어진다
// (main()의 knownExecutions 참고).
export function findMatchingKnownExecution(exec, knownExecutions) {
  const matches = knownExecutions.filter((g) =>
    String(g.tradeDate).slice(0, 10) === String(exec.tradeDate).slice(0, 10) &&
    g.tradeType === exec.tradeType && g.stockName === exec.stockName &&
    g.quantity === exec.quantity,
  );
  if (!matches.length) return null;
  // 후보가 여럿인데 계좌가 서로 갈리면(같은 날 같은 종목·구분·수량을 다른 계좌로 거래한
  // 우연 — 이론상 가능) 어느 쪽 계좌인지 추정하지 않는다(코드리뷰 지적, 2026-08-19 —
  // 이 프로젝트의 "추정하지 않는다" 원칙과 일관되게 방어). account만 null로 낮추고
  // 레코드 자체는 반환 — "이 이벤트가 이미 알려진 체결과 중복"이라는 dedup 판정
  // (matchesKnownExecution)은 계좌 모호성과 무관하게 여전히 유효해야 하므로.
  const accounts = new Set(matches.map((m) => m.account));
  if (accounts.size > 1) return { ...matches[0], account: null };
  return matches[0];
}

export function matchesKnownExecution(exec, knownExecutions) {
  return findMatchingKnownExecution(exec, knownExecutions) != null;
}

// 배당은 holdingsApplied 플래그가 없다(보유수량에 영향 없음) — account 필드 유무로
// 멱등 판정. legacy(Phase 7 마이그레이션)는 account:null로 영구 고정된 스냅샷이라
// 대상에서 제외(계좌귀속판정 대상이 아니라 이력 그대로 보존하는 레코드).
export function pickUnprocessedDividends(dividendFiles) {
  return dividendFiles
    .filter(({ parsed }) => !parsed.legacy && !parsed.account)
    .sort((a, b) => String(a.parsed.date).localeCompare(String(b.parsed.date))
      || String(a.parsed.recordedAt).localeCompare(String(b.parsed.recordedAt)));
}

// 일회성 소급 백필 대상 — 2026-08-18 이전에(이 잡이 account를 원본에 영구기록하기
// 시작하기 전) 이미 holdingsApplied:true로 처리된 체결은 pickUnprocessedExecutions의
// !holdingsApplied 조건에 걸려 영원히 재방문되지 않는다(실측: 실계좌 84건 중 60건이
// 이 상태). 보유수량엔 이미 정확히 반영돼 있으니 재적용은 불필요 — account 필드만
// 뒤늦게 채워 넣는다(cash-ledger.mjs가 이 필드로 흐름을 계좌별로 가른다).
export function pickAccountlessAppliedExecutions(executionFiles) {
  return executionFiles.filter(({ parsed }) => !parsed.legacy && parsed.holdingsApplied && !parsed.account);
}

// ⚠️ writeHoldingSafely로 전환(2026-09-04, State/Holdings 동시쓰기 경합 방지 — 남은
// 것 목록의 후속과제) — update-holdings-prices.mjs(같은 파일에 curPrice 등을 쓰는
// 다른 잡)가 이 잡의 체결 처리 도중 같은 보유 파일을 갱신하면, 예전(bare writeAtomic
// + buildLiveHoldingRecord 전체재작성) 방식은 그 갱신을 조용히 되돌릴 수 있었다.
async function writeHolding(holding) {
  if (!DRY_RUN) await writeHoldingSafely(holding);
}

// 계좌당 종목 하나 = 파일 하나로 수렴시킨다. 여러 로트가 있던 항목은 통합 결과를 쓰고
// 남는 로트 파일을 지운다(전부 --dry-run이면 계산만, 쓰기 없음). 반환: account|name →
// holding(+appliedDedupKeys 배열) Map.
//
// ⚠️ 버그 수정(2026-08-13, 실사고로 발견) — 예전엔 `group.length > 1`일 때만 정식
// 파일명(holdingFilename)으로 다시 쓰고 나머지를 지웠다. 그런데 로트가 원래 1개뿐이던
// 종목(Phase 7 마이그레이션이 남긴 `{계좌}-{종목}-r{행번호}.md` 파일)은 이 조건을 안 타
// 옛 파일명 그대로 방치됐다 — 그 종목이 "처음 신규 체결"을 받는 순간, writeHolding이
// 정식 파일명으로 새로 쓰지만 옛 파일은 안 지워져 같은 종목이 두 파일로 이중 집계되는
// 사고가 실제로 났다(ISA TIGER 리츠부동산인프라, 1450주짜리 구파일이 1480주짜리 새
// 파일과 나란히 남음). 이제 로트 개수와 무관하게 "이 파일 경로가 정식 파일명과 다르면"
// 무조건 정리한다 — 다음 잡 실행 때 아직 안 건드려진 나머지 레거시 파일명도 전부
// 자연히 정규화된다(에러 없이 조용히 발생하던 종류의 버그라 여기서 한 번에 청소).
async function loadConsolidatedHoldings() {
  const files = readVaultFiles(VAULT_PATHS.state.holdings);
  const groups = new Map();
  for (const f of files) {
    const key = `${f.parsed.account}|${f.parsed.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const holdingsMap = new Map();
  for (const [key, group] of groups) {
    const merged = consolidateLots(group.map((f) => f.parsed));
    const survivingFilename = join(VAULT_PATHS.state.holdings, holdingFilename(merged.account, merged.name));
    const needsRewrite = group.length > 1 || group[0].filepath !== survivingFilename;
    if (needsRewrite) {
      if (group.length > 1) console.log(`  🔀 로트 통합: ${key} (${group.length}개 파일 → 1개, 합산 ${merged.qty}주)`);
      else console.log(`  📝 파일명 정규화(레거시 잔재 정리): ${key}`);
      await writeHolding(merged);
      for (const f of group) {
        if (f.filepath !== survivingFilename && !DRY_RUN) rmSync(f.filepath, { force: true });
      }
    }
    holdingsMap.set(key, { ...merged, appliedDedupKeys: parseAppliedDedupKeys(merged) });
  }
  return holdingsMap;
}

async function main() {
  const executionFiles = readVaultFiles(VAULT_PATHS.facts.ledger.executions);
  const legacyExecutions = executionFiles.filter(({ parsed }) => parsed.legacy).map(({ parsed }) => parsed);
  // ⚠️ 크로스소스 이중반영 방지(2026-09-03, code-reviewer 지적으로 발견 — findMatching
  // KnownExecution 헤더 주석 참고) — legacy뿐 아니라 이미 holdingsApplied된 다른 소스의
  // 체결도 dedup 대조 대상에 넣는다. mutable — 이 루프가 새로 적용/스킵 판정한 체결도
  // 그때그때 이 배열에 추가해, 카카오·NH API 두 소스의 같은 체결이 "같은 실행" 안에서
  // 나란히 들어와도(둘 다 오늘 막 파싱된 경우) 서로를 잡아낸다.
  const knownExecutions = [
    ...legacyExecutions,
    ...executionFiles.filter(({ parsed }) => !parsed.legacy && parsed.holdingsApplied).map(({ parsed }) => parsed),
  ];
  const targets = pickUnprocessedExecutions(executionFiles);
  console.log(`🔎 미처리 체결 ${targets.length}건 (전체 ${executionFiles.length}건 중)`);

  // ⚠️ 버그 수정(2026-09-04) — applyBuy/applySell가 USD 체결의 invest·실현손익을
  // KRW로 환산하려면 환율이 필요하다(update-holdings-prices.mjs와 동일 패턴). USD
  // 체결 대상이 있을 때만 조회 — 실패해도 잡 전체를 죽이지 않고, 대상 체결만
  // applyBuy/applySell의 warning 경로로 건너뛴다(다음 실행 때 재시도).
  let usdKrwRate = null;
  if (targets.some(({ parsed }) => parsed.currency === 'USD')) {
    try {
      usdKrwRate = fetchUsdKrwRate();
      console.log(`   💱 USD/KRW ${usdKrwRate.toFixed(2)}`);
    } catch (e) {
      console.log(`  ⚠️  USD/KRW 환율 조회 실패 — USD 체결은 이번엔 건너뜀: ${e.message}`);
    }
  }

  const holdingsMap = await loadConsolidatedHoldings();

  let buys = 0, sells = 0, closed = 0, unresolvedAccount = 0, warnings = 0, alreadyApplied = 0, duplicateOfKnown = 0, totalRealizedProfit = 0;

  // ⚠️ 버그 수정(2026-08-18, 독립 코드리뷰 HIGH 지적) — 예전엔 targets가 비면 여기서
  // 바로 return해 아래 배당 계좌귀속 패스까지 통째로 건너뛰었다. 이 잡은 launchd
  // 고정시각 잡이라(체결 발생 시점이 아니라 매일 16:05) "처리할 체결 없음"이 오히려
  // 평상시 기본 상태 — 그 상태에서 배당 패스가 매번 무력화되면 실사용에서 사실상 죽은
  // 코드가 된다(드라이런 검증 때 마침 미처리 체결이 같이 있어서 못 잡을 뻔함). 체결
  // 루프만 이 조건으로 감싸고, 배당 패스는 항상 이어서 실행되게 한다.
  if (targets.length === 0) console.log('처리할 체결 없음 — 배당 계좌귀속으로 진행.');
  for (const { filepath, content, parsed: exec } of targets) {
    const currentHoldings = [...holdingsMap.values()];
    const knownMatch = findMatchingKnownExecution(exec, knownExecutions);
    // ⚠️ 버그 수정(2026-08-19, 오너 지시 "체결도 매핑 가능하면 매핑해봐") — 전량청산돼
    // 지금은 보유 파일 자체가 없는 종목(예: 삼성바이오로직스·현대차 매도)은 acctNo도
    // 없고(NH 체결 원문엔 애초에 계좌번호가 없음) 이름매칭도 대조할 보유 파일이 없어
    // 영구히 계좌귀속불가였다. 그런데 이 사건이 knownMatch로 잡히면(날짜·구분·종목명·
    // 수량 일치 — matchesKnownExecution과 동일 기준) legacy 스냅샷이나 다른 소스가 이미
    // 그 계좌를 알고 있다(knownMatch.account) — 굳이 다시 추정하지 않고 그 값을 그대로
    // 재사용한다(추정이 아니라 기존에 이미 확정됐던 사실 재사용).
    const account = exec.account
      || resolveExecutionAccount({ broker: exec.broker, stockName: exec.stockName, stockCode: exec.stockCode, acctNo: exec.acctNo }, currentHoldings)
      || knownMatch?.account || null;
    if (!account) {
      console.log(`  ⚠️  계좌 귀속 불가 — 건너뜀: ${exec.tradeDate} ${exec.tradeType} ${exec.stockName} (${exec.broker})`);
      unresolvedAccount++;
      continue;
    }
    if (knownMatch) {
      console.log(`  ↩️  이미 알려진 체결과 중복(마이그레이션 스냅샷 또는 다른 소스에서 이미 반영됨) — 적용 없이 플래그만 기록: ${exec.tradeDate} ${exec.tradeType} ${exec.stockName}`);
      duplicateOfKnown++;
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: exec.stockName }), holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      knownExecutions.push({ ...exec, account });
      continue;
    }
    // ⚠️ 버그 수정(2026-08-13, 독립 코드리뷰 HIGH 지적) — 퀀트 트랙 체결(exec.account가
    // 이미 '퀀트'로 채워진 채 들어옴, watch-order-fill.mjs 참고)은 `exec.account ||
    // resolveExecutionAccount(...)`에서 이미 참(truthy)이라 resolveExecutionAccount의
    // "퀀트는 null" 가드를 그대로 건너뛰고 여기까지 도달해버렸다 — 고치기 전엔 이
    // 잡이 State/Holdings에 퀀트 포지션을 실제로 써서(자산분배·퀀트 계좌 분리 원칙 위반)
    // Firestore 미러·대시보드에도 퀀트 보유가 섞여 나갈 뻔했다. 퀀트는 KIS API가
    // 정본이라(Phase 9 확정) 여기서 명시적으로 건너뛴다 — holdingsApplied만 찍어
    // 재처리 대상에서 빠지게 한다(Holdings에는 안 씀).
    if (account === QUANT_TRACK_LABEL) {
      console.log(`  ↪️  퀀트 트랙 체결 — State/Holdings 반영 대상 아님(KIS API가 정본): ${exec.stockName}`);
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: exec.stockName }), holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      knownExecutions.push({ ...exec, account });
      continue;
    }
    // IRP 체결 — 2026-09-04부터 보유수량·평단가는 State/Holdings에 반영 대상 아님(KIS
    // API가 정본, 퀀트와 동일 원칙). reconcile-irp.mjs가 10분마다 KIS 잔고조회로
    // 수량+평단가+원가를 직접 덮어쓴다(parseBalanceResponse가 pchs_avg_pric·pchs_amt
    // 까지 실측 확인, kis.mjs 헤더 주석 참고) — 카카오 체결누적은 이제 이 계좌 보유
    // 수량엔 안 쓴다.
    //
    // ⚠️ 단, 매도 실현손익은 예외(코드리뷰 HIGH 지적, 2026-09-04) — KIS 잔고조회
    // API는 "현재 스냅샷"만 주지 다음 시점의 스냅샷이 자체적으로 판매손익을 알려주지
    // 않는다(과거 특정 매도 건의 체결가를 되짚을 방법이 없음). 퀀트는 애초에 Vault에
    // 원가를 가진 적이 없어 이 문제가 없었지만, IRP는 있었다 — 그래서 매도 체결만
    // applySell로 실현손익을 계산해 Facts/Ledger/Profits에 기록한다(weekly-report.mjs가
    // 이 원장을 읽으므로, 안 하면 오너 보고 실현손익이 조용히 누락된다). 단
    // holdingsMap·State/Holdings는 건드리지 않는다(qty/avgPrice 갱신은 여전히
    // reconcile-irp.mjs 몫) — existingHolding은 "계산용 기준"으로만 쓰고 결과의
    // updatedHolding은 버린다. 매수 체결은 실현손익이 없어 여전히 완전 스킵.
    if (account === IRP_ACCOUNT_LABEL) {
      if (exec.tradeType === '매도') {
        const irpKey = `${account}|${exec.stockName}`;
        const irpExisting = holdingsMap.get(irpKey) ?? null;
        const sellResult = applySell(irpExisting, { ...exec, account }, { usdKrwRate });
        if (sellResult.warning) {
          console.log(`  ⚠️  IRP 매도 실현손익 계산 실패 — ${sellResult.warning} — 건너뜀`);
          warnings++;
        } else {
          console.log(`  - [매도] IRP ${exec.stockName} ${exec.quantity}주 @${exec.price} → 실현손익 ${Math.round(sellResult.realizedProfit).toLocaleString()}원(보유수량 갱신은 KIS 잔고조회가 담당)`);
          totalRealizedProfit += sellResult.realizedProfit;
          if (!DRY_RUN) {
            const { filename: pFilename, content: pContent, dir: pDir } = buildProfitRecord({ ...exec, account }, irpExisting.avgPrice, sellResult.realizedProfit, exec.currency === 'USD' ? usdKrwRate : 1);
            mkdirSync(pDir, { recursive: true });
            writeAtomic(join(pDir, pFilename), pContent);
          }
          sells++;
        }
      } else {
        console.log(`  ↪️  IRP 매수 체결 — State/Holdings 반영 대상 아님(KIS API가 정본): ${exec.stockName}`);
      }
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: exec.stockName }), holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      knownExecutions.push({ ...exec, account });
      continue;
    }

    const key = `${account}|${exec.stockName}`;
    const existing = holdingsMap.get(key) ?? null;
    const execWithAccount = { ...exec, account };

    // 2차 방어: 이 체결이 이미 이 보유에 반영된 적 있으면(플래그 기록이 중간에 실패했던
    // 경우) 재적용하지 않고 플래그만 다시 찍는다.
    if (existing?.appliedDedupKeys?.includes(exec.dedupKey)) {
      console.log(`  ↩️  이미 반영된 체결(재시도) — 재적용 없이 플래그만 기록: ${exec.stockName}`);
      alreadyApplied++;
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: exec.stockName }), holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
      knownExecutions.push({ ...exec, account });
      continue;
    }

    if (exec.tradeType === '매수') {
      const buyResult = applyBuy(existing, execWithAccount, { usdKrwRate });
      if (buyResult.warning) {
        console.log(`  ⚠️  ${buyResult.warning} — 건너뜀`);
        warnings++;
        continue;
      }
      const updated = { ...buyResult.holding, appliedDedupKeys: [...(existing?.appliedDedupKeys ?? []), exec.dedupKey] };
      console.log(`  + [매수] ${account} ${exec.stockName} ${exec.quantity}주 @${exec.price} → 보유 ${updated.qty}주(평단 ${Math.round(updated.avgPrice)})`);
      await writeHolding(updated);
      holdingsMap.set(key, updated);
      buys++;
    } else if (exec.tradeType === '매도') {
      const result = applySell(existing, execWithAccount, { usdKrwRate });
      if (result.warning) {
        console.log(`  ⚠️  ${result.warning} — 건너뜀`);
        warnings++;
        continue;
      }
      console.log(`  - [매도] ${account} ${exec.stockName} ${exec.quantity}주 @${exec.price} → 실현손익 ${Math.round(result.realizedProfit).toLocaleString()}원${result.closed ? ' (전량청산)' : ''}`);
      totalRealizedProfit += result.realizedProfit;
      if (!DRY_RUN) {
        const { filename: pFilename, content: pContent, dir: pDir } = buildProfitRecord(execWithAccount, existing.avgPrice, result.realizedProfit, exec.currency === 'USD' ? usdKrwRate : 1);
        mkdirSync(pDir, { recursive: true });
        writeAtomic(join(pDir, pFilename), pContent);
      }
      if (result.closed) {
        if (!DRY_RUN) rmSync(join(VAULT_PATHS.state.holdings, holdingFilename(account, exec.stockName)), { force: true });
        holdingsMap.delete(key);
        closed++;
      } else {
        const updated = { ...result.updatedHolding, appliedDedupKeys: [...(existing?.appliedDedupKeys ?? []), exec.dedupKey] };
        await writeHolding(updated);
        holdingsMap.set(key, updated);
      }
      sells++;
    } else {
      console.log(`  ⚠️  알 수 없는 tradeType(${exec.tradeType}) — 건너뜀`);
      continue;
    }

    if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, holdingsApplied: true, holdingsAppliedAt: new Date().toISOString() }));
    knownExecutions.push(execWithAccount);
  }

  console.log(
    `\n📊 매수 ${buys}건 · 매도 ${sells}건(전량청산 ${closed}건, 실현손익 합계 ${Math.round(totalRealizedProfit).toLocaleString()}원) · ` +
    `계좌귀속불가 ${unresolvedAccount}건 · 경고스킵 ${warnings}건 · 재시도(이미반영) ${alreadyApplied}건 · 기존체결중복(적용스킵) ${duplicateOfKnown}건` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );

  // 체결 계좌귀속 소급 백필 — 2026-08-18 이전에 이미 holdingsApplied:true로 처리된
  // 체결(실측 84건 중 60건)은 위 메인 루프의 !holdingsApplied 조건에 걸려 다시 안
  // 지나간다. 보유수량은 이미 정확하니 재적용 없이 account만 채운다.
  const backfillTargets = pickAccountlessAppliedExecutions(executionFiles);
  let backfillResolved = 0, backfillUnresolved = 0;
  if (backfillTargets.length > 0) {
    console.log(`\n🔎 체결 계좌귀속 소급백필 대상 ${backfillTargets.length}건`);
    const currentHoldings = [...holdingsMap.values()];
    for (const { filepath, content, parsed: exec } of backfillTargets) {
      // 메인 루프와 동일하게 legacyMatch.account를 마지막 폴백으로 쓴다(2026-08-19,
      // 전량청산돼 보유 파일이 없는 종목의 소급백필도 구제). 이미 holdingsApplied된
      // 레코드의 account만 채우는 단계라(수량 재적용 없음) knownExecutions로 넓힐
      // 필요는 없다 — legacy 스냅샷만으로 충분(findMatchingKnownExecution 자체는
      // 2026-09-03 개명, 동작은 무변경).
      const legacyMatch = findMatchingKnownExecution(exec, legacyExecutions);
      const account = resolveExecutionAccount({ broker: exec.broker, stockName: exec.stockName, stockCode: exec.stockCode, acctNo: exec.acctNo }, currentHoldings)
        || legacyMatch?.account || null;
      if (!account) {
        console.log(`  ⚠️  소급백필 계좌귀속 불가 — 건너뜀: ${exec.tradeDate} ${exec.tradeType} ${exec.stockName} (${exec.broker})`);
        backfillUnresolved++;
        continue;
      }
      console.log(`  + [소급백필] ${exec.tradeDate} ${exec.tradeType} ${exec.stockName} → ${account}`);
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: exec.stockName }) }));
      backfillResolved++;
    }
    console.log(`📊 소급백필 완료 ${backfillResolved}건 · 계좌귀속불가 ${backfillUnresolved}건` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
  }

  // 배당 계좌귀속 — 체결 처리로 최신화된 holdingsMap을 그대로 재사용(같은 실행 내
  // 새로 반영된 보유도 후보좁히기에 즉시 반영되게). 위 로직과 별개 루프인 이유:
  // 배당은 보유수량에 영향이 없어 매수/매도 분기(applyBuy/applySell)를 탈 필요가
  // 없고, 계좌만 확정해 기록하면 끝이다(cash-ledger.mjs가 이후 소비).
  //
  // ⚠️ 코드리뷰 확인(2026-08-18) — resolveExecutionAccount의 NH 후보좁히기는 ISA·위탁
  // 둘만 본다(금현물·CMA 제외). 이름만으로 판정하는 경로라 "같은 이름·다른 계좌"
  // 오귀속 위험 클래스(ISA/금현물 마스킹계좌 접두사 충돌과 동일 계열)가 이론상 있는지
  // 점검했다 — 구조적으로 불가능: 금현물은 금 실물만 보유(배당 없음), CMA는 순수
  // 현금 경유지(증권 보유 자체가 없음, 2026-08-18 오너 확정). 둘 다 배당을 낼 종목을
  // 보유할 수 없으니 후보에서 빠져도 안전. 이 불변식이 깨지면(예: 금현물 계좌로 실제
  // 배당지급 증권을 사게 되면) 후보 목록도 같이 넓혀야 한다.
  const dividendFiles = readVaultFiles(VAULT_PATHS.facts.ledger.dividends);
  const divTargets = pickUnprocessedDividends(dividendFiles);
  let divResolved = 0, divUnresolved = 0;
  if (divTargets.length > 0) {
    console.log(`\n🔎 배당 계좌귀속 미처리 ${divTargets.length}건 (전체 ${dividendFiles.length}건 중)`);
    const currentHoldings = [...holdingsMap.values()];
    for (const { filepath, content, parsed: div } of divTargets) {
      // ⚠️ 2026-08-19 버그 수정 — "NH 배당 알림엔 계좌번호가 없다"는 이전 가정이 틀렸다
      // (오너 제보로 발견: "2090289***2 정*호 님 계좌로" 형태로 실제론 있었는데
      // notification-parsers.mjs가 그 형식을 못 잡고 있었음, nh-accounts.mjs
      // extractNhAccountNo 참고). 이제 acctRaw가 채워지므로 넘겨준다 — 계좌번호가
      // 잡히면 resolveExecutionAccount가 종목명 매칭(정식명 vs 보유파일 축약명 불일치로
      // 실패할 수 있음)보다 우선해서 바로 확정한다.
      const account = resolveExecutionAccount({ broker: div.broker, stockName: div.stockName, acctNo: div.acctRaw || undefined }, currentHoldings);
      if (!account) {
        console.log(`  ⚠️  배당 계좌 귀속 불가 — 건너뜀: ${div.date} ${div.stockName} (${div.broker})`);
        divUnresolved++;
        continue;
      }
      console.log(`  + [배당] ${div.date} ${div.stockName} → ${account}`);
      if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { account, tags: buildVaultTags({ account, stockName: div.stockName }) }));
      divResolved++;
    }
    console.log(`📊 배당 계좌귀속 완료 ${divResolved}건 · 계좌귀속불가 ${divUnresolved}건` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
