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
 *   node scripts/jobs/parse-notifications.mjs            # OAuth(대화형) 또는 SA(무인)
 *   node scripts/jobs/parse-notifications.mjs --dry-run  # 적재 대상만 출력(쓰기 없음)
 *   node scripts/jobs/parse-notifications.mjs <TOKEN>    # 토큰 직접 전달(launchd run.sh)
 */

import { SHEET_ID, getToken, getRange, getRangeRaw, appendValues, updateCell, setValues, ensureSheet, clearColumnABackground } from '../lib/sheets-common.mjs';
import { resolveCashBase } from '../lib/cash-base.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

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
// 배당/분배금 알림의 계좌번호 → 예수금 귀속 후보 계좌. 4계좌가 서로 다른 증권사라
// (ISA·위탁=NH, 연금저축=삼성, IRP=한국투자) 계좌번호 앞자리로 유일하게 정해진다 —
// 후보가 2개 이상 남는 경우는 없다(정정 전엔 삼성(71612)을 연금저축·IRP 공용으로
// 잘못 취급해 실제로는 유일하게 정해지는 배당까지 모호 처리했었음). null=미상.
function dividendAcctCandidates(d) {
  const s = String(d?.acctRaw ?? '').replace(/[^0-9]/g, '');
  if (s.startsWith('20902')) return ['ISA'];
  if (s.startsWith('20501')) return ['위탁'];
  if (s.startsWith('71612')) return ['연금저축'];   // 삼성증권 = 연금저축 전용
  if (s.startsWith('43')) return ['IRP'];           // 한국투자증권 = IRP 전용(2자리라 광범위 —
                                                     // 반드시 위 5자리 prefix 검사들 뒤에 와야 안전)
  const b = String(d?.broker ?? '');                // 계좌번호 없으면 증권사로 판별
  if (/NH투자증권/.test(b)) return ['ISA', '위탁']; // NH는 ISA·위탁 공용 → 보유로 추가 판별 필요
  if (/삼성증권/.test(b)) return ['연금저축'];
  if (/한국투자증권/.test(b)) return ['IRP'];
  return null;
}
const CASH_BASE_SEED = [
  ['ISA', 0, '', '자동', ''], ['위탁', 0, '', '자동', ''],
  ['연금저축', 0, '', '수동', ''], ['IRP', 0, '', '수동', ''],
];

// ── 펀드 적립 영구 원장 ────────────────────────────────
// 알람은 외부 Kakao 앱이 관리해 과거 알림이 사라진다 → "알람 전량 재계산 후 덮어쓰기"는
// 알림이 1건만 남으면 누적 포지션을 그 1건으로 축소 파괴한다(2026-07 사고: 8,004,640좌→90,511좌).
// 대신 매수를 이 영구 원장에 dedup append 하고, 보유행 좌수(D)·투자금(E) = Σ(원장)으로 계산한다
// (체결내역과 동일한 append+dedup 내구성). BASE 행 = 자동화 이전 누적분(앵커).
const FUND_LEDGER_SHEET = '펀드적립이력';
const FUND_LEDGER_HEADER = ['날짜', '펀드명', '금액', '기준가', '좌수', '키'];
const FUND_LEDGER_SEED = [
  // 2026-07 복구: 삼성증권 기준 자동화 이전 누적(최초 2025-06-04~) = 8,004,640좌 / 12,400,000원
  ['2026-06-30', 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe', 12400000, '', 8004640, 'BASE|VIP|2026-06-30'],
];

// ── 달러RP 자동관리 설정 (모델 X: USD 앵커+델타, 원화는 표시수식) ─
// 설계: docs/superpowers/specs/2026-06-05-달러RP-앵커델타-design.md
const DOLLAR_BASE_SHEET = '달러기준';
const DOLLAR_BASE_HEADER = ['계좌', '기준USD', '기준일', '갱신시각'];
const DOLLAR_TAB = '위탁';
const DOLLAR_ROW_NAME = '외화 RP';   // 표시행: 파서가 D열(USD 잔액)만 씀, C·E·F·H는 수식

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

// ── 공통 ──────────────────────────────────────────────
const cleanNum = (s, allowDot = false) => String(s ?? '').replace(allowDot ? /[^0-9.]/g : /[^0-9]/g, '');
// 수식 인젝션 방어: USER_ENTERED 쓰기 시 =,+,-,@로 시작하면 Sheets가 수식으로 해석.
// 알림 텍스트에서 온 데이터 필드(종목명 등)는 선행 작은따옴표로 텍스트 강제.
const deformula = (s) => { const t = String(s ?? ''); return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; };
// "2026-05-04 9:20:42" → "2026-05-04 09:20:42" (Sheets가 leading-zero 생략 가능)
function normalizeDateTime(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) return String(raw ?? '').trim();
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])} ${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}

// Sheets 직렬수(1899-12-30 기준, 분수=하루 비율) → 'yyyy-MM-dd HH:mm:ss' 벽시계 문자열.
// 날짜셀 표시형식이 '날짜전용'이어도 직렬값엔 체결 시각이 남아있어 이를 복원한다.
// 이 시각이 dedup 키에 들어가야 같은 날·같은 종목·같은 수량의 서로 다른 두 체결을 구분한다.
function serialToDateTime(serial) {
  const ms = Math.round(serial * 86400) * 1000;        // 초 단위 반올림(부동소수 오차 흡수)
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
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
  const acctRaw = (body.match(/계좌번호\s*:\s*([0-9*\-]+)/)?.[1] ?? '').trim(); // 예수금 귀속용(있으면)
  const broker = (body.match(/\[(NH투자증권|삼성증권|한국투자증권)[^\]]*\]/)?.[1] ?? '').trim(); // NH엔 계좌번호 없음 → 증권사로 후보 축소
  const mk = (date, amount, stockName) => ({ date, afterTaxAmount: amount, stockName: stockName.trim(), acctRaw, broker, receivedTime: timePart, uniqueKey: `${timePart}_${amount}` });

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
  // 금 매도 알림은 아직 샘플 없으나, 동일 포맷에서 매수→매도만 바뀐다고 가정해 양쪽 지원.
  const isSell = body.includes('매도');
  if (!(body.includes('체결') && (body.includes('매수') || isSell) && GOLD_QTY.test(body))) return null;
  const nm = body.match(GOLD_NAME);
  const qm = body.match(GOLD_QTY);
  const pm = body.match(GOLD_PRICE);
  if (!nm || !qm || !pm) return null;
  const stockName = nm[1].trim();
  const qty = parseFloat(cleanNum(qm[1], true));
  const price = parseFloat(cleanNum(pm[1], true));
  if (!stockName || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const om = body.match(GOLD_ORDER);
  return { stockName, qty, price, tradeType: isSell ? '매도' : '매수', orderNo: om ? om[1] : '', date: normalizeDateTime(tsRaw).slice(0, 10) };
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

// ── 환전 파서 (NH투자증권 "환전내역 안내") ────────────
// 외화매수 → 달러RP +USD(외화금액), 외화매도 → −USD. USD만 처리.
// 환전일자엔 연도가 없어 알람 ts 연도를 차용(NH_BOND와 동형).
const EXCH_DATE = /환전일자\s*:\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const EXCH_KIND = /환전구분\s*:\s*(외화매수|외화매도)/;
const EXCH_CCY = /통화명\s*:\s*([A-Za-z]+)/;
const EXCH_USD = /외화금액\s*:\s*USD\s*([\d,]+(?:\.\d+)?)/;

function parseExchange(body, tsRaw) {
  if (!(body.includes('환전내역') && body.includes('환전구분'))) return null;
  const km = body.match(EXCH_KIND);
  const um = body.match(EXCH_USD);
  if (!km || !um) return null;
  const cm = body.match(EXCH_CCY);
  if (cm && cm[1].toUpperCase() !== 'USD') return null;   // USD 외 통화 skip
  const usd = parseFloat(cleanNum(um[1], true));
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const ts = normalizeDateTime(tsRaw);
  const dm = body.match(EXCH_DATE);
  const p = (n) => String(n).padStart(2, '0');
  const date = dm ? `${ts.slice(0, 4)}-${p(dm[1])}-${p(dm[2])}` : ts.slice(0, 10);
  return { kind: km[1], usd, date };
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
  const execs = [], divs = [], funds = [], golds = [], cashes = [], exchanges = [];
  for (const r of alarmRows) {
    const body = String(r[3] ?? '');   // D: 내용
    const ts = String(r[0] ?? '');     // A: 시간
    if (!body) continue;
    const e = parseExecution(body, ts); if (e) { execs.push(e); continue; }
    const d = parseDividend(body, ts); if (d) { divs.push(d); continue; }
    const f = parseFundBuy(body, ts); if (f) { funds.push(f); continue; }
    const g = parseGoldBuy(body, ts); if (g) { golds.push(g); continue; }
    const x = parseExchange(body, ts); if (x) { exchanges.push(x); continue; }
    const c = parseCashAlarm(body, ts); if (c) cashes.push(c);
  }
  console.log(`  파싱: 체결 ${execs.length}건 · 배당 ${divs.length}건 · 펀드적립 ${funds.length}건 · 금현물 ${golds.length}건 · 환전 ${exchanges.length}건 · 예수금알림 ${cashes.length}건`);

  // ── 체결내역 적재 ──────────────────────────────────
  // 원본값(UNFORMATTED)으로 읽는다: 날짜=직렬수라 표시형식이 날짜전용이어도 시각이 보존된다.
  // (과거: FORMATTED로 읽어 시각이 잘려 풀-날짜시각 키와 어긋나 매시간 중복 적재되던 버그)
  const execExisting = await getRangeRaw(token, `${EXEC_SHEET}!A:H`);
  // dedup 키 = 체결일시(시각 포함) | 구분 | 종목 | 수량.
  // 시각까지 비교하므로 같은 날·같은 종목·같은 수량이라도 체결 시각이 다르면 별개 거래로 본다.
  // 자정(00:00:00)은 시각정보 없는 날짜전용 기록(금현물 등)이므로 날짜로만 비교.
  const canonDT = (s) => { const t = String(s ?? '').trim(); return t.endsWith(' 00:00:00') ? t.slice(0, 10) : t; };
  const cellDT = (v) => (typeof v === 'number' ? serialToDateTime(v) : normalizeDateTime(v));
  const execKey = (dt, type, name, qty) =>
    `${canonDT(dt)}|${String(type ?? '').trim()}|${String(name ?? '').trim()}|${String(qty ?? '').trim().replace(/\.0*$/, '')}`;
  const existingKeys = new Set();
  // 시각정보 없는(날짜만) 기존 행의 키 — 앱 셀편집(TradeEditModal)이 FORMATTED 날짜를 그대로
  // 재저장해 시각이 유실된 행 포함. 이런 행은 알람 재파싱 시 항상 실제 시각을 갖게 되어 execKey가
  // 절대 일치할 수 없다 → 매시간 중복 적재된 사고(2026-06-23 현대차, 8주→16주로 배증).
  // 날짜만으로도 매칭되게 완화하되, 레거시 행 1개당 딱 1건만 흡수(Map 카운트)해 같은 날 진짜
  // 분할매수(동일 종목·수량)가 두 번째부터 죄다 스킵되는 걸 막는다. 시각 있는 정상 행은 엄격 유지.
  const existingDateOnlyKeys = new Map();   // key → 남은 흡수 가능 건수
  const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
  for (const row of execExisting) {
    const dt = cellDT(row[0]); const name = String(row[5] ?? '').trim();
    if (!dt || !name) continue;
    const k = execKey(dt, row[1], name, row[7]);   // execKey 내부가 canonDT 적용(자정→날짜만 축약)
    existingKeys.add(k);
    if (DATE_ONLY_RE.test(k.split('|')[0])) existingDateOnlyKeys.set(k, (existingDateOnlyKeys.get(k) ?? 0) + 1);
  }
  const newExecs = execs.filter(e => {
    if (existingKeys.has(execKey(e.tradeDate, e.tradeType, e.stockName, e.quantity))) return false;
    const dk = execKey(e.tradeDate.slice(0, 10), e.tradeType, e.stockName, e.quantity);
    const left = existingDateOnlyKeys.get(dk);
    if (left > 0) {
      existingDateOnlyKeys.set(dk, left - 1);
      console.log(`  ⚠ 날짜전용 레거시행 매칭으로 중복 스킵(감사용): ${e.tradeDate} ${e.tradeType} ${e.stockName} ${e.quantity}주 — 실제 신규 거래라면 해당 레거시 체결행 시각 확인 필요`);
      return false;
    }
    return true;
  });

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
      e.tradeDate, e.tradeType, portfolio?.[0] || '', stockCode, portfolio?.[1] || '', deformula(e.stockName),
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
      divAppends.push([date, String(total), deformula(name), distinct.map(r => r.uniqueKey).join(',')]);
    }
    novel.forEach(r => dateKeys.add(r.uniqueKey));
    keysByDate.set(date, dateKeys);
  }
  console.log(`  배당금: 신규 ${divAppends.length}건 · 기존행 갱신 ${divUpdates.length}건`);
  divAppends.forEach(r => console.log(`    + ${r[0]} ${r[2]} ${r[1]}원`));
  divUpdates.forEach(u => console.log(`    ~ ${u.date} ${u.name} → ${u.amount}원`));

  // ── 펀드 적립 (영구 원장 append+dedup → 보유행 D:E = Σ원장) ──
  // 왜 '전량 재계산 덮어쓰기'를 안 쓰나: 알람은 외부 Kakao 앱 관리라 과거 알림이 사라진다.
  // 알림이 1건만 남은 순간 재계산하면 누적 포지션을 1건으로 축소 덮어쓴다(2026-07 사고).
  // → 매수를 영구 원장(FUND_LEDGER_SHEET)에 키로 dedup append 하고, 좌수/투자금은 Σ원장.
  // 알림 자체 중복 흡수: 키 = 펀드명|날짜|금액|기준가.
  const fundDedup = new Map();
  for (const f of funds) fundDedup.set(`${f.fundName}|${f.date}|${f.amount}|${f.nav}`, f);

  // 보유행 찾기: 전 계좌 탭 A:B 에서 B(종목명)가 원장 펀드명의 접두인 첫 행.
  // startsWith(=접두 일치): 이름이 문자열 중간에 우연히 겹쳐 오귀속되는 것을 막는다(금융 안전).
  const norm = (s) => String(s ?? '').replace(/\s/g, '');
  async function findHoldingRow(fundName) {
    const target = norm(fundName);
    for (const tab of ACCOUNT_TABS) {
      const rows = await getRange(token, `${tab}!A:B`).catch(() => []);
      for (let i = 0; i < rows.length; i++) {
        const name = String(rows[i]?.[1] ?? '').trim();
        if (name && target.startsWith(norm(name))) return { tab, row: i + 1, name };
      }
    }
    return null;
  }

  // 영구 원장 로드 + 최초 시드(자동화 이전 누적 앵커)
  if (!DRY_RUN) await ensureSheet(token, FUND_LEDGER_SHEET, FUND_LEDGER_HEADER);
  let ledgerRows = await getRange(token, `${FUND_LEDGER_SHEET}!A2:F`).catch(() => []);
  if (!ledgerRows.length) {
    if (!DRY_RUN) await appendValues(token, `${FUND_LEDGER_SHEET}!A2`, FUND_LEDGER_SEED);
    ledgerRows = FUND_LEDGER_SEED.map(r => [...r]);   // dry-run/최초에도 계산에 반영
  }
  const ledgerKeys = new Set(ledgerRows.map(r => String(r[5] ?? '').trim()).filter(Boolean));

  // 새 매수 알림 → 원장 append (멱등: 키 미존재만). 여기서 ledgerRows에도 즉시 반영.
  const fundLedgerAppends = [];
  for (const f of fundDedup.values()) {
    const key = `${f.fundName}|${f.date}|${f.amount}|${f.nav}`;
    if (ledgerKeys.has(key)) continue;
    ledgerKeys.add(key);
    const row = [f.date, f.fundName, f.amount, f.nav, Math.round(f.units), key];
    fundLedgerAppends.push(row); ledgerRows.push(row);
  }

  // 원장 전체를 보유행별로 집계 → 평균기준가(C)·좌수(D)·투자금(E). C=Σ투자금/Σ좌수×1000(평균
  // 매수기준가, 리터럴 기록 — 시트 C가 수식이 아니라 리터럴이라 스스로 갱신 안 돼 파서가 채운다).
  // 평가금액(H)·수익률(I)은 시트 수식이, 현재가(F=기준가)는 GAS가 라이브 갱신 → 절대 건드리지 않음.
  const fundAgg = new Map();          // `${tab}!${row}` → 누적
  const holdCache = new Map();
  const unmatched = new Map();        // 보유행 못 찾은 펀드명 → 원장 건수(경고용)
  const rowFunds = new Map();         // `${tab}!${row}` → Set(펀드명) — 오귀속 충돌 탐지
  for (const r of ledgerRows) {
    const fname = String(r[1] ?? '').trim(); if (!fname) continue;
    const amount = parseInt(cleanNum(String(r[2] ?? '')), 10) || 0;
    const units = parseInt(cleanNum(String(r[4] ?? '')), 10) || 0;
    if (!holdCache.has(fname)) holdCache.set(fname, await findHoldingRow(fname));
    const hit = holdCache.get(fname);
    if (!hit) { unmatched.set(fname, (unmatched.get(fname) || 0) + 1); continue; }
    const k = `${hit.tab}!${hit.row}`;
    if (!rowFunds.has(k)) rowFunds.set(k, new Set());
    rowFunds.get(k).add(fname);
    if (!fundAgg.has(k)) fundAgg.set(k, { tab: hit.tab, row: hit.row, name: hit.name, units: 0, invest: 0, n: 0 });
    const a = fundAgg.get(k); a.units += units; a.invest += amount; a.n += 1;
  }
  // 안전 경고: 보유행 미매칭(오타·행 삭제·일시적 read 실패로 원장 유실) / 한 행에 2+ 펀드 오귀속
  for (const [name, n] of unmatched) {
    console.log(`  ⚠ 펀드 원장 보유행 못 찾음: ${name} (${n}건) — 집계 제외(보유종목 B열 이름 접두 확인)`);
    collectWarning(`펀드 보유행 못찾음: ${name}`);
  }
  for (const [k, names] of rowFunds) if (names.size > 1) {
    console.log(`  ⚠ 펀드 오귀속 의심: 보유행 ${k}에 서로 다른 펀드명 ${names.size}개 합산됨 — ${[...names].join(' / ')}`);
    collectWarning(`펀드 오귀속 의심: ${k}`);
  }
  const fundWrites = [];
  for (const a of fundAgg.values()) {
    if (a.units <= 0) continue;
    const 평균단가 = Math.round(a.invest / a.units * 1000 * 100) / 100;   // 평균 매수기준가(1,000좌당)
    fundWrites.push({
      range: `${a.tab}!C${a.row}:E${a.row}`, tab: a.tab, name: a.name,
      values: [[평균단가, a.units, a.invest]],
      detail: `원장 ${a.n}건 Σ → 단가 ${평균단가.toLocaleString()} · 좌수 ${a.units.toLocaleString()} · 투자금 ${a.invest.toLocaleString()}원`,
    });
  }
  console.log(`  펀드적립: 원장 신규 +${fundLedgerAppends.length} · 보유행 갱신 ${fundWrites.length}개`);
  fundWrites.forEach(w => console.log(`    ↻ ${w.tab} ${w.name}: ${w.detail}`));

  // ── 금현물 → 체결내역 통합 (일반 주식과 동일 파이프라인) ──────
  // 금 매수/매도 알림을 체결내역에 적재 → 앱 체결 동기화가 보유행 수량을 매수누적·매도차감.
  // 별도 보유행 계산 없음(클로버 원인 제거). 예수금 현금흐름은 아래 flows에서 부호로 가감.
  const goldDedup = new Map();
  for (const g of golds) goldDedup.set(g.orderNo || `${g.date}|${g.tradeType}|${g.qty}|${g.price}`, g);

  const goldHoldings = [];
  for (const [name, p] of portfolioMap) if (p[1] === '금') goldHoldings.push({ name, tab: p[0] });
  const goldExecRows = [];
  for (const g of goldDedup.values()) {
    // 금 알림 종목명 → 보유 금 종목 귀속(부분일치). 단가·수량 단위는 원/g·g.
    const h = goldHoldings.find(h => norm(g.stockName).includes(norm(h.name)) || norm(h.name).includes(norm(g.stockName)));
    if (!h) { console.log(`  ⚠ 금 보유종목 매칭 실패: ${g.stockName} — skip`); collectWarning(`금 매칭실패: ${g.stockName}`); continue; }
    const key = execKey(g.date, g.tradeType, h.name, g.qty);
    if (existingKeys.has(key)) continue;        // 체결내역 멱등 dedup
    existingKeys.add(key);
    goldExecRows.push([
      g.date, g.tradeType, h.tab, '금', '금', h.name,
      String(g.price), String(g.qty),
      '=INDIRECT("G"&ROW())*INDIRECT("H"&ROW())',
      String(g.price),                          // 현재가(J): 금은 시세 티커 없어 체결가로 기록(로그용)
      '=INDIRECT("L"&ROW())-INDIRECT("I"&ROW())',
      '=INDIRECT("H"&ROW())*INDIRECT("J"&ROW())',
      '=INDIRECT("L"&ROW())/INDIRECT("I"&ROW())-1',
    ]);
  }
  execRowsToWrite.push(...goldExecRows);
  console.log(`  금현물: 체결내역 신규 ${goldExecRows.length}건`);
  goldExecRows.forEach(r => console.log(`    + ${r[0]} ${r[1]} ${r[5]} ${r[7]}g @${r[6]}`));

  // ── 예수금 (앵커 + 거래 델타 → 표시행 E·H) ─────────────
  // NH(ISA·위탁): 입금/출금 알림 출금가능금액으로 기준 자동 갱신. 연금저축·IRP: 예수금기준 표 수동값.
  // 예수금 = 기준액 + Σ(그 계좌 거래, 날짜 > 기준일). 매도·배당 +, 매수·금·펀드 −. 원화만(USD 제외).
  if (!DRY_RUN) await ensureSheet(token, CASH_BASE_SHEET, CASH_BASE_HEADER);
  let baseRows = await getRange(token, `${CASH_BASE_SHEET}!A2:E`).catch(() => []);
  if (!baseRows.length && !DRY_RUN) { await appendValues(token, `${CASH_BASE_SHEET}!A2`, CASH_BASE_SEED); baseRows = CASH_BASE_SEED.map(r => [...r]); }
  const baseByAcct = new Map();
  baseRows.forEach((r, i) => { const a = String(r[0] ?? '').trim(); if (a) baseByAcct.set(a, { base: r[1], date: String(r[2] ?? '').trim(), source: String(r[3] ?? '').trim(), rowNum: i + 2 }); });

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
  // 배당/분배금 → 예수금(+). 계좌 귀속은 portfolioMap(중복명 삭제됨)이 아니라 "보유 계좌 + 알림 계좌번호"로
  // 판별한다: 여러 계좌 보유 ETF(중복명)도 알림의 계좌번호로 정확히 귀속(예: 삼성 71612 → 연금저축).
  // 보유 종목 목록(계좌·이름). 알림명은 정식 장명(미래에셋 TIGER…증권상장지수투자신탁), 보유명은
  // 축약(TIGER 미국배당다우존스)이라 정확일치가 안 됨 → 공백제거 후 "알림명 ⊃ 보유명" 부분일치로,
  // 여러 개 걸리면 가장 긴(구체적) 보유명 우선(커버드콜 등 유사명 오귀속 방지). 'SK'↔'에스케이' 보정.
  const dnorm = (s) => String(s ?? '').replace(/\s/g, '').replace(/에스케이/g, 'SK').replace(/케이티/g, 'KT');
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const holdingList = [];
  for (const tab of ACCOUNT_TABS) {
    const rows = await getRange(token, `${tab}!A:B`).catch(() => []);
    for (const row of rows) {
      const name = String(row[1] ?? '').trim(); if (!name) continue;
      const full = dnorm(name);
      holdingList.push({ tab, nname: full, isCore: false });
      // 보유명 후행 (…)/[…] 접미(예: '(H)'·'(합성)'·'[채권-재간접]')는 알림 장명에 없을 수 있어 코어도 등록
      const core = full.replace(/[([].*$/, '');
      if (core.length >= 6 && core !== full) holdingList.push({ tab, nname: core, isCore: true });
    }
  }
  // 매칭: full은 순수 부분일치. core(접미 제거)는 프리픽스 오매칭(KODEX200 vs KODEX200TR) 방지를 위해
  // 코어 뒤에 ETF 법정접미(증권/상장지수/투자신탁)나 문자열 끝이 와야 인정.
  const matchesHolding = (dn, h) => {
    if (!h.nname || !dn.includes(h.nname)) return false;
    if (!h.isCore) return true;
    return new RegExp(reEsc(h.nname) + '(증권|상장지수|투자신탁|$)').test(dn);
  };
  const resolveDivTab = (d) => {
    const dn = dnorm(d.stockName);
    const matches = holdingList.filter(h => matchesHolding(dn, h)).sort((a, b) => b.nname.length - a.nname.length);
    if (matches.length === 0) { const c = dividendAcctCandidates(d); return (c && c.length === 1) ? c[0] : null; }
    const best = matches[0];
    const bestTabs = [...new Set(matches.filter(m => m.nname === best.nname).map(m => m.tab))]; // 최장 일치명의 계좌들
    const cands = dividendAcctCandidates(d);
    // full 이름이 유일 계좌 → 확정. core 매칭이거나 다계좌면 계좌 후보와 교집합이 '유일'할 때만 확정
    // (실물 계좌 금액이라 애매하면 추측하지 않고 미상 처리 → 아래 경고, 수동 확인).
    if (bestTabs.length === 1 && !best.isCore) return bestTabs[0];
    if (!cands) return null;
    const inter = bestTabs.filter(t => cands.includes(t));
    return inter.length === 1 ? inter[0] : null;
  };
  const divSeen = new Set(); const divUnresolved = [];
  for (const d of divs) {
    const tab = resolveDivTab(d);
    if (!tab) { divUnresolved.push(d.stockName); continue; }
    const dk = `${d.date}|${tab}|${d.stockName}|${d.uniqueKey}`; // 귀속 후 dedup(계좌 포함) → 같은 금액 타계좌 배당 보존
    if (divSeen.has(dk)) continue; divSeen.add(dk);
    flows.push({ tab, date: d.date, amount: d.afterTaxAmount });
  }
  if (divUnresolved.length) {
    const names = [...new Set(divUnresolved)];
    console.log(`  ⚠ 배당 예수금 귀속 실패(계좌 판별 불가·수동 확인): ${names.join(', ')}`);
    collectWarning(`배당 귀속실패 ${names.length}종목: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' 외' : ''}`);
  }
  for (const g of goldDedup.values()) { const tab = await tabOfHolding(g.stockName); if (tab) flows.push({ tab, date: g.date, amount: (g.tradeType === '매도' ? 1 : -1) * Math.round(g.qty * g.price) }); }
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
    const isAutoTab = AUTO_CASH_TABS.has(tab);
    // NH(ISA·위탁)는 입금/출금 알림이 그 시점 실제 잔고 = 앵커. 알림이 수동 기준일보다 최신이면
    // 알림 우선(입금 자동 반영), 같은 날은 수동 존중. 비-NH는 수동 기준만. (로직: cash-base.mjs)
    const { base, baseDate, autoUpdated } = resolveCashBase({ cfg, anchor: isAutoTab ? nhLatest.get(tab) : null, isAutoTab });
    if (autoUpdated && cfg) baseUpdates.push({ range: `${CASH_BASE_SHEET}!B${cfg.rowNum}:E${cfg.rowNum}`, values: [[base, baseDate, '자동', nowStr]] });
    if (!Number.isFinite(base)) { if (!isAutoTab) console.log(`  ⚠ 예수금 기준 미입력: ${tab} — 예수금기준 표에 기준액·기준일 입력 필요, skip`); continue; }

    const delta = flows.filter(fl => fl.tab === tab && fl.date > baseDate).reduce((s, fl) => s + fl.amount, 0);
    const cash = base + delta;
    const disp = await findCashRow(tab);
    if (!disp) { console.log(`  ⚠ 예수금 표시행 못 찾음: ${tab} (${tab === '연금저축' ? 'MMF' : CASH_ROW_NAME}) — skip`); continue; }
    cashWrites.push({ tab, row: disp.row, name: disp.name, cash, detail: `기준 ${Number(base).toLocaleString()}(${baseDate || '?'}) ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()} = ${cash.toLocaleString()}원` });
  }
  console.log(`  예수금: 갱신 대상 ${cashWrites.length}개` + (baseUpdates.length ? ` (NH 기준 자동갱신 ${baseUpdates.length})` : ''));
  cashWrites.forEach(w => console.log(`    ↻ ${w.tab} ${w.name}: ${w.detail}`));

  // ── 달러RP (USD 앵커 + USD 델타 → 위탁!D{row}) ──────
  // 환전(외화매수 +/외화매도 −) + 해외 체결(매수 −/매도 +). 기준 이후 strict 가산.
  // 저장은 USD(불변), 원화 표시는 D×설정!B2 수식 → 환율 변동에 출렁이지 않음(멱등).
  if (!DRY_RUN) await ensureSheet(token, DOLLAR_BASE_SHEET, DOLLAR_BASE_HEADER);
  const dollarBaseRows = await getRange(token, `${DOLLAR_BASE_SHEET}!A2:D`).catch(() => []);
  const dollarBase = dollarBaseRows.find(r => String(r[0] ?? '').trim() === DOLLAR_TAB);
  let dollarWrite = null;
  if (!dollarBase || String(dollarBase[1] ?? '').trim() === '') {
    console.log(`  ⚠ 달러RP 기준 미입력: ${DOLLAR_TAB} — 달러기준 표에 기준USD·기준일 입력 필요, skip`);
  } else {
    const baseUSD = parseFloat(cleanNum(dollarBase[1], true));
    const baseDate = String(dollarBase[2] ?? '').trim();
    const usdFlows = [];
    for (const x of exchanges) usdFlows.push({ date: x.date, amount: (x.kind === '외화매수' ? 1 : -1) * x.usd });
    for (const e of execs) { if (e.currency !== 'USD') continue; usdFlows.push({ date: e.tradeDate.slice(0, 10), amount: (e.tradeType === '매수' ? -1 : 1) * e.quantity * e.price }); }
    const usdDelta = usdFlows.filter(fl => fl.date > baseDate).reduce((s, fl) => s + fl.amount, 0);
    const usdBal = Math.round((baseUSD + usdDelta) * 100) / 100;
    const witRows = await getRange(token, `${DOLLAR_TAB}!A:B`).catch(() => []);
    let dRow = null;
    for (let i = 0; i < witRows.length; i++) { if (String(witRows[i]?.[1] ?? '').trim() === DOLLAR_ROW_NAME) { dRow = i + 1; break; } }
    if (!dRow) console.log(`  ⚠ 달러RP 표시행 못 찾음: ${DOLLAR_TAB} (${DOLLAR_ROW_NAME}) — skip`);
    else dollarWrite = { row: dRow, usd: usdBal, detail: `기준 ${baseUSD}(${baseDate || '?'}) ${usdDelta >= 0 ? '+' : '−'}${Math.abs(usdDelta).toFixed(2)} = ${usdBal} USD` };
  }
  if (dollarWrite) console.log(`  달러RP: ↻ ${DOLLAR_TAB} ${dollarWrite.detail}`);

  if (DRY_RUN) { console.log('\n(드라이런 — 쓰기 없음)'); await flushWarnings('parse-notifications', { dryRun: true }); return; }

  // 쓰기
  if (execRowsToWrite.length) {
    const resp = await appendValues(token, `${EXEC_SHEET}!A2`, execRowsToWrite);
    // 새 체결행의 A열 배경을 흰색으로 리셋 — 위 '처리완료(초록)' 행 서식 상속으로
    // 앱이 미처리 신규 체결을 처리완료로 오인·스킵하는 것을 방지.
    // 범위는 append 응답 updatedRange에서 행번호 추출(권위 소스). 파싱 실패 시 기존행수로 역산(폴백)
    // — 조용히 스킵하면 배경상속 버그가 재발하므로 반드시 어떤 범위로든 리셋한다.
    const cells = String(resp?.updates?.updatedRange ?? '').split('!').pop() || '';
    const rowNums = (cells.match(/\d+/g) || []).map(Number);
    let startRow = rowNums[0], endRow = rowNums[rowNums.length - 1] ?? rowNums[0];
    if (!startRow) {
      startRow = execExisting.length + 1; endRow = startRow + execRowsToWrite.length - 1;
      console.log(`  ⚠ updatedRange 파싱 실패('${cells}') — 기존행수 기준 폴백 A${startRow}:A${endRow}`);
    }
    await clearColumnABackground(token, EXEC_SHEET, startRow, endRow);

    // ── 주문제안 자동 매칭 — 승인된 주문서가 실제 체결되면 실행완료로 (주문함 루프 클로즈) ──
    // 매칭키 = 계좌|종목명|방향 (order-candidates makeMatchKey와 동일 계약). 승인 1건당 체결
    // 1건만 소비. 매칭 실패는 그대로 둠(수동 처리 가능 — 파괴적 쓰기 없음, 시트 미존재도 무해).
    try {
      const propRows = await getRange(token, '주문제안!A2:N').catch(() => []);
      const approved = new Map();   // matchKey → rowNum (최초 1건)
      propRows.forEach((r, i) => {
        if (String(r[10] ?? '').trim() !== '승인') return;
        const k = String(r[13] ?? '').trim();
        if (k && !approved.has(k)) approved.set(k, i + 2);
      });
      for (const er of execRowsToWrite) {
        const k = `${String(er[2] ?? '').trim()}|${String(er[5] ?? '').trim()}|${String(er[1] ?? '').trim()}`;
        const rowNum = approved.get(k);
        if (!rowNum) continue;
        approved.delete(k);
        await updateCell(token, `주문제안!K${rowNum}`, '실행완료');
        await updateCell(token, `주문제안!L${rowNum}`, normalizeDateTime(String(er[0] ?? '')));
        console.log(`  ✅ 주문서 실행완료 매칭: ${k} (행 ${rowNum})`);
      }
    } catch (e) { console.log(`  ⚠ 주문제안 매칭 skip: ${e.message}`); }
  }
  for (const u of divUpdates) {
    await updateCell(token, `${DIV_SHEET}!B${u.rowNum}`, u.amount);
    await updateCell(token, `${DIV_SHEET}!D${u.rowNum}`, u.keys);
  }
  if (divAppends.length) await appendValues(token, `${DIV_SHEET}!A2`, divAppends);
  if (fundLedgerAppends.length) await appendValues(token, `${FUND_LEDGER_SHEET}!A2`, fundLedgerAppends);
  for (const w of fundWrites) await setValues(token, w.range, w.values);
  for (const u of baseUpdates) await setValues(token, u.range, u.values);
  // 현금은 투자금(E)=평가금액(H), 손익 0. F(현재가)·G(손익) 칸은 보존 위해 E·H만 개별 갱신.
  for (const w of cashWrites) { await updateCell(token, `${w.tab}!E${w.row}`, w.cash); await updateCell(token, `${w.tab}!H${w.row}`, w.cash); }
  // 달러RP: D열(USD 잔액)만 씀. C·E·F·H 수식(원화 표시) 보존.
  if (dollarWrite) await updateCell(token, `${DOLLAR_TAB}!D${dollarWrite.row}`, dollarWrite.usd);
  console.log(`\n✅ 완료 — 체결 +${execRowsToWrite.length}(금 ${goldExecRows.length}) · 배당 신규 +${divAppends.length}/갱신 ${divUpdates.length} · 펀드 ↻${fundWrites.length} · 예수금 ↻${cashWrites.length}`);
  // 경고 요약은 마지막 줄에 — run.sh가 로그 꼬리(tail -3)를 잡상태 detail로 넣어 앱에 노출 + 텔레그램(24h 억제)
  await flushWarnings('parse-notifications');
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
