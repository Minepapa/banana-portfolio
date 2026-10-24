#!/usr/bin/env node
// 아르고스 투자 알림 대조(읽기 전용). 하루치 아르고스 투자 알림을 카카오 알림 파서로 거르고,
// 장부에 쓸 알림이 카카오 알림 앱 경로로 이미 장부에 남았는지 대조한다. 장부·Firestore에는 쓰지 않는다.
// 카카오 알림 앱을 끄기 전, 아르고스만으로 장부가 빠짐없이 채워지는지 확인하는 용도다.
//   node scripts/tools/argos-notification-compare.mjs [--date=YYYY-MM-DD]   (기본: 오늘 KST)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyInvestmentNotification, findLedgerTwin, kstTimestamp, readArgosInvestmentNotifications,
} from '../lib/argos-notifications.mjs';
import {
  buildCashEventRecord, buildDividendRecord, buildExchangeRecord, buildFundPurchaseRecord, buildFundValuationRecord,
  sanitizeSegment,
} from '../lib/ledger-vault-writer.mjs';
import { EXCHANGE_ACCOUNT, FUND_PURCHASE_ACCOUNT } from '../lib/account-resolver.mjs';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { CASH_ALARM_API_EXCLUDED } from '../jobs/parse-notifications-to-vault.mjs';

const RECORD_BUILDERS = {
  배당: (p) => buildDividendRecord(p),
  예수금: (p) => buildCashEventRecord(p),
  펀드적립: (p) => buildFundPurchaseRecord({ ...p, account: FUND_PURCHASE_ACCOUNT }),
  펀드평가: (p) => buildFundValuationRecord({ ...p, account: FUND_PURCHASE_ACCOUNT }),
  환전: (p) => buildExchangeRecord({ ...p, account: EXCHANGE_ACCOUNT }),
};

/**
 * 체결·금현물은 카카오 경로에서 계좌 판정 뒤 장부(Executions) 또는 API 정본 보관함으로 갈린다.
 * 그 판정을 다시 하지 않고 둘 중 어디에 같은 체결이 있는지 본다.
 * - 장부: 파일명 '날짜-시각-매수|매도-종목-수량[-주문번호…].md'를 장부와 같은 정규화로 정확히 맞춘다.
 * - API 보관함: 머리말의 종목명이 같고 수신 시각이 3분 안(수량은 머리말에 없어 보지 않는다).
 */
export function findExecutionTwin({ ts, tradeType, stockName, quantity }, dirs, used = new Set()) {
  const stem = [tradeType, stockName, String(quantity ?? '').replace(/,/g, '')].map(sanitizeSegment).join('-');
  const time = ts.slice(11).replace(/:/g, '');
  const twin = findLedgerTwin(`${ts.slice(0, 10)}-${time}-${stem}.md`, dirs.executionsDir, { prefix: true, used });
  if (twin) return twin;
  const at = Date.parse(`${ts.replace(' ', 'T')}+09:00`);
  for (const row of apiCoveredIndex(dirs.apiCoveredDir)) {
    if (used.has(row.path) || row.stockName !== String(stockName ?? '').trim()) continue;
    if (Math.abs(Date.parse(`${row.receivedAt.replace(' ', 'T')}+09:00`) - at) <= 180_000) { used.add(row.path); return row.file; }
  }
  return null;
}

const apiIndexCache = new Map();
function apiCoveredIndex(dir) {
  if (!apiIndexCache.has(dir)) {
    const rows = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((file) => {
      const fm = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
      return { file, path: join(dir, file), stockName: String(fm.stockName ?? '').trim(), receivedAt: String(fm.receivedAt ?? '') };
    }).filter((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.receivedAt)) : [];
    apiIndexCache.set(dir, rows);
  }
  return apiIndexCache.get(dir);
}

/** 한 알림의 대조 결과: 걸러냄 / 장부 일치 / API 정본(장부 안 씀) / 아르고스만. used는 이미 짝지은 장부 파일. */
export function compareNotification(item, dirs, used = new Set()) {
  const hit = classifyInvestmentNotification(item.body, item.ts);
  if (!hit) return { verdict: '걸러냄', sender: item.sender };
  const { type, parsed } = hit;
  if (type === '체결' || type === '금현물') {
    const twin = findExecutionTwin({ ts: item.ts, tradeType: parsed.tradeType, stockName: parsed.stockName,
      quantity: parsed.quantity ?? parsed.qty }, dirs, used);
    return { verdict: twin ? '장부 일치' : '아르고스만', type, twin };
  }
  if (type === '예수금' && CASH_ALARM_API_EXCLUDED.has(parsed.account)) return { verdict: 'API 정본', type };
  const record = RECORD_BUILDERS[type](parsed);
  // dirs.ledgerDirs[type]은 테스트용(실제 실행은 장부 기록 함수가 정한 볼트 폴더).
  const twin = findLedgerTwin(record.filename, dirs.ledgerDirs?.[type] ?? record.dir, { used });
  return { verdict: twin ? '장부 일치' : '아르고스만', type, twin };
}

/**
 * 반대 방향: 그날 카카오 경로가 장부에 남겼는데 아르고스 쪽 짝이 없는 기록(= 아르고스가 놓친 알림).
 * 체결 장부는 NH_API 출처를 빼고 카카오 출처(또는 출처 없는 옛 기록)만 센다.
 */
export function kakaoOnly(date, ledgerDirs, used) {
  const counts = {};
  for (const [type, dir] of Object.entries(ledgerDirs)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.startsWith(date) && f.endsWith('.md'))) {
      if (used.has(join(dir, file))) continue;
      if (type === '체결') {
        const source = parseFrontmatter(readFileSync(join(dir, file), 'utf8')).source;
        if (source && source !== 'KAKAO') continue;
      }
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
}

function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--date='));
  const date = arg ? arg.slice('--date='.length) : kstTimestamp(Date.now()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date=YYYY-MM-DD 형식');
  const dirs = {
    executionsDir: VAULT_PATHS.facts.ledger.executions,
    apiCoveredDir: vaultAbs(VAULT_REL.factsRawNotificationsApiCovered),
  };
  const items = readArgosInvestmentNotifications(vaultAbs(VAULT_REL.argosEvents), date);
  const counts = {};
  const filteredBySender = {};
  const onlyArgos = [];
  const used = new Set();
  for (const item of items) {
    const r = compareNotification(item, dirs, used);
    const key = r.type ? `${r.verdict}·${r.type}` : r.verdict;
    counts[key] = (counts[key] ?? 0) + 1;
    if (r.verdict === '걸러냄') filteredBySender[r.sender || '(이름 없음)'] = (filteredBySender[r.sender || '(이름 없음)'] ?? 0) + 1;
    if (r.verdict === '아르고스만') onlyArgos.push(`${item.ts} ${r.type} (${item.sender})`);
  }
  console.log(`[argos-notification-compare] ${date} 아르고스 투자 알림 ${items.length}건`);
  for (const [k, n] of Object.entries(counts).sort()) console.log(`  ${k}: ${n}`);
  // 걸러낸 알림은 본문을 출력하지 않는다(광고·안내 문구라도 개인 알림일 수 있다). 발송자별 개수만.
  for (const [s, n] of Object.entries(filteredBySender).sort()) console.log(`  걸러냄 발송자 ${s}: ${n}`);
  for (const line of onlyArgos) console.log(`  아르고스만: ${line}`);
  const ledger = VAULT_PATHS.facts.ledger;
  const missed = kakaoOnly(date, { 체결: ledger.executions, 배당: ledger.dividends, 예수금: ledger.cashEvents,
    펀드적립: ledger.fundPurchases, 펀드평가: ledger.fundValuations, 환전: ledger.exchanges }, used);
  for (const [type, n] of Object.entries(missed)) console.log(`  카카오만(아르고스가 놓침)·${type}: ${n}`);
  // 계좌 판정 대기 중인 체결(ExecutionConfirmations)은 장부에 없어 여기서 '아르고스만'으로 보일 수 있다.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`[argos-notification-compare] ${e.message}`); process.exit(1); }
}
