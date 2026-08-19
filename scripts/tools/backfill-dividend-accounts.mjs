#!/usr/bin/env node
/**
 * 배당 acctRaw 소급 백필(일회성) — 2026-08-19 버그 수정.
 *
 * notification-parsers.mjs parseDividend가 NH "분배금 입금 안내"의 실제 형식
 * ("{마스킹 계좌번호} {이름}님 계좌로 분배금 입금 안내" — "계좌번호" 키워드도 없고
 * 대시도 없음)을 인식 못 해, 이미 Vault에 기록된 배당 파일들의 acctRaw가 전부 빈
 * 문자열로 고착돼 있었다(오너가 직접 원문을 보내줘서 발견 — 실측 26건, 5월부터
 * 누적). 코드는 고쳤지만 이미 기록된 파일엔 소급 적용이 안 되므로, "알람" 구글시트
 * 원문(지운 적 없이 계속 쌓이는 소스, parse-notifications-to-vault.mjs와 동일 소스)을
 * 다시 읽어 acctRaw만 정정한다.
 *
 * 범위: acctRaw 필드만 고친다. amount·date·stockName 등 다른 필드는 절대 안 건드림
 * (이미 정확했던 값을 재계산하지 않는다 — 순수 메타데이터 보정). account·
 * holdingsApplied는 이 스크립트가 직접 안 건드리고, 다음 update-holdings-from-
 * executions.mjs 실행이 새로 채워진 acctRaw로 정상 처리하게 둔다(관심사 분리 —
 * 원장 필드 정정과 계좌귀속 판정은 별개 잡의 책임).
 *
 * 안전: 기존 acctRaw가 이미 채워져 있으면 건드리지 않는다(alreadyOk). 재파싱해도
 * acctRaw를 못 뽑으면(예: 애초에 계좌번호가 없는 형식) 그대로 둔다(stillEmpty).
 * 대상 배당 파일이 아직 없으면(신규 알림) 건너뛴다 — 이건 parse-notifications-
 * to-vault.mjs가 정규 처리할 몫이라 이 스크립트 범위 밖이다.
 *
 * 사용법:
 *   node scripts/tools/backfill-dividend-accounts.mjs            # 실제로 정정
 *   node scripts/tools/backfill-dividend-accounts.mjs --dry-run  # 대상만 출력, 쓰기 없음
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, getRange } from '../lib/sheets-common.mjs';
import { parseDividend } from '../lib/notification-parsers.mjs';
import { buildDividendRecord } from '../lib/ledger-vault-writer.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const ALARM_SHEET = '알람';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const explicitToken = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const token = await getToken(explicitToken?.trim() || null);

  const alarmRows = await getRange(token, `${ALARM_SHEET}!A2:D`);
  console.log(`📨 알람 ${alarmRows.length}행 스캔 — 배당 acctRaw 소급 백필`);

  let fixed = 0, alreadyOk = 0, stillEmpty = 0, notFound = 0, notDividend = 0;
  for (const r of alarmRows) {
    const body = String(r[3] ?? ''); // D: 내용 (parse-notifications-to-vault.mjs와 동일 컬럼)
    const ts = String(r[0] ?? '');   // A: 시간
    if (!body) continue;

    const d = parseDividend(body, ts);
    if (!d) { notDividend++; continue; }

    // filename은 date·receivedTime·stockName으로만 결정되고 acctRaw와 무관하다
    // (ledger-vault-writer.mjs buildDividendRecord 참고) — 재파싱해도 기존 파일과
    // 정확히 같은 경로가 나와 안전하게 매칭된다.
    const { filename, dir } = buildDividendRecord(d);
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) { notFound++; continue; }

    const content = readFileSync(filepath, 'utf8');
    const existing = parseFrontmatter(content);
    if (existing.acctRaw) { alreadyOk++; continue; }
    if (!d.acctRaw) { stillEmpty++; continue; }

    console.log(`  🔧 ${d.date} ${d.stockName} — acctRaw "" → "${d.acctRaw}"`);
    if (!DRY_RUN) writeAtomic(filepath, updateFrontmatter(content, { acctRaw: d.acctRaw }));
    fixed++;
  }

  console.log(
    `\n✅ 완료 — 정정 ${fixed}건 · 이미정상 ${alreadyOk}건 · 재파싱해도못뽑음 ${stillEmpty}건 · `
    + `대상파일없음(신규) ${notFound}건 · 배당아님 ${notDividend}건`
    + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
