#!/usr/bin/env node
/**
 * 알람(원문 알림) → 체결내역·배당금 파서  (AI 데이터 파이프라인)
 *
 * Kakao-Notification 앱이 "알람" 탭에 적재한 원문 알림을 스캔해, 본문을 파싱하여
 * 체결(매수/매도) → "체결내역" 탭, 배당/분배금/채권원리금 → "배당금" 탭에 멱등 적재한다.
 *
 * 왜: 앱이 체결내역/배당금을 직접 쓰던 경로가 가끔 누락됨. 신뢰성 높은 "알람" 원문을 단일
 * 소스로 삼아 banana 무인 잡이 다운스트림을 채운다(재실행·백필 가능). drain·sync-reports와 동일 패턴.
 *
 * 멱등: 매 실행 알람 전수 재파싱 → 체결(복합키 날짜|구분|종목명|수량)·배당(시각_금액 uniqueKey)
 *       다운스트림 중복방지로 이미 있는 건 건너뜀. (전환기에 앱이 이중 적재해도 중복 안 생김)
 *
 * 이식 출처(Kakao 앱): AppendExecutionHistoryUseCase.kt · ExecutionHistoryRepositoryImpl.kt
 *                      AppendDividendUseCase.kt · DividendRepositoryImpl.kt
 *
 * 알람 탭 컬럼: A=시간(yyyy-MM-dd HH:mm:ss) · B=발신인 · C=키워드 · D=내용(본문)
 * 체결내역 컬럼: A체결일 B구분 C계좌 D종목코드 E자산군 F종목명 G매수단가 H수량 I매수금액 J현재가 K손익 L평가금액 M수익률
 * 배당금 컬럼:   A일자 B배당금(누적) C종목명 D처리키(uniqueKey 콤마)
 * 추가 적재: 펀드 적립(연금저축 펀드 행 D:E)·금현물(위탁 금 행 D:E)·예수금(계좌별 예수금 행 E·H).
 *   예수금 = 기준액 + Σ(거래 델타). NH(ISA·위탁)는 입금/출금 알림 출금가능금액으로 기준 자동,
 *   연금저축·IRP는 '예수금기준' 표 수동 기준값. 설계: docs/superpowers/specs/2026-06-04-예수금-자동관리-design.md
 *
 * 사용법:
 *   node scripts/parse-notifications.mjs            # OAuth(대화형) 또는 SA(무인)
 *   node scripts/parse-notifications.mjs --dry-run  # 적재 대상만 출력(쓰기 없음)
 *   node scripts/parse-notifications.mjs <TOKEN>    # 토큰 직접 전달(launchd run.sh)
 */

import { SHEET_ID, getToken, getRange, appendValues, updateCell, setValues, ensureSheet } from './lib/sheets-common.mjs';

const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const ALARM_SHEET = '알람';
const EXEC_SHEET = '체결내역';
const DIV_SHEET = '배당금';
const ACCOUNT_TABS = ['ISA', '위탁', '연금저축', 'IRP'];

// ── 예수금 자동관리 설정 ──────────────────────────────
const CASH_BASE_SHEET = '예수금기준';
const CASH_BASE_HEADER = ['계좌', '기준액', '기준일', '소스', '갱신시각'];
const CASH_ROW_NAME = '예수금';                 // ISA·위탁·IRP 표시 행 종목명(사용자가 1회 생성)
const AUTO_CASH_TABS = new Set(['ISA', '위탁']);  // NH: 입금/출금 알림 잔고로 자동 앵커
const NH_ACCT_PREFIX = { '209-02': 'ISA', '205-01': '위탁' };  // 계좌번호 앞6자 → 탭
const CASH_BASE_SEED = [
  ['ISA', '', '', '자동', ''], ['위탁', '', '', '자동', ''],
  ['연금저축', '', '', '수동', ''], ['IRP', '', '', '수동', ''],
];

// ── 금현물 기준선 설정 ────────────────────────────────
// 금 파서가 알람합으로 행을 덮어쓰면 사전 보유분(알람 없는 과거 매수)이 사라진다.
// 예수금과 동형: 기준수량·기준투자금·기준일을 기준으로, 기준일 이후 매수 알림만 가산.
const GOLD_BASE_SHEET = '금기준';
const GOLD_BASE_HEADER = ['종목', '기준수량', '기준투자금', '기준일', '갱신시각'];

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

// ── 공통 ──────────────────────────────────────────────
const cleanNum = (s, allowDot = false) => String(s ?? '').replace(allowDot ? /[^0-9.]/g : /[^0-9]/g, '');
// "2026-05-04 9:20:42" → "2026-05-04 09:20:42" (Sheets가 leading-zero 생략 가능)
function normalizeDateTime(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) return String(raw ?? '').trim();
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])} ${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}

async function getFormulas(token, range) {
  const res = await fetch(`${API}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return (await res.json()).values || [];
}

// ── 체결 파서 (증권사별 정규식) ───────────────────────
const TRADE_PATTERNS = [
  { broker: 'NH투자증권', overseas: false,
    re: /\[NH투자증권\][\s\S]*?종\s*목\s*명\s*:\s*(?<stockName>[^\n\r]+)[\s\S]*?종목코드\s*:\s*(?<stockCode>[A-Za-z0-9]{6})[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결단가\s*:\s*(?<price>[\d,]+)\s*원/ },
  { broker: 'NH투자증권 해외', overseas: true,
    re: /\[NH투자증권\]\s*해외주식[\s\S]*?종목명\s*:\s*\((?<stockCode>[A-Z0-9]+)\s+[A-Z]+\)(?<stockName>[^\n\r]+)[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결가격\s*:\s*(?<price>[\d.]+)/ },
  { broker: '삼성증권', overseas: false,
    re: /\[삼성증권\]<주식체결안내>[\n\r]+[^\n\r]+[\n\r]+(?<stockName>[^\n\r]+)[\n\r]+(?:매수|매도)(?<quantity>[\d,]+)주\s+(?<price>[\d,]+)원/ },
  { broker: '한국투자증권', overseas: false,
    re: /\[한국투자증권 체결안내\][\s\S]*?종목명\s*:\s*(?<stockName>[^(\n\r]+?)\s*\((?<stockCode>[A-Za-z0-9]{6})\)[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결단가\s*:\s*(?<price>[\d,]+)\s*원/ },
];

function parseExecution(body, tsRaw) {
  if (!(body.includes('체결') && (body.includes('매수') || body.includes('매도')))) return null;
  for (const p of TRADE_PATTERNS) {
    const m = body.match(p.re);
    if (!m) continue;
    const g = m.groups || {};
    const stockName = g.stockName?.trim();
    const quantity = parseInt(cleanNum(g.quantity), 10);
    const price = parseFloat(cleanNum(g.price, true));
    if (!stockName || !Number.isFinite(quantity) || !Number.isFinite(price)) return null;
    return {
      tradeDate: normalizeDateTime(tsRaw),
      tradeType: body.includes('매수') ? '매수' : '매도',
      stockCode: g.stockCode?.trim() || '',
      stockName, quantity, price,
      currency: p.overseas ? 'USD' : 'KRW',
    };
  }
  return null;
}

// ── 배당 파서 (증권사별 정규식) ───────────────────────
const NH_DIV = /\[NH투자증권\]\s*(?:분배금|배당금)\s*입금\s*안내[\s\S]*?종목명\s*:\s*(?<stockName>[^\n\r]+)[\s\S]*?세후금액\s*:\s*(?<amount>[\d,]+)\s*원[\s\S]*?입금일\s*:\s*(?<date>\d{4}\.\d{2}\.\d{2})/;
const NH_BOND = /\[NH투자증권\]\s*채권원리금\s*입금\s*안내[\n\r]+[^\n\r]*입금\s+(?<month>\d{2})\/(?<day>\d{2})\s+\d{2}:\d{2}\s+(?<amount>[\d,]+)\s+(?<stockName>[^\n\r]+)/;
const SAMSUNG_DIV = /\[삼성증권\]\s*<(?:분배금|배당금)[^>]*>[\s\S]*?종목명\s*:\s*(?<stockName>[^\n\r\-]+)[\s\S]*?세후\s*(?:분배금액|배당금액)\s*:\s*(?<amount>[\d,]+)\s*원/;

function parseDividend(body, tsRaw) {
  if (!(body.includes('배당금') || body.includes('분배금') || body.includes('채권원리금'))) return null;
  const ts = normalizeDateTime(tsRaw);
  const datePart = ts.slice(0, 10);            // yyyy-MM-dd
  const timePart = ts.slice(11, 19) || '00:00:00'; // HH:mm:ss
  const mk = (date, amount, stockName) => ({ date, afterTaxAmount: amount, stockName: stockName.trim(), receivedTime: timePart, uniqueKey: `${timePart}_${amount}` });

  let m = body.match(NH_DIV);
  if (m) { const a = parseInt(cleanNum(m.groups.amount), 10); if (Number.isFinite(a)) return mk(m.groups.date.replace(/\./g, '-'), a, m.groups.stockName); }
  m = body.match(NH_BOND);
  if (m) { const a = parseInt(cleanNum(m.groups.amount), 10); if (Number.isFinite(a)) return mk(`${ts.slice(0,4)}-${m.groups.month}-${m.groups.day}`, a, m.groups.stockName); }
  m = body.match(SAMSUNG_DIV);
  if (m) { const a = parseInt(cleanNum(m.groups.amount), 10); if (Number.isFinite(a)) return mk(datePart, a, m.groups.stockName); }
  return null;
}

// ── 펀드 적립 매수 파서 (삼성증권 "펀드 매수 완료 안내") ─
// 매수금액·매수기준가로 좌수를 역산: 좌수 = 매수금액 ÷ 기준가 × 1000 (기준가는 1,000좌당 표기 관행)
const FUND_FUNDNAME = /펀드명\s*:\s*([^\n\r]+)/;
const FUND_AMOUNT = /매수금액\s*:\s*([\d,]+)\s*원/;
const FUND_NAV = /매수기준가\s*:\s*([\d,]+(?:\.\d+)?)/;
const FUND_DATE = /매수신청일\s*:\s*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;

function parseFundBuy(body, tsRaw) {
  if (!(body.includes('펀드') && body.includes('매수기준가'))) return null;
  const fm = body.match(FUND_FUNDNAME);
  const am = body.match(FUND_AMOUNT);
  const nm = body.match(FUND_NAV);
  if (!fm || !am || !nm) return null;
  const fundName = fm[1].trim();
  const amount = parseInt(cleanNum(am[1]), 10);
  const nav = parseFloat(cleanNum(nm[1], true));
  if (!fundName || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(nav) || nav <= 0) return null;
  const dm = body.match(FUND_DATE);
  const p = (n) => String(n).padStart(2, '0');
  const date = dm ? `${dm[1]}-${p(dm[2])}-${p(dm[3])}` : normalizeDateTime(tsRaw).slice(0, 10);
  return { fundName, amount, nav, date, units: (amount / nav) * 1000 };
}

// ── 금현물 매수 파서 (NH투자증권 "매수 주문체결", 단위 g) ─
// 주식 체결은 "주" 단위라 parseExecution(NH)에 먼저 잡히고, 금은 "g" 단위라 거기서 미스 →
// 여기로 떨어진다. 가드를 g 단위로 둬 일반 체결과 충돌하지 않음.
const GOLD_NAME = /종\s*목\s*명\s*:\s*([^\n\r]+)/;
const GOLD_QTY = /체결수량\s*:\s*([\d,.]+)\s*g/;
const GOLD_PRICE = /체결단가\s*:\s*([\d,]+)\s*원/;
const GOLD_ORDER = /주문번호\s*:\s*(\d+)/;

function parseGoldBuy(body, tsRaw) {
  if (!(body.includes('체결') && body.includes('매수') && GOLD_QTY.test(body))) return null;
  const nm = body.match(GOLD_NAME);
  const qm = body.match(GOLD_QTY);
  const pm = body.match(GOLD_PRICE);
  if (!nm || !qm || !pm) return null;
  const stockName = nm[1].trim();
  const qty = parseFloat(cleanNum(qm[1], true));
  const price = parseFloat(cleanNum(pm[1], true));
  if (!stockName || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const om = body.match(GOLD_ORDER);
  return { stockName, qty, price, orderNo: om ? om[1] : '', date: normalizeDateTime(tsRaw).slice(0, 10) };
}

// ── 예수금 앵커 파서 (NH투자증권 "입금안내/출금안내", 잔고줄 보유) ─
// 입금·출금 알림 양쪽에 '출금가능금액'(그 시점 정답 현금잔고)이 있어 앵커로 쓴다.
// ISA·위탁 둘 다 NH라 포맷 동일 → 계좌번호 앞6자로 구분 (209-02=ISA, 205-01=위탁).
const CASH_ACCTNO = /계좌번호\s*([\d]{3}-[\d]{2}-[\d*]+)/;
const CASH_BALANCE = /출금가능금액\s*:\s*([\d,]+)\s*원/;

function parseCashAlarm(body, tsRaw) {
  if (!body.includes('NH투자증권')) return null;
  if (!(body.includes('입금안내') || body.includes('출금안내'))) return null;
  const am = body.match(CASH_ACCTNO);
  const bm = body.match(CASH_BALANCE);
  if (!am || !bm) return null;
  const acctNo = am[1].trim();
  const tab = NH_ACCT_PREFIX[acctNo.slice(0, 6)];
  if (!tab) return null;                          // 매핑 안 된 NH 계좌 → skip
  const balance = parseInt(cleanNum(bm[1]), 10);
  if (!Number.isFinite(balance) || balance < 0) return null;
  return { tab, acctNo, balance, ts: normalizeDateTime(tsRaw) };
}

// ── 종목코드 해석 (포트폴리오 수식 → 네이버 자동완성) ──
function extractStockCode(formula) {
  let m = String(formula).match(/["']([A-Za-z0-9]{6})["']/); if (m) return m[1];
  m = String(formula).match(/code=([A-Za-z0-9]{6})/); if (m) return m[1];
  if (/^[A-Za-z0-9]{6}$/.test(String(formula).trim())) return String(formula).trim();
  return '';
}
async function searchStockCodeOnline(stockName) {
  try {
    const url = `https://m.stock.naver.com/api/search/auto-complete?query=${encodeURIComponent(stockName)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) return '';
    const json = await res.text();
    const hits = json.split('"typeCode"').slice(1);
    for (const hit of hits) {
      const name = hit.match(/"nameKor"\s*:\s*"([^"]+)"/)?.[1]?.trim();
      const code = hit.match(/"itemCode"\s*:\s*"([^"]+)"/)?.[1]?.trim();
      if (name && code && name === stockName.trim()) return code;
    }
    return json.match(/"itemCode"\s*:\s*"([^"]+)"/)?.[1] || '';
  } catch { return ''; }
}

function currentPriceFormula(stockCode, isOverseas) {
  if (!stockCode) return '';
  if (isOverseas) return `=GOOGLEFINANCE("${stockCode}")*'설정'!$B$2`;
  if (/^\d+$/.test(stockCode)) return `=GOOGLEFINANCE("${stockCode}")`;
  return `=IMPORTXML("https://finance.naver.com/item/main.naver?code=${stockCode}", "//p[@class='no_today']/em/span[1]")`;
}

async function main() {
  let token = explicitToken?.trim() || null;
  token = await getToken(token);

  const alarmRows = await getRange(token, `${ALARM_SHEET}!A2:D`);
  console.log(`📨 알람 ${alarmRows.length}행 스캔`);

  // 본문(D열) 파싱
  const execs = [], divs = [], funds = [], golds = [], cashes = [];
  for (const r of alarmRows) {
    const body = String(r[3] ?? '');   // D: 내용
    const ts = String(r[0] ?? '');     // A: 시간
    if (!body) continue;
    const e = parseExecution(body, ts); if (e) { execs.push(e); continue; }
    const d = parseDividend(body, ts); if (d) { divs.push(d); continue; }
    const f = parseFundBuy(body, ts); if (f) { funds.push(f); continue; }
    const g = parseGoldBuy(body, ts); if (g) { golds.push(g); continue; }
    const c = parseCashAlarm(body, ts); if (c) cashes.push(c);
  }
  console.log(`  파싱: 체결 ${execs.length}건 · 배당 ${divs.length}건 · 펀드적립 ${funds.length}건 · 금현물 ${golds.length}건 · 예수금알림 ${cashes.length}건`);

  // ── 체결내역 적재 ──────────────────────────────────
  const execExisting = await getRange(token, `${EXEC_SHEET}!A:H`);
  const existingKeys = new Set(
    execExisting.map(row => {
      const date = normalizeDateTime(row[0]); const type = String(row[1] ?? '').trim();
      const name = String(row[5] ?? '').trim(); const qty = String(row[7] ?? '').trim().replace(/\.0*$/, '');
      return (!date || !name) ? null : `${date}|${type}|${name}|${qty}`;
    }).filter(Boolean),
  );
  const newExecs = execs.filter(e => !existingKeys.has(`${e.tradeDate}|${e.tradeType}|${e.stockName}|${e.quantity}`));

  // 포트폴리오 맵 (종목명 → [계좌, 자산군]); 중복 종목명 제외
  const portfolioMap = new Map(); const dupNames = new Set();
  for (const tab of ACCOUNT_TABS) {
    const rows = await getRange(token, `${tab}!A:B`).catch(() => []);
    for (const row of rows) {
      const assetClass = String(row[0] ?? '').trim(); const name = String(row[1] ?? '').trim();
      if (!name) continue;
      if (portfolioMap.has(name)) dupNames.add(name); else portfolioMap.set(name, [tab, assetClass]);
    }
  }
  dupNames.forEach(n => portfolioMap.delete(n));

  // 종목코드 해석용 포트폴리오 수식 캐시 (탭별 A:F FORMULA)
  const codeCache = new Map();
  async function resolveStockCode(name) {
    for (const tab of ACCOUNT_TABS) {
      const rows = await getFormulas(token, `${tab}!A:F`);
      for (const row of rows) {
        if (String(row[1] ?? '').trim() === name) {
          const code = extractStockCode(String(row[5] ?? ''));
          if (code) return code;
        }
      }
    }
    return searchStockCodeOnline(name);
  }

  const execRowsToWrite = [];
  for (const e of newExecs) {
    const portfolio = portfolioMap.get(e.stockName);
    const isOverseas = e.currency === 'USD';
    let stockCode = e.stockCode;
    if (!stockCode) { if (!codeCache.has(e.stockName)) codeCache.set(e.stockName, await resolveStockCode(e.stockName)); stockCode = codeCache.get(e.stockName); }
    execRowsToWrite.push([
      e.tradeDate, e.tradeType, portfolio?.[0] || '', stockCode, portfolio?.[1] || '', e.stockName,
      isOverseas ? `=${e.price}*'설정'!$B$2` : String(e.price),
      String(e.quantity),
      '=INDIRECT("G"&ROW())*INDIRECT("H"&ROW())',
      currentPriceFormula(stockCode, isOverseas),
      '=INDIRECT("L"&ROW())-INDIRECT("I"&ROW())',
      '=INDIRECT("H"&ROW())*INDIRECT("J"&ROW())',
      '=INDIRECT("L"&ROW())/INDIRECT("I"&ROW())-1',
    ]);
  }
  console.log(`  체결내역: 신규 ${execRowsToWrite.length}건 (기존 ${existingKeys.size}건 중복 제외)`);
  execRowsToWrite.forEach(r => console.log(`    + ${r[0]} ${r[1]} ${r[5]} ${r[7]}주 @${r[6]}`));

  // ── 배당금 적재 (날짜+종목 집계, uniqueKey 중복방지) ──
  const divExisting = await getRange(token, `${DIV_SHEET}!A:D`);
  const entryByKey = new Map();           // "date|name" → {rowNum, amount, keys:Set}
  const keysByDate = new Map();           // date → Set(uniqueKey)
  divExisting.slice(1).forEach((row, i) => {
    const date = String(row[0] ?? '').trim(); const name = String(row[2] ?? '').trim();
    if (!date || !name) return;
    const amount = parseInt(cleanNum(row[1]), 10) || 0;
    const keys = String(row[3] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    entryByKey.set(`${date}|${name}`, { rowNum: i + 2, amount, keys: new Set(keys) });
    if (!keysByDate.has(date)) keysByDate.set(date, new Set());
    keys.forEach(k => keysByDate.get(date).add(k));
  });

  // 신규 배당을 (date,name)별로 그룹
  const divGroups = new Map();
  for (const d of divs) { const k = `${d.date}|${d.stockName}`; if (!divGroups.has(k)) divGroups.set(k, []); divGroups.get(k).push(d); }

  const divAppends = []; const divUpdates = [];
  for (const [k, recs] of divGroups) {
    const [date, name] = k.split('|');
    const dateKeys = keysByDate.get(date) || new Set();
    const novel = recs.filter(r => !dateKeys.has(r.uniqueKey));
    if (!novel.length) continue;
    const existing = entryByKey.get(k);
    if (existing) {
      const newTotal = existing.amount + novel.reduce((s, r) => s + r.afterTaxAmount, 0);
      const newKeys = [...existing.keys, ...novel.map(r => r.uniqueKey)].join(',');
      divUpdates.push({ rowNum: existing.rowNum, amount: newTotal, keys: newKeys, date, name });
      existing.amount = newTotal;
    } else {
      const seen = new Set(); const distinct = novel.filter(r => !seen.has(r.uniqueKey) && seen.add(r.uniqueKey));
      const total = distinct.reduce((s, r) => s + r.afterTaxAmount, 0);
      divAppends.push([date, String(total), name, distinct.map(r => r.uniqueKey).join(',')]);
    }
    novel.forEach(r => dateKeys.add(r.uniqueKey));
    keysByDate.set(date, dateKeys);
  }
  console.log(`  배당금: 신규 ${divAppends.length}건 · 기존행 갱신 ${divUpdates.length}건`);
  divAppends.forEach(r => console.log(`    + ${r[0]} ${r[2]} ${r[1]}원`));
  divUpdates.forEach(u => console.log(`    ~ ${u.date} ${u.name} → ${u.amount}원`));

  // ── 펀드 적립 (알림 전량 재계산 후 보유행 덮어쓰기, 멱등) ──
  // 알림 자체 중복 흡수: 키 = 펀드명|날짜|금액|기준가
  const fundDedup = new Map();
  for (const f of funds) fundDedup.set(`${f.fundName}|${f.date}|${f.amount}|${f.nav}`, f);
  const fundGroups = new Map();
  for (const f of fundDedup.values()) {
    if (!fundGroups.has(f.fundName)) fundGroups.set(f.fundName, []);
    fundGroups.get(f.fundName).push(f);
  }

  // 보유행 찾기: 전 계좌 탭 A:B 에서 B(종목명)가 알림 펀드명에 포함되는 첫 행
  const norm = (s) => String(s ?? '').replace(/\s/g, '');
  async function findHoldingRow(fundName) {
    const target = norm(fundName);
    for (const tab of ACCOUNT_TABS) {
      const rows = await getRange(token, `${tab}!A:B`).catch(() => []);
      for (let i = 0; i < rows.length; i++) {
        const name = String(rows[i]?.[1] ?? '').trim();
        if (name && target.includes(norm(name))) return { tab, row: i + 1, name };
      }
    }
    return null;
  }

  const fundWrites = [];
  for (const [fundName, recs] of fundGroups) {
    recs.sort((a, b) => a.date.localeCompare(b.date));
    const 누적투자금 = recs.reduce((s, r) => s + r.amount, 0);
    const 누적좌수 = Math.round(recs.reduce((s, r) => s + r.units, 0));
    if (누적좌수 <= 0) continue;
    const hit = await findHoldingRow(fundName);
    if (!hit) { console.log(`  ⚠ 펀드 보유행 못 찾음: ${fundName} (적립 ${recs.length}건, ${누적투자금}원) — skip`); continue; }
    // 좌수(D)·투자금(E) 리터럴만 갱신. 평균기준가(C)·평가금액(H)·수익률(I)은 시트 수식이
    // 자동 계산하고, 현재가(F=기준가)는 gold-price.gs(GAS)가 라이브 갱신하므로 절대 덮어쓰지 않음.
    fundWrites.push({
      range: `${hit.tab}!D${hit.row}:E${hit.row}`, tab: hit.tab, name: hit.name,
      values: [[누적좌수, 누적투자금]],
      detail: `${recs.length}건 적립 → 좌수 ${누적좌수.toLocaleString()} · 투자금 ${누적투자금.toLocaleString()}원`,
    });
  }
  console.log(`  펀드적립: 갱신 대상 ${fundWrites.length}개`);
  fundWrites.forEach(w => console.log(`    ↻ ${w.tab} ${w.name}: ${w.detail}`));

  // ── 금현물 (기준선 앵커 + 매수 델타 → 보유행 D:E) ──────────
  // 예수금과 동형: 금기준 표의 기준수량·기준투자금 + (기준일 이후 매수 알림 합). 기준 빈칸이면 skip(클로버 방지).
  // D(수량)·E(투자금) 리터럴만. C(단가)·F(현재가 GAS)·H(평가 수식)·I(수익률)는 절대 안 건드림.
  const goldDedup = new Map();
  for (const g of golds) goldDedup.set(g.orderNo || `${g.date}|${g.qty}|${g.price}`, g);

  if (!DRY_RUN) await ensureSheet(token, GOLD_BASE_SHEET, GOLD_BASE_HEADER);
  // 보유 금 종목(유형=금) 열거
  const goldHoldings = [];
  for (const [name, p] of portfolioMap) if (p[1] === '금') goldHoldings.push({ name, tab: p[0] });
  // 금기준 표 로드 → 종목별 {기준수량, 기준투자금, 기준일, rowNum}
  const goldBaseRows = await getRange(token, `${GOLD_BASE_SHEET}!A2:E`).catch(() => []);
  const goldBaseByName = new Map();
  goldBaseRows.forEach((r, i) => { const n = String(r[0] ?? '').trim(); if (n) goldBaseByName.set(n, { qty: r[1], invest: r[2], date: String(r[3] ?? '').trim(), rowNum: i + 2 }); });
  // 보유 금 종목 중 기준 표에 없는 건 빈 기준값으로 시드
  if (!DRY_RUN) {
    const seeds = goldHoldings.filter(h => !goldBaseByName.has(h.name)).map(h => [h.name, '', '', '', '']);
    if (seeds.length) { await appendValues(token, `${GOLD_BASE_SHEET}!A2`, seeds); seeds.forEach((s, k) => goldBaseByName.set(s[0], { qty: '', invest: '', date: '', rowNum: goldBaseRows.length + 2 + k })); }
  }
  // 금 매수 알림을 보유 금 종목으로 귀속 (종목명 부분일치)
  const goldByHolding = new Map();
  for (const g of goldDedup.values()) {
    const h = goldHoldings.find(h => norm(g.stockName).includes(norm(h.name)) || norm(h.name).includes(norm(g.stockName)));
    if (!h) continue;
    if (!goldByHolding.has(h.name)) goldByHolding.set(h.name, []);
    goldByHolding.get(h.name).push(g);
  }
  const goldWrites = [];
  for (const { name } of goldHoldings) {
    const cfg = goldBaseByName.get(name);
    if (!cfg || String(cfg.qty ?? '').trim() === '') { console.log(`  ⚠ 금 기준 미입력: ${name} — 금기준 표에 기준수량·기준투자금·기준일 입력 필요(앱에서 금 행 길게 눌러 입력), skip`); continue; }
    const baseQty = parseFloat(cleanNum(cfg.qty, true));
    const baseInvest = parseInt(cleanNum(cfg.invest), 10);
    if (!Number.isFinite(baseQty) || !Number.isFinite(baseInvest)) { console.log(`  ⚠ 금 기준값 비정상: ${name} (수량=${cfg.qty}, 투자금=${cfg.invest}) — skip`); continue; }
    const baseDate = cfg.date;
    const recs = (goldByHolding.get(name) || []).filter(r => r.date > baseDate);
    const 수량 = baseQty + recs.reduce((s, r) => s + r.qty, 0);
    const 투자금 = baseInvest + recs.reduce((s, r) => s + Math.round(r.qty * r.price), 0);
    const hit = await findHoldingRow(name);
    if (!hit) { console.log(`  ⚠ 금 보유행 못 찾음: ${name} — skip`); continue; }
    goldWrites.push({
      range: `${hit.tab}!D${hit.row}:E${hit.row}`, tab: hit.tab, name: hit.name,
      values: [[수량, 투자금]],
      detail: `기준 ${baseQty}g/${baseInvest.toLocaleString()}(${baseDate || '?'}) + 매수 ${recs.length}건 → ${수량}g · 투자금 ${투자금.toLocaleString()}원`,
    });
  }
  console.log(`  금현물: 갱신 대상 ${goldWrites.length}개`);
  goldWrites.forEach(w => console.log(`    ↻ ${w.tab} ${w.name}: ${w.detail}`));

  // ── 예수금 (앵커 + 거래 델타 → 표시행 E·H) ─────────────
  // NH(ISA·위탁): 입금/출금 알림 출금가능금액으로 기준 자동 갱신. 연금저축·IRP: 예수금기준 표 수동값.
  // 예수금 = 기준액 + Σ(그 계좌 거래, 날짜 > 기준일). 매도·배당 +, 매수·금·펀드 −. 원화만(USD 제외).
  if (!DRY_RUN) await ensureSheet(token, CASH_BASE_SHEET, CASH_BASE_HEADER);
  let baseRows = await getRange(token, `${CASH_BASE_SHEET}!A2:E`).catch(() => []);
  if (!baseRows.length && !DRY_RUN) { await appendValues(token, `${CASH_BASE_SHEET}!A2`, CASH_BASE_SEED); baseRows = CASH_BASE_SEED.map(r => [...r]); }
  const baseByAcct = new Map();
  baseRows.forEach((r, i) => { const a = String(r[0] ?? '').trim(); if (a) baseByAcct.set(a, { base: r[1], date: String(r[2] ?? '').trim(), rowNum: i + 2 }); });

  // 계좌별 최신 NH 앵커
  const nhLatest = new Map();
  for (const c of cashes) { const prev = nhLatest.get(c.tab); if (!prev || c.ts > prev.ts) nhLatest.set(c.tab, c); }

  // 거래 → 계좌별 부호화 현금흐름 (date 비교용 yyyy-MM-dd)
  const tabCache = new Map();
  const tabOfHolding = async (name) => { if (!tabCache.has(name)) { const h = await findHoldingRow(name); tabCache.set(name, h ? h.tab : null); } return tabCache.get(name); };
  const flows = [];
  for (const e of execs) {
    if (e.currency !== 'KRW') continue;                          // USD 체결 → 외화RP(수동) 소관
    const p = portfolioMap.get(e.stockName); if (!p) continue;   // 계좌 미상(중복명 등) skip
    flows.push({ tab: p[0], date: e.tradeDate.slice(0, 10), amount: (e.tradeType === '매수' ? -1 : 1) * e.quantity * e.price });
  }
  for (const d of divs) { const p = portfolioMap.get(d.stockName); if (p) flows.push({ tab: p[0], date: d.date, amount: d.afterTaxAmount }); }
  for (const g of goldDedup.values()) { const tab = await tabOfHolding(g.stockName); if (tab) flows.push({ tab, date: g.date, amount: -Math.round(g.qty * g.price) }); }
  for (const f of fundDedup.values()) { const tab = await tabOfHolding(f.fundName); if (tab) flows.push({ tab, date: f.date, amount: -f.amount }); }

  // 표시행 찾기: 연금저축=MMF 행, 그 외=종목명 '예수금' 행
  const cashRowCache = new Map();
  async function findCashRow(tab) {
    if (cashRowCache.has(tab)) return cashRowCache.get(tab);
    const rows = await getRange(token, `${tab}!A:B`).catch(() => []);
    let hit = null;
    for (let i = 0; i < rows.length; i++) {
      const nm = String(rows[i]?.[1] ?? '').trim(); if (!nm) continue;
      if (tab === '연금저축' ? nm.includes('MMF') : nm === CASH_ROW_NAME) { hit = { row: i + 1, name: nm }; break; }
    }
    cashRowCache.set(tab, hit); return hit;
  }

  const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const cashWrites = [], baseUpdates = [];
  for (const tab of ACCOUNT_TABS) {
    const cfg = baseByAcct.get(tab);
    let base = null, baseDate = '';
    if (AUTO_CASH_TABS.has(tab)) {
      const anchor = nhLatest.get(tab);
      if (anchor) {
        base = anchor.balance; baseDate = anchor.ts.slice(0, 10);
        if (cfg) baseUpdates.push({ range: `${CASH_BASE_SHEET}!B${cfg.rowNum}:E${cfg.rowNum}`, values: [[base, baseDate, '자동', nowStr]] });
      } else if (cfg && String(cfg.base).trim() !== '') { base = parseInt(cleanNum(cfg.base), 10); baseDate = cfg.date; }  // 이번 회차 알림 없음 → 기존 기준 유지
    } else if (cfg && String(cfg.base).trim() !== '') { base = parseInt(cleanNum(cfg.base), 10); baseDate = cfg.date; }
    if (!Number.isFinite(base)) { if (!AUTO_CASH_TABS.has(tab)) console.log(`  ⚠ 예수금 기준 미입력: ${tab} — 예수금기준 표에 기준액·기준일 입력 필요, skip`); continue; }

    const delta = flows.filter(fl => fl.tab === tab && fl.date > baseDate).reduce((s, fl) => s + fl.amount, 0);
    const cash = base + delta;
    const disp = await findCashRow(tab);
    if (!disp) { console.log(`  ⚠ 예수금 표시행 못 찾음: ${tab} (${tab === '연금저축' ? 'MMF' : CASH_ROW_NAME}) — skip`); continue; }
    cashWrites.push({ tab, row: disp.row, name: disp.name, cash, detail: `기준 ${Number(base).toLocaleString()}(${baseDate || '?'}) ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()} = ${cash.toLocaleString()}원` });
  }
  console.log(`  예수금: 갱신 대상 ${cashWrites.length}개` + (baseUpdates.length ? ` (NH 기준 자동갱신 ${baseUpdates.length})` : ''));
  cashWrites.forEach(w => console.log(`    ↻ ${w.tab} ${w.name}: ${w.detail}`));

  if (DRY_RUN) { console.log('\n(드라이런 — 쓰기 없음)'); return; }

  // 쓰기
  if (execRowsToWrite.length) await appendValues(token, `${EXEC_SHEET}!A2`, execRowsToWrite);
  for (const u of divUpdates) {
    await updateCell(token, `${DIV_SHEET}!B${u.rowNum}`, u.amount);
    await updateCell(token, `${DIV_SHEET}!D${u.rowNum}`, u.keys);
  }
  if (divAppends.length) await appendValues(token, `${DIV_SHEET}!A2`, divAppends);
  for (const w of fundWrites) await setValues(token, w.range, w.values);
  for (const w of goldWrites) await setValues(token, w.range, w.values);
  for (const u of baseUpdates) await setValues(token, u.range, u.values);
  // 현금은 투자금(E)=평가금액(H), 손익 0. F(현재가)·G(손익) 칸은 보존 위해 E·H만 개별 갱신.
  for (const w of cashWrites) { await updateCell(token, `${w.tab}!E${w.row}`, w.cash); await updateCell(token, `${w.tab}!H${w.row}`, w.cash); }
  console.log(`\n✅ 완료 — 체결 +${execRowsToWrite.length} · 배당 신규 +${divAppends.length}/갱신 ${divUpdates.length} · 펀드 ↻${fundWrites.length} · 금 ↻${goldWrites.length} · 예수금 ↻${cashWrites.length}`);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
