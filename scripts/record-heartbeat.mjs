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
const HEADER = ['job', 'lastRun', 'status', 'detail', 'durationSec'];

const job = process.argv[2];
const status = process.argv[3] || 'OK';
const durationSec = process.argv[4] || '';
const tokenArg = process.argv[5];
const detail = String(process.env.HB_DETAIL || '').slice(0, 200);

async function main() {
  if (!job) { console.error('usage: record-heartbeat <job> <status> <durationSec> [token]'); process.exit(2); }
  const token = await getToken(tokenArg?.trim() || null, { allowBrowser: false });
  await ensureSheet(token, STATUS_SHEET, HEADER);

  const rows = await getRange(token, `${STATUS_SHEET}!A2:E`);
  const rowNum = findStatusRow(rows, job);
  const values = [[job, nowKST(), status, detail, String(durationSec)]];
  if (rowNum) await setValues(token, `${STATUS_SHEET}!A${rowNum}:E${rowNum}`, values);
  else        await appendValues(token, `${STATUS_SHEET}!A2`, values);
  console.log(`🫀 ${job} ${status} ${durationSec}s (행 ${rowNum ?? 'append'})`);

  if (status !== 'OK') {
    try {
      await sendTelegram(`⚠️ <b>banana 잡 실패</b>\njob: <code>${job}</code>\n시각: ${nowKST()}\n${detail || '(detail 없음)'}`);
    } catch (e) { console.error('Telegram 알림 실패(무시):', e.message); }
  }
}

main().catch(e => { console.error('❌ 하트비트 기록 실패:', e.message); process.exit(1); });
