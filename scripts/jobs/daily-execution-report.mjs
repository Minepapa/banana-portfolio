#!/usr/bin/env node
/**
 * 장마감 이후 당일 체결내역 텔레그램 보고 — 오너 명시 요청("장 마감 이후 오늘 체결된
 * 거래 내역을 텔레그램으로 정리 보고", 2026-08-24 구현 지시 확정). 자산분배·퀀트 트랙
 * 구분 없이 Facts/Ledger/Executions에 그날 실제로 기록된 체결 전부를 계좌별로 묶어
 * 요약한다.
 *
 * ⚠️ 설계 판단 — LLM 호출 없음(Node 전용). 이미 Vault에 있는 체결 레코드를 계좌별로
 * 재조립해 보여주는 것뿐이라 판단(department reasoning)이 필요한 지점이 없다 —
 * morning-briefing.mjs·daily-asset-allocation-check.mjs와 동일 이유로 **운영실
 * Hermes**로 라벨링한다.
 *
 * ⚠️ 워터마크(State 캐시) 방식을 쓰지 않는다 — morning-briefing.mjs는 "마지막 실행
 * 이후 누적분"을 보고해야 해서 recordedAt 기반 워터마크가 필요했고, 그 설계가 한 번
 * 버그(당일 이벤트 영구 누락)를 냈다(morning-briefing.mjs 헤더 주석 참고). 이 잡은
 * "오늘 하루치 체결"만 보고하면 되므로 tradeDate가 오늘 KST 날짜와 일치하는지만
 * 비교하면 된다 — 상태를 전혀 안 남기는 순수 조회라 그 버그 클래스 자체가 없고,
 * 여러 번 다시 돌려도 항상 같은 결과(멱등)다.
 *
 * "오늘"은 scripts/lib/sheets-api.mjs의 todayKST()를 재사용한다(daily-snapshot.mjs·
 * update-monthly-balance-snapshot.mjs·reconcile-irp.mjs·backup-vault-snapshot.mjs 등
 * 비-시트 잡들도 이미 이 함수를 갖다 쓰는 선례가 있음 — 새로 만들지 않는다).
 *
 * 스케줄(평일 16:15 KST, plist 참고) — parse-notifications-to-vault(16:00, 카카오알림
 * →Vault)·update-holdings-from-executions(16:05, Vault→보유수량 반영)가 먼저 끝난
 * 뒤라야 그날 체결이 Facts/Ledger/Executions에 다 들어와 있고, daily-asset-allocation-
 * check(16:30)보다는 앞서 보고돼야 한다.
 *
 * 사용법: node scripts/jobs/daily-execution-report.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { todayKST } from '../lib/sheets-api.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '운영실 Hermes';

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 순수함수 — 체결 레코드 배열과 오늘 날짜(KST, "YYYY-MM-DD")를 받아 tradeDate 앞
// 10자리(YYYY-MM-DD)가 일치하는 것만 골라낸다. 테스트 가능.
export function filterTodayExecutions(executions, todayDate) {
  return (executions || []).filter((e) => String(e.tradeDate ?? '').slice(0, 10) === todayDate);
}

// 순수함수 — 오늘자 체결 레코드 배열을 계좌별로 묶어 사람이 읽는 텍스트로 만든다.
// 각 줄은 "[매도] 종목명 수량주 @가격 (계좌)" 형태(같은 계좌끼리는 이어서 나열해
// 자연히 계좌별로 묶인다), 그 뒤에 계좌·통화별 합산 금액(quantity*price)을 붙인다.
// 빈 배열이면 "오늘 체결 없음"을 명시적으로 반환 — ⚠️ 2026-08-31부터 이 문구는
// 텔레그램으로 안 나간다(저정보 메시지 억제, main() 참고). console.log에만 남아
// "잡이 살아있다"는 증거 역할만 한다 — 예전 주석처럼 오너에게 이 문구가 신호로
// 도달한다고 오해하지 말 것.
export function buildExecutionReportText(executions) {
  if (!executions.length) return '오늘 체결 없음';

  const byAccount = new Map(); // account -> line[]
  const sums = new Map(); // "account|currency" -> 합산액

  for (const e of executions) {
    const account = e.account || '미배정';
    const currency = e.currency || 'KRW';
    const price = Number(e.price ?? 0);
    const quantity = Number(e.quantity ?? 0);

    const line = `[${e.tradeType}] ${e.stockName} ${quantity}주 @${price.toLocaleString()} (${account})`;
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push(line);

    const sumKey = `${account}|${currency}`;
    sums.set(sumKey, (sums.get(sumKey) ?? 0) + quantity * price);
  }

  const lines = [...byAccount.values()].flat();
  const sumLines = [...sums.entries()].map(([key, amount]) => {
    const [account, currency] = key.split('|');
    return `거래대금 합산(매수+매도, 상계 없음) — ${account} (${currency}): ${Math.round(amount).toLocaleString()}`;
  });

  return [...lines, '', ...sumLines].join('\n');
}

async function main() {
  const executions = readVaultDir(VAULT_PATHS.facts.ledger.executions);
  const today = filterTodayExecutions(executions, todayKST());
  const body = buildExecutionReportText(today);

  console.log(body);

  // 저정보 메시지 억제(2026-08-31 오너 지적) — 체결 없는 날 "오늘 체결 없음" 한 줄만
  // 매번 발송하던 걸 멈춘다. daily-asset-allocation-check.mjs의 "조용하면 알림 없음"과
  // 동일 원칙 — console.log는 그대로 남겨(잡이 살아있다는 증거는 유지) 텔레그램만 스킵.
  if (!today.length) {
    console.log('ℹ️ daily-execution-report: 오늘 체결 없음(조용함, 알림 생략)');
    return;
  }

  if (!DRY_RUN) {
    try {
      await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '보고', body }));
    } catch (e) {
      console.error('텔레그램 알림 실패:', e.message);
    }
  }
}

// import.meta.url 가드 — 이 파일은 daily-execution-report.test.js가 filterTodayExecutions·
// buildExecutionReportText(순수함수)만 가져다 쓰려고 직접 import한다. 가드 없이 최상위에서
// main()을 그냥 부르면 테스트가 이 모듈을 import하는 순간 실제 텔레그램 발송까지 실행돼
// 버린다(morning-briefing.mjs 헤더 주석의 사고 사례와 동일 이유 — 다른 모든 잡이 이
// 가드를 쓰는 이유도 같다). CLI로 직접 실행될 때만 main()이 돈다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ daily-execution-report 오류:', e.message); process.exit(1); });
}
