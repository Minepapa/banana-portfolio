#!/usr/bin/env node
/**
 * 일별 잔고 스냅샷 — launchd com.banana.daily-snapshot (매일 08:00 KST).
 *
 * 4계좌(ISA/위탁/연금저축/IRP) 평가금(H열, GOOGLEFINANCE 라이브·원화)을 읽어 하루 1행을
 * `일별스냅샷` 시트에 upsert 한다. 앱은 이 최신 행을 "오늘 기준선"으로 삼아 헤더 "어제 대비"와
 * 홈 "오늘의 변동 종목"을 계산한다. 08:00 = 미국장 마감 후·한국장 개장 전 → 모든 종목 직전 종가.
 *
 * 안전: 읽기 0건/총평가 0 → throw(잡 FAIL, 미기록). 일시적 빈 읽기가 "0원 기준선"으로 저장돼
 *       다음 델타를 오염시키는 것 차단(readHoldings 0건 throw 가드와 동일 철학). append/upsert만.
 *
 * 사용: node scripts/jobs/daily-snapshot.mjs [--dry-run] [token]
 */
import {
  getToken, getRange, appendValues, setValues, ensureSheet, nowKST, todayKST,
} from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const SNAP_SHEET = '일별스냅샷';
const HEADER = ['날짜', '스냅시각', '총평가', '계좌별JSON', '종목별JSON'];
const ACCOUNT_TABS = ['ISA', '위탁', '연금저축', 'IRP'];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const explicitToken = args.find(a => !a.startsWith('--'));

const num = (v) => parseFloat(String(v ?? '').replace(/[,%]/g, '')) || 0;

async function main() {
  const token = await getToken(explicitToken?.trim() || null, { allowBrowser: false });

  // 4계좌 평가금(H=idx7)·수량(D=idx3)·종목명(B=idx1) 수집.
  const byHolding = {};
  const byAccount = {};
  let total = 0, count = 0;
  for (const tab of ACCOUNT_TABS) {
    const rows = await getRange(token, `${tab}!A2:I`);
    let acctSum = 0;
    for (const r of rows) {
      const name = String(r[1] ?? '').trim();
      if (!name) continue;
      const evalWon = num(r[7]);
      const qty = num(r[3]);
      acctSum += evalWon;
      total += evalWon;
      count++;
      byHolding[`${tab}|${name}`] = { e: Math.round(evalWon), q: qty };
    }
    byAccount[tab] = Math.round(acctSum);
  }

  // 안전 가드: 실계좌엔 항상 보유가 있으므로 0건/총평가 0 = 읽기 이상 → 미기록.
  if (count === 0 || !(total > 0)) {
    collectWarning(`일별스냅샷 미기록: 보유 ${count}건·총평가 ${Math.round(total)} — 읽기 이상 의심`);
    await flushWarnings('daily-snapshot', { dryRun: DRY_RUN });
    throw new Error(`스냅샷 읽기 이상(보유 ${count}건, 총평가 ${Math.round(total)}) — 안전을 위해 중단`);
  }

  const date = todayKST();
  const ts = nowKST();
  const row = [date, ts, Math.round(total), JSON.stringify(byAccount), JSON.stringify(byHolding)];

  console.log(`📸 ${date} 스냅샷 — 총평가 ${Math.round(total).toLocaleString()}원 · 종목 ${count}건`);
  Object.entries(byAccount).forEach(([k, v]) => console.log(`   · ${k}: ${v.toLocaleString()}원`));

  if (DRY_RUN) {
    console.log('\n(드라이런 — 쓰기 없음)');
    await flushWarnings('daily-snapshot', { dryRun: true });
    return;
  }

  await ensureSheet(token, SNAP_SHEET, HEADER);
  // upsert: 오늘 날짜 행 있으면 덮어쓰기(재실행 멱등), 없으면 append.
  const dates = await getRange(token, `${SNAP_SHEET}!A2:A`);
  let rowNum = null;
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i]?.[0] ?? '').trim() === date) { rowNum = i + 2; break; }
  }
  if (rowNum) { await setValues(token, `${SNAP_SHEET}!A${rowNum}:E${rowNum}`, [row]); console.log(`✅ 갱신 (행 ${rowNum})`); }
  else        { await appendValues(token, `${SNAP_SHEET}!A2`, [row]); console.log(`✅ 신규 적재`); }

  await flushWarnings('daily-snapshot');
}

main().catch(e => { console.error('❌ 일별스냅샷 실패:', e.message); process.exit(1); });
