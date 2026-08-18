// 카카오 알림(증권사 발신) 원문 → 구조화 이벤트 파서 — 순수 함수, I/O 없음.
//
// scripts/jobs/parse-notifications.mjs(v1, 구글시트 대상)에서 그대로 추출했다 — 파싱
// 로직 자체는 이미 실전에서 검증된 자산이라 바꾸지 않는다(docs/ARCHITECTURE-V2.md
// "파싱 로직 승계" 절). v1 잡과 v2 Vault 기록 잡(parse-notifications-to-vault.mjs)이
// 이 모듈 하나를 공유해서 같은 정규식이 두 곳에서 따로 관리되며 갈라지는 걸 막는다.
//
// 계좌 귀속(어느 탭·보유행에 속하는지)은 이 모듈의 책임이 아니다 — v1에서도 파싱 함수
// 자체는 계좌를 모르고, 호출부가 보유종목 조회와 조인해서 계좌를 알아냈다. v2에서는 그
// 조인이 State/Holdings 설계(구현계획서 Phase 8·9)가 끝난 뒤의 일이라, 이 모듈이 반환
// 하는 이벤트에는 계좌 필드가 없다.

// 시트 셀값("296,000")·숫자(984832) → 숫자 문자열만 남긴다(콤마 등 제거).
export const cleanNum = (s, allowDot = false) =>
  String(s ?? '').replace(allowDot ? /[^0-9.]/g : /[^0-9]/g, '');

// "2026-05-04 9:20:42" → "2026-05-04 09:20:42" (leading-zero 생략 보정)
export function normalizeDateTime(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) return String(raw ?? '').trim();
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])} ${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}

// ── 체결 파서 (증권사별 정규식) ───────────────────────
// ⚠️ 계좌번호 캡처(2026-08-13) — account-resolver.mjs 기존 주석은 "체결 알림 원문
// 자체에 계좌번호가 없다"고 명시했었는데(2026-08-05 확인 당시엔 한국투자증권 계좌가
// IRP 하나뿐이라 아쉬울 이유가 없어서 안 찾아봤을 뿐), 오너가 실제 알림 원문을 다시
// 붙여준 걸 보니 한국투자증권 체결안내엔 "*계좌번호:43****82-29" 형태로 계좌번호가
// 그대로 있었다 — 그 가정이 틀렸다. 지금 한국투자증권이 IRP·퀀트 두 계좌를 다 호스팅
// 하게 되면서 증권사명만으로는 더 이상 유일하게 안 풀리므로(NH의 ISA/위탁 문제와
// 같은 클래스), 이 계좌번호를 뽑아 account-resolver.mjs가 우선 사용하게 한다.
const TRADE_PATTERNS = [
  { broker: 'NH투자증권', overseas: false,
    re: /\[NH투자증권\][\s\S]*?종\s*목\s*명\s*:\s*(?<stockName>[^\n\r]+)[\s\S]*?종목코드\s*:\s*(?<stockCode>[A-Za-z0-9]{6})[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결단가\s*:\s*(?<price>[\d,]+)\s*원/ },
  { broker: 'NH투자증권 해외', overseas: true,
    re: /\[NH투자증권\]\s*해외주식[\s\S]*?종목명\s*:\s*\((?<stockCode>[A-Z0-9]+)\s+[A-Z]+\)(?<stockName>[^\n\r]+)[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결가격\s*:\s*(?<price>[\d.]+)/ },
  { broker: '삼성증권', overseas: false,
    re: /\[삼성증권\]<주식체결안내>[\n\r]+[^\n\r]+[\n\r]+(?<stockName>[^\n\r]+)[\n\r]+(?:매수|매도)(?<quantity>[\d,]+)주\s+(?<price>[\d,]+)원/ },
  { broker: '한국투자증권', overseas: false,
    // 계좌번호 캡처는 선택(?)로 둔다 — 실측으로는 항상 있지만, 혹시 형식이 다른
    // 변종 알림에서 없다고 해서 체결 자체를 통째로 놓치면(파싱 실패) 계좌번호 하나 더
    // 아는 것보다 훨씬 나쁘다(체결 자체가 기록에서 빠짐).
    re: /\[한국투자증권 체결안내\][\s\S]*?(?:계좌번호\s*:\s*(?<acctNo>[0-9*\-]+)[\s\S]*?)?종목명\s*:\s*(?<stockName>[^(\n\r]+?)\s*\((?<stockCode>[A-Za-z0-9]{6})\)[\s\S]*?체결수량\s*:\s*(?<quantity>[\d,]+)\s*주[\s\S]*?체결단가\s*:\s*(?<price>[\d,]+)\s*원/ },
];

export function parseExecution(body, tsRaw) {
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
      broker: p.broker,
      acctNo: g.acctNo?.trim() || '', // 한국투자증권만 현재 캡처(다른 증권사는 빈 문자열)
    };
  }
  return null;
}

// ── 배당 파서 (증권사별 정규식) ───────────────────────
const NH_DIV = /\[NH투자증권\]\s*(?:분배금|배당금)\s*입금\s*안내[\s\S]*?종목명\s*:\s*(?<stockName>[^\n\r]+)[\s\S]*?세후금액\s*:\s*(?<amount>[\d,]+)\s*원[\s\S]*?입금일\s*:\s*(?<date>\d{4}\.\d{2}\.\d{2})/;
const NH_BOND = /\[NH투자증권\]\s*채권원리금\s*입금\s*안내[\n\r]+[^\n\r]*입금\s+(?<month>\d{2})\/(?<day>\d{2})\s+\d{2}:\d{2}\s+(?<amount>[\d,]+)\s+(?<stockName>[^\n\r]+)/;
const SAMSUNG_DIV = /\[삼성증권\]\s*<(?:분배금|배당금)[^>]*>[\s\S]*?종목명\s*:\s*(?<stockName>[^\n\r\-]+)[\s\S]*?세후\s*(?:분배금액|배당금액)\s*:\s*(?<amount>[\d,]+)\s*원/;

export function parseDividend(body, tsRaw) {
  if (!(body.includes('배당금') || body.includes('분배금') || body.includes('채권원리금'))) return null;
  const ts = normalizeDateTime(tsRaw);
  const datePart = ts.slice(0, 10);
  const timePart = ts.slice(11, 19) || '00:00:00';
  const acctRaw = (body.match(/계좌번호\s*:\s*([0-9*\-]+)/)?.[1] ?? '').trim();
  const broker = (body.match(/\[(NH투자증권|삼성증권|한국투자증권)[^\]]*\]/)?.[1] ?? '').trim();
  const mk = (date, amount, stockName) => ({ date, afterTaxAmount: amount, stockName: stockName.trim(), acctRaw, broker, receivedTime: timePart, uniqueKey: `${timePart}_${amount}` });

  let m = body.match(NH_DIV);
  if (m) { const a = parseInt(cleanNum(m.groups.amount), 10); if (Number.isFinite(a)) return mk(m.groups.date.replace(/\./g, '-'), a, m.groups.stockName); }
  m = body.match(NH_BOND);
  if (m) { const a = parseInt(cleanNum(m.groups.amount), 10); if (Number.isFinite(a)) return mk(`${ts.slice(0, 4)}-${m.groups.month}-${m.groups.day}`, a, m.groups.stockName); }
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

export function parseFundBuy(body, tsRaw) {
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

export function parseGoldBuy(body, tsRaw) {
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
const CASH_BALANCE = /출금가능금액\s*:\s*([\d,]+)\s*원/;
const CASH_DEPOSIT_AMOUNT = /(?<!출금가능)금액\s+([\d,]+)\s*원/;

// resolveDepositAnchorBalance: cash-base.mjs가 소유(계좌 회계 로직) — 여기서는 import해
// 그대로 쓴다. 순환 의존 없음(cash-base.mjs는 이 모듈을 import하지 않음).
import { resolveDepositAnchorBalance } from './cash-base.mjs';
// resolveNhAccount/extractNhAccountNo: nh-accounts.mjs가 소유(계좌번호→계좌명 매핑,
// 마스킹된 전체번호 기준) — 2026-08-18 접두사(6자리)만 보던 예전 방식을 교체.
// ISA(209-02-89***2)와 금현물(209-02-92***6)이 접두사를 공유해 실데이터로 오귀속을
// 확인, 전체번호 매칭으로 전환했다(nh-accounts.mjs 헤더 주석 참고).
import { resolveNhAccount, extractNhAccountNo } from './nh-accounts.mjs';

export function parseCashAlarm(body, tsRaw) {
  if (!body.includes('NH투자증권')) return null;
  const isDeposit = body.includes('입금안내');
  if (!(isDeposit || body.includes('출금안내'))) return null;
  const account = resolveNhAccount(body);
  const bm = body.match(CASH_BALANCE);
  if (!account || !bm) return null;
  const withdrawable = parseInt(cleanNum(bm[1]), 10);
  if (!Number.isFinite(withdrawable) || withdrawable < 0) return null;
  let balance = withdrawable;
  if (isDeposit && account === 'ISA') {
    const dm = body.match(CASH_DEPOSIT_AMOUNT);
    const deposit = dm ? parseInt(cleanNum(dm[1]), 10) : NaN;
    balance = resolveDepositAnchorBalance(withdrawable, deposit);
  }
  if (!Number.isFinite(balance) || balance < 0) return null;
  return { account, acctNo: extractNhAccountNo(body), balance, ts: normalizeDateTime(tsRaw) };
}

// ── 환전 파서 (NH투자증권 "환전내역 안내") ────────────
const EXCH_DATE = /환전일자\s*:\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const EXCH_KIND = /환전구분\s*:\s*(외화매수|외화매도)/;
const EXCH_CCY = /통화명\s*:\s*([A-Za-z]+)/;
const EXCH_USD = /외화금액\s*:\s*USD\s*([\d,]+(?:\.\d+)?)/;
const EXCH_WON = /원화금액\s*:\s*([\d,]+)/;

export function parseExchange(body, tsRaw) {
  if (!(body.includes('환전내역') && body.includes('환전구분'))) return null;
  const km = body.match(EXCH_KIND);
  const um = body.match(EXCH_USD);
  if (!km || !um) return null;
  const cm = body.match(EXCH_CCY);
  if (cm && cm[1].toUpperCase() !== 'USD') return null;
  const usd = parseFloat(cleanNum(um[1], true));
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const wm = body.match(EXCH_WON);
  const won = wm ? parseInt(cleanNum(wm[1]), 10) : null;
  const ts = normalizeDateTime(tsRaw);
  const dm = body.match(EXCH_DATE);
  const p = (n) => String(n).padStart(2, '0');
  const date = dm ? `${ts.slice(0, 4)}-${p(dm[1])}-${p(dm[2])}` : ts.slice(0, 10);
  return { kind: km[1], usd, won: Number.isFinite(won) && won > 0 ? won : null, date };
}
