#!/usr/bin/env node
/**
 * 잡 하트비트 기록 — launchd run.sh 가 각 잡 종료 후 호출.
 * 잡상태 시트(1잡=1행)를 upsert 하고, FAIL 이면 Telegram 으로 알린다.
 * 사용: node scripts/record-heartbeat.mjs <job> <status> <durationSec> [token]
 *       HB_DETAIL=<로그꼬리> 환경변수로 detail 전달(선택).
 */
import {
  getToken, getRange, appendValues, setValues, ensureSheet, sendTelegram, nowKST,
} from './lib/sheets-common.mjs';
import { findStatusRow } from './lib/job-status.mjs';

const STATUS_SHEET = '잡상태';
const HEADER = ['job', 'lastRun', 'status', 'detail', 'durationSec', 'failStreak'];

const job = process.argv[2];
const status = process.argv[3] || 'OK';
const durationSec = process.argv[4] || '';
const tokenArg = process.argv[5];
const detail = String(process.env.HB_DETAIL || '').slice(0, 200);

async function main() {
  if (!job) { console.error('usage: record-heartbeat <job> <status> <durationSec> [token]'); process.exit(2); }
  const token = await getToken(tokenArg?.trim() || null, { allowBrowser: false });
  await ensureSheet(token, STATUS_SHEET, HEADER);

  const ts = nowKST();
  const rows = await getRange(token, `${STATUS_SHEET}!A2:F`);
  const rowNum = findStatusRow(rows, job);
  // 연속 실패 횟수(F열) 추적 — OK면 0으로 리셋, 실패면 직전값 +1.
  // 기존 5열 행은 F 없음 → priorStreak 0 (배포 직후 1회 카운터 리셋, 무해).
  const priorStreak = rowNum ? (parseInt(rows[rowNum - 2]?.[5] ?? '0', 10) || 0) : 0;
  const streak = status === 'OK' ? 0 : priorStreak + 1;
  const values = [[job, ts, status, detail, String(durationSec), String(streak)]];
  if (rowNum) await setValues(token, `${STATUS_SHEET}!A${rowNum}:F${rowNum}`, values);
  else        await appendValues(token, `${STATUS_SHEET}!A2`, values);
  console.log(`🫀 ${job} ${status} ${durationSec}s (행 ${rowNum ?? 'append'}${status !== 'OK' ? `, 연속실패 ${streak}회` : ''})`);

  // 1회 실패는 무시(일시 오류는 다음 주기에 자가복구) — 연속 2회 이상일 때만 텔레그램 알림.
  if (status !== 'OK' && streak >= 2) {
    try {
      await sendTelegram(`⚠️ <b>banana 잡 실패</b> (연속 ${streak}회)\njob: <code>${job}</code>\n시각: ${ts}\n${detail || '(detail 없음)'}`);
    } catch (e) { console.error('Telegram 알림 실패(무시):', e.message); }
  }
}

main().catch(e => { console.error('❌ 하트비트 기록 실패:', e.message); process.exit(1); });
