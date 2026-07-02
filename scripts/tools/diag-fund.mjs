// 읽기 전용 진단: 연금저축 VIP펀드 행 현재값 vs 알람 기반 파서 재계산값 비교.
// 시트 쓰기 없음. `node scripts/tools/diag-fund.mjs`
import { getToken, getRange } from '../lib/sheets-common.mjs';

const FUND_FUNDNAME = /펀드명\s*:\s*([^\n\r]+)/;
const FUND_AMOUNT = /매수금액\s*:\s*([\d,]+)\s*원/;
const FUND_NAV = /매수기준가\s*:\s*([\d,]+(?:\.\d+)?)/;
const FUND_DATE = /매수신청일\s*:\s*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const cleanNum = (s, dec = false) => String(s).replace(/,/g, '').replace(dec ? /[^\d.]/g : /[^\d]/g, '');

function parseFundBuy(body) {
  if (!(body.includes('펀드') && body.includes('매수기준가'))) return null;
  const fm = body.match(FUND_FUNDNAME), am = body.match(FUND_AMOUNT), nm = body.match(FUND_NAV);
  if (!fm || !am || !nm) return null;
  const amount = parseInt(cleanNum(am[1]), 10);
  const nav = parseFloat(cleanNum(nm[1], true));
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(nav) || nav <= 0) return null;
  const dm = body.match(FUND_DATE);
  const p = (n) => String(n).padStart(2, '0');
  const date = dm ? `${dm[1]}-${p(dm[2])}-${p(dm[3])}` : '(날짜없음)';
  return { fundName: fm[1].trim(), amount, nav, date, units: (amount / nav) * 1000 };
}

const token = await getToken();

// 1) 연금저축 현재 펀드 행
const rows = await getRange(token, '연금저축!A1:I30');
console.log('\n=== 연금저축 시트 (펀드 행 탐색) ===');
rows.forEach((r, i) => {
  const name = String(r[1] ?? '');
  if (/VIP|가치투자|펀드/.test(name) || (i + 1) === 15) {
    console.log(`행${i + 1}: B=${name} | C(기준가)=${r[2]} | D(좌수)=${r[3]} | E(투자금)=${r[4]} | F(현재가)=${r[5]} | H(평가금)=${r[7]} | I(수익률)=${r[8]}`);
  }
});

// 2) 알람의 펀드 매수 알림 전수
const alarm = await getRange(token, '알람!A2:D');
const funds = [];
for (const r of alarm) { const f = parseFundBuy(String(r[3] ?? '')); if (f) funds.push(f); }
const dedup = new Map();
for (const f of funds) dedup.set(`${f.fundName}|${f.date}|${f.amount}|${f.nav}`, f);
const recs = [...dedup.values()].sort((a, b) => a.date.localeCompare(b.date));

console.log(`\n=== 알람 내 펀드 매수 알림: 원본 ${funds.length}건 · dedup ${recs.length}건 ===`);
recs.forEach(r => console.log(`  ${r.date} | ${r.amount.toLocaleString()}원 @ ${r.nav} → ${Math.round(r.units).toLocaleString()}좌`));

const 누적투자금 = recs.reduce((s, r) => s + r.amount, 0);
const 누적좌수 = Math.round(recs.reduce((s, r) => s + r.units, 0));
console.log(`\n=== 파서가 덮어쓸 값 (알람 기반 재계산) ===`);
console.log(`  누적좌수 = ${누적좌수.toLocaleString()} · 누적투자금 = ${누적투자금.toLocaleString()}원`);
console.log(`\n※ 이 값이 시트 현재 D/E보다 작으면 = 알람 프루닝으로 과거 적립분이 유실된 것(덮어쓰면 포지션 축소).`);
