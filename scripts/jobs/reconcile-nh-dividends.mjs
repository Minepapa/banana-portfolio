#!/usr/bin/env node
/**
 * NH PLUG 종합거래내역 API로 배당/분배금을 조회해 카카오 알림 파싱 기반
 * Facts/Ledger/Dividends와 대조 — 읽기 전용 진단(Vault·시트 쓰기 없음, 단
 * 불일치 발견 시 job-alerts.mjs를 통해 텔레그램 경고는 발송됨).
 *
 * 왜: 2026-09-19 오너 요청으로 NH PLUG 신규 API(공통_계좌_조회_종합거래내역)를
 * 라이브 검증 — 위탁 계좌 배당/분배금이 이 API로 정확히 잡힘을 확인
 * (scripts/lib/nhplug-common.mjs 신설). 지금까지 배당의 유일한 소스는 카카오
 * 알림 파싱(notification-parsers.mjs parseDividend)뿐이라, 알림이 유실되면
 * (수신 실패·파싱 실패 등) 조용히 배당이 누락될 위험이 있었다.
 *
 * 이 잡은 그 공백을 "자동으로 메우는" 게 아니라 "드러내는" 역할만 한다 — NH
 * API 응답엔 Vault의 dedupKey(uniqueKey)에 대응하는 안정적 식별자가 없어
 * (date+stockName+amount로만 근사 매칭 가능), 자동으로 Facts/Ledger/Dividends에
 * 써넣으면 매칭 오류 시 배당이 중복 기록될 위험이 있다. 그래서 불일치를
 * 콘솔·경고로만 보고하고, 실제 기록은 여전히 카카오 파싱 경로가 전담한다
 * (오너가 불일치를 보고 수동 보정 여부를 판단).
 *
 * ⚠️ 종목명 매칭 실사고(2026-09-19 코드리뷰 HIGH, 첫 실행에서 실제로 재현) —
 * 최초 구현은 `includes()` 양방향 부분일치였는데, Vault의 실제 카카오 표기
 * "에스케이하이닉스보통주"와 NH API의 "SK하이닉스"가 서로 부분포함 관계가
 * 아니라서 실제로 있는 배당을 "누락"으로 오탐, 그 오탐이 텔레그램으로 이미
 * 발송됐다. stock-registry.mjs의 resolveCanonicalStockName(이 프로젝트가 종목명
 * 표기 파편화에 이미 쓰고 있는 표준 해법, weekly-report.mjs 등에서도 사용)으로
 * 양쪽을 정규화한 뒤 비교하도록 수정.
 *
 * 스코프: NH_CASH_ACCOUNTS(위탁·CMA·금현물, scripts/lib/nh-accounts.mjs) —
 * reconcile-nh-cash.mjs와 동일, ISA는 이 API 자체가 계좌를 안 돌려줘 스코프 밖
 * ([[project-isa-cash-anchor-dividend-gap]] 2026-09-19 업데이트 참고).
 *
 * 사용법:
 *   node scripts/jobs/reconcile-nh-dividends.mjs               # 최근 90일
 *   node scripts/jobs/reconcile-nh-dividends.mjs --days=180     # 기간 조정
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNhplugCredentials, loadNhplugCredentials, getNhToken, listNhAccounts } from '../lib/nhplug.mjs';
import { getTotalTransaction, filterDividendRows } from '../lib/nhplug-common.mjs';
import { resolveNhAccountsByLabel, NH_CASH_ACCOUNTS } from '../lib/nh-accounts.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { resolveCanonicalStockName } from '../lib/stock-registry.mjs';

const args = process.argv.slice(2);
const daysArg = args.find((a) => a.startsWith('--days='));
const rawDays = daysArg ? Number(daysArg.split('=')[1]) : 90;
if (!Number.isFinite(rawDays) || rawDays <= 0) {
  console.error(`❌ --days 값이 올바르지 않음: ${daysArg ?? '(없음)'}`);
  process.exit(1);
}
const DAYS = rawDays;

// KST 기준 YYYYMMDD — reconcile-nh-cash.mjs kstNow()·order-gate.mjs와 동일 관례.
// new Date().toISOString()(UTC)을 쓰면 KST 00:00~08:59엔 하루 어긋나 당일 배당이
// 조회범위에서 빠진다(2026-09-19 코드리뷰 MEDIUM 지적 — 실측: KST 00:30 실행 시
// UTC 기준 전날짜가 iqr_end_dt로 들어감).
function ymdKst(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) =>
    parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// NH API의 trd_dt(YYYYMMDD)와 Vault dividend 레코드의 date(YYYY-MM-DD)를 같은 형식으로.
// trd_dt가 없거나 형식이 이상해도(2026-09-19 코드리뷰 MEDIUM — 없는 행에서 TypeError로
// 잡 전체가 죽었었음) 크래시 없이 null 반환.
function normDate(ymdCompact) {
  const s = String(ymdCompact ?? '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ⚠️ 금액은 매칭 조건에 안 쓴다(2026-09-19 실측 발견, 최초 구현은 ±1 오차만 허용했다가
// 자체 재현으로 뒤집음) — NH API trd_amt(종합거래내역)는 세전 총액인데 Vault의
// afterTaxAmount는 카카오 "세후금액" 파싱값이라 원천적으로 다른 숫자다. 실측 3건
// (삼성전자 12670/14960·TIGER리츠TOP10 16000/18900·PLUS고배당주 6110/7210)의 비율이
// 전부 ~84.6%로 일관돼(1-15.4% 국내 배당소득세 원천징수율과 일치) 데이터 오류가
// 아니라 세전/세후 차이임을 확인했다. 금액을 매칭 게이트로 쓰면 진짜 일치를 "누락"
// 으로 오탐한다 — 대신 두 금액을 나란히 보여줘서 오너가 직접 판단하게 한다.
//
// 같은 (계좌,날짜,정규화종목명)에 NH 쪽 배당이 여러 건이거나 Vault 쪽이 여러 건이면
// 1:1로 소비해야 한다 — 그렇지 않으면 Vault 1건이 NH 여러 건에 동시 매칭돼 실제
// 누락을 놓친다(2026-09-19 코드리뷰 MEDIUM). consumed는 이미 매칭에 쓰인 Vault
// 레코드를 걸러내는 Set(레코드 자체를 키로 — 배열 인덱스보다 참조가 안전).
function findVaultMatch(nhRow, vaultDividends, label, consumed) {
  const nhDate = normDate(nhRow.trd_dt);
  if (!nhDate) return { record: null, reason: 'nh-date-invalid' };
  const nhNameRaw = String(nhRow.iem_nm || '').trim();
  if (nhNameRaw === '') return { record: null, reason: 'nh-name-empty' }; // 2026-09-19 코드리뷰 MEDIUM — 이름 없으면 그 날짜 아무 배당에나 매칭되던 버그, "판정 불가"로 분리
  const nhName = resolveCanonicalStockName(nhNameRaw);

  const record = vaultDividends.find((v) => {
    if (consumed.has(v)) return false;
    if (v.date !== nhDate) return false;
    if (v.account && v.account !== label) return false; // 계좌 필드가 백필돼 있으면 계좌 간 교차오매칭 방지
    return resolveCanonicalStockName(String(v.stockName || '')) === nhName;
  });
  if (record) consumed.add(record);
  return { record: record || null, reason: record ? 'matched' : 'no-match' };
}

async function main() {
  if (!hasNhplugCredentials()) {
    console.log('ℹ️ NH PLUG 크리덴셜 미설정 — 스킵');
    return;
  }

  const { appkey, appsecret } = loadNhplugCredentials();
  const token = await getNhToken({ appkey, appsecret });
  const accounts = await listNhAccounts({ token });
  const byLabel = resolveNhAccountsByLabel(accounts, NH_CASH_ACCOUNTS);

  // reconcile-nh-cash.mjs와 동일 가드(2026-09-19 코드리뷰 MEDIUM) — 매핑 실패 계좌를
  // 조용히 건너뛰면 스코프가 줄어든 채 "미매칭 0건 ✅"을 낼 수 있다.
  for (const label of NH_CASH_ACCOUNTS) {
    if (!byLabel.has(label)) {
      collectWarning(`NH 배당대조: ${label} 계좌를 /n2/acctinfo 응답에서 못 찾음(계좌번호 매핑 확인 필요, 이 계좌는 대조 스코프에서 빠짐)`);
    }
  }

  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);
  const iqrStaDt = ymdKst(start);
  const iqrEndDt = ymdKst(end);

  const vaultDividends = readVaultDir(VAULT_PATHS.facts.ledger.dividends);
  const consumed = new Set();

  let totalNhDividends = 0;
  let unmatchedCount = 0;
  let unresolvedCount = 0; // 이름 없음 등 "판정 불가" — 누락이라 단정하지 않되 오너가 알아야 함

  for (const [label, actNo] of byLabel) {
    console.log(`\n=== ${label} — 배당/분배금 대조(최근 ${DAYS}일) ===`);
    let result;
    try {
      result = await getTotalTransaction({ token, actNo, iqrStaDt, iqrEndDt, actTrdDtlCd: '01' });
    } catch (e) {
      console.error(`NH 배당대조(${label}): 조회 실패 —`, e.message);
      collectWarning(`NH 배당대조(${label}): 조회 실패`);
      continue;
    }
    if (result.truncated) {
      collectWarning(`NH 배당대조(${label}): 페이지 한도 도달 — 일부 기간 데이터 누락 가능(기간을 줄여 재조회 권장)`);
    }
    const nhDividends = filterDividendRows(result.rows);
    totalNhDividends += nhDividends.length;
    console.log(`NH API 배당/분배 ${nhDividends.length}건`);

    for (const row of nhDividends) {
      const dateLabel = normDate(row.trd_dt) || `(잘못된 날짜: ${row.trd_dt})`;
      const currencyLabel = row.cur_cd || 'KRW'; // 2026-09-19 코드리뷰 MEDIUM — 외화배당에 "원"을 하드코딩해 오도했던 문제 수정
      const { record, reason } = findVaultMatch(row, vaultDividends, label, consumed);
      if (record) {
        // NH trd_amt(세전)와 Vault afterTaxAmount(세후)는 원천적으로 다른 숫자라
        // 같이 보여주기만 한다(위 findVaultMatch 주석 참고) — 매칭 여부와 무관.
        console.log(`  ✅ ${dateLabel} ${row.iem_nm} NH ${row.trd_amt} ${currencyLabel}(세전 추정) / Vault ${record.afterTaxAmount}(세후) — Vault에도 있음`);
      } else if (reason === 'nh-name-empty' || reason === 'nh-date-invalid') {
        unresolvedCount++;
        console.log(`  ❓ ${dateLabel} ${row.iem_nm || '(종목명 없음)'} ${row.trd_amt} ${currencyLabel} — 자동 판정 불가(${reason}), 수동 확인 필요`);
        collectWarning(`NH 배당대조(${label}): ${dateLabel} ${row.iem_nm || '(종목명 없음)'} ${row.trd_amt} ${currencyLabel} — 자동 매칭 불가(${reason}), 수동 확인 필요`);
      } else {
        unmatchedCount++;
        console.log(`  ⚠️  ${dateLabel} ${row.iem_nm} ${row.trd_amt} ${currencyLabel} — Vault(카카오 파싱)에서 못 찾음`);
        collectWarning(`NH 배당대조(${label}): ${dateLabel} ${row.iem_nm} ${row.trd_amt} ${currencyLabel}이 NH API엔 있는데 카카오 파싱 기록(Facts/Ledger/Dividends)엔 없음 — 알림 유실 가능성, 수동 확인 필요`);
      }
    }
  }

  console.log(`\n${unmatchedCount === 0 && unresolvedCount === 0 ? '✅' : '⚠️'} 총 NH 배당 ${totalNhDividends}건 중 Vault 미매칭 ${unmatchedCount}건, 판정불가 ${unresolvedCount}건`);
  console.log('(이 잡은 Vault/시트에 쓰지 않습니다 — 불일치는 오너 확인용 보고일 뿐, Facts/Ledger/Dividends는 그대로입니다. 단 위 경고는 텔레그램으로 발송됩니다.)');
  await flushWarnings('reconcile-nh-dividends');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('reconcile-nh-dividends').catch(() => {});
    process.exit(1);
  });
}
