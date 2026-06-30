#!/usr/bin/env node
// 실패한 평가를 복구하고 source 없는 카드를 재큐잉하는 일회성 스크립트.
// 사용: node scripts/tools/recover-evals.mjs [TOKEN]
import { readFileSync, readdirSync } from 'fs';
import { getToken, getRange, appendValues, updateCell } from '../lib/sheets-common.mjs';
import { parseEvalJson, buildRow } from '../jobs/drain-eval-queue.mjs';

const SID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const FAILED_DIR = `${process.env.HOME}/Library/Logs/banana-portfolio/failed-evals`;

const token = await getToken(process.argv[2]?.trim());
console.log('✓ 인증 완료\n');

// 1. 종목투자노트 현황 읽기
const noteRows = await getRange(token, '종목투자노트!A2:V');
console.log(`종목투자노트: ${noteRows.length}행\n`);

// 종목별 최신 카드의 source 유무 확인
const stockLatest = new Map(); // name → { date, hasSource, rowIdx }
for (let i = 0; i < noteRows.length; i++) {
  const r = noteRows[i];
  const name = String(r[1] ?? '').trim();
  const date = String(r[0] ?? '').trim();
  const axisRaw = String(r[20] ?? '').trim();
  let hasSource = false;
  if (axisRaw) {
    try {
      const ax = JSON.parse(axisRaw);
      for (const items of Object.values(ax)) {
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it.source && it.source !== '미제공' && it.source !== '데이터 부족') {
              hasSource = true;
              break;
            }
          }
        }
        if (hasSource) break;
      }
    } catch { /* not json */ }
  }
  const prev = stockLatest.get(name);
  if (!prev || date > prev.date) {
    stockLatest.set(name, { date, hasSource, rowIdx: i });
  }
}

console.log('━━━ 종목별 source 현황 ━━━');
const noSource = [];
for (const [name, info] of [...stockLatest.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const mark = info.hasSource ? '✅' : '❌';
  console.log(`  ${mark} ${name} (${info.date})`);
  if (!info.hasSource) noSource.push(name);
}
console.log();

// 2. 실패 파일에서 복구 가능한 것 파싱
const failedFiles = readdirSync(FAILED_DIR).filter(f => f.endsWith('.txt')).sort();
const recoverable = [];
for (const f of failedFiles) {
  try {
    const raw = readFileSync(`${FAILED_DIR}/${f}`, 'utf-8');
    const obj = parseEvalJson(raw);
    // 시트 날짜가 시리얼(46194) 또는 문자열("2026-06-21")일 수 있어 양쪽 비교
    const toDateStr = (v) => {
      const s = String(v ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const n = Number(s);
      if (n > 40000) { const d = new Date((n - 25569) * 86400000); return d.toISOString().slice(0, 10); }
      return s;
    };
    const sameNameRows = noteRows.filter(r => String(r[1] ?? '').trim() === obj.name);
    const exists = sameNameRows.some(r => toDateStr(r[0]) === obj.date);
    const hasNewer = sameNameRows.some(r => toDateStr(r[0]) > obj.date);
    if (exists) {
      console.log(`  ⏭ ${f}: 이미 적재됨 (${obj.name} ${obj.date})`);
      continue;
    }
    if (hasNewer) {
      console.log(`  ⏭ ${f}: 더 최신 카드 존재 — skip (${obj.name})`);
      continue;
    }
    recoverable.push({ file: f, obj });
    console.log(`  🔧 ${f}: 복구 가능 (${obj.name} ${obj.date})`);
  } catch (e) {
    console.log(`  ⚠️ ${f}: 파싱 불가 — ${e.message}`);
  }
}
console.log();

// 3. 복구 가능한 카드 삽입
let inserted = 0;
for (const { file, obj } of recoverable) {
  const row = buildRow(obj, obj.axisItems || null);
  await appendValues(token, '종목투자노트!A2:U', [row]);
  console.log(`  ✅ 적재: ${obj.name} (${obj.date}) ← ${file}`);
  inserted++;
}
if (inserted) console.log(`\n  → ${inserted}건 복구 적재 완료`);

// 4. 평가요청 큐 읽기 — 삼성바이오로직스 '오류' → '대기'로 복원
const queueRows = await getRange(token, '평가요청!A2:F');
let restored = 0;
for (let i = 0; i < queueRows.length; i++) {
  const r = queueRows[i];
  const name = String(r[1] ?? '').trim();
  const status = String(r[3] ?? '').trim();
  if (status === '오류') {
    const rowNum = i + 2;
    await updateCell(token, `평가요청!D${rowNum}`, '대기');
    await updateCell(token, `평가요청!F${rowNum}`, '');
    console.log(`  🔄 큐 복원: ${name} (행 ${rowNum}) 오류 → 대기`);
    restored++;
  }
}

// 5. source 없는 종목 중 큐에 없는 것 추가
const queuedNames = new Set(queueRows.map(r => String(r[1] ?? '').trim()));
const needReeval = noSource.filter(n => !queuedNames.has(n));
for (const name of needReeval) {
  await appendValues(token, '평가요청!A2:F', [[
    new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10),
    name, '', '대기', '', 'source 누락 — recover-evals 자동 큐잉',
  ]]);
  console.log(`  📋 큐 추가: ${name} (source 누락)`);
}

console.log(`\n━━━ 완료 ━━━`);
console.log(`  적재 ${inserted}건 · 큐 복원 ${restored}건 · 큐 추가 ${needReeval.length}건`);
