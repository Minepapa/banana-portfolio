/**
 * 포트폴리오 KPI 계산기 — TWR / Sharpe / MDD
 *
 * 데이터: 시트 [월별잔고]
 *   A: 연도  B: 월  C: 그 달 신규 입금(저축금, 최소 0)  D: ISA  E: 위탁  F: 연금저축  G: IRP  H: 총잔고
 *   I: KOSPI 월말 지수  J: S&P500 월말 지수 (벤치마크 TWR/알파 산출용)
 *
 * 월간 입금 = C[i]  (C열은 누적이 아니라 "그 달에 새로 들어간 투자금")
 *
 * 사용법:
 *   node scripts/kpi-calc.mjs                  # 자동 OAuth + 콘솔 출력
 *   node scripts/kpi-calc.mjs <TOKEN>
 *
 * 출력: 마크다운 표 (profile/kpi_baseline.md (banana) §2-§4의 TODO 영역에 복사)
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const REDIRECT  = 'http://localhost:8085/callback';
const AUTH_TIMEOUT_MS = 120_000;

// 무위험 수익률 (연) — 한국 국고채 3년물 근사
const RISK_FREE_ANNUAL = 0.035;
const RISK_FREE_MONTHLY = RISK_FREE_ANNUAL / 12;

// ── OAuth (기존 setup-*.mjs 동일 패턴) ──────────────────────────────────────
function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body><p>인증 처리 중...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  if (t) fetch('/token', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token:t}) })
    .then(() => document.body.innerHTML = '<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>');
  else document.body.innerHTML = '<h2 style="color:red">⚠️ 토큰 실패</h2>';
</script></body></html>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body);
            res.writeHead(200); res.end('ok');
            server.close(); clearTimeout(timer); resolve(token);
          } catch (e) {
            res.writeHead(400); res.end('bad');
            reject(new Error('토큰 파싱 실패: ' + e.message));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });

    const timer = setTimeout(() => { server.close(); reject(new Error('OAuth 타임아웃')); }, AUTH_TIMEOUT_MS);

    server.listen(8085, () => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token&scope=${encodeURIComponent(SCOPE)}`;
      console.log('\n브라우저에서 Google 로그인 창을 엽니다...');
      console.log('자동으로 안 열리면 복사:\n' + url + '\n');
      exec(`open "${url}"`);
    });

    server.on('error', e => {
      clearTimeout(timer);
      if (e.code === 'EADDRINUSE') reject(new Error('포트 8085 사용 중. 토큰 직접 전달: node scripts/kpi-calc.mjs <TOKEN>'));
      else reject(e);
    });
  });
}

async function getRange(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${res.status} ${await res.text()}`);
  return res.json();
}

// ── 데이터 파싱 ──────────────────────────────────────────────────────────────
const parseNum = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
const parseInt2 = (v) => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);

function parseMonthlyBalance(values) {
  // values: 월별잔고!A2:J 의 원시 row 배열
  let lastYear = 0;
  const out = [];
  (values || []).forEach(r => {
    const y = parseInt2(r[0]);
    if (y >= 2000) lastYear = y;
    const m = parseInt2(r[1]);
    const savings = parseNum(r[2]);
    const isa = parseNum(r[3]);
    const wita = parseNum(r[4]);
    const pen  = parseNum(r[5]);
    const irp  = parseNum(r[6]);
    const total = parseNum(r[7]);
    const kospi = parseNum(r[8]);
    const sp500 = parseNum(r[9]);
    if (!m || !lastYear || !total) return;
    out.push({
      year: lastYear, month: m,
      ym: lastYear * 100 + m,
      savings, isa, wita, pen, irp, total, kospi, sp500,
      label: `${String(lastYear).slice(-2)}.${String(m).padStart(2, '0')}`,
    });
  });
  out.sort((a, b) => a.ym - b.ym);
  return out;
}

// ── KPI 계산 ────────────────────────────────────────────────────────────────
// 월별 수익률 r_i = (total_i − total_{i-1} − 입금_i) / total_{i-1}
// 입금_i는 C열(저축금) 값 그대로 — C열은 그 달 신규 입금, 누적 아님, 최소 0.
function monthlyReturns(series) {
  const rs = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev.total <= 0) { rs.push(null); continue; }
    const inflow = Math.max(0, cur.savings);  // 안전 가드: 음수면 0
    const r = (cur.total - prev.total - inflow) / prev.total;
    rs.push({ ...cur, r, inflow, prevTotal: prev.total, prevLabel: prev.label });
  }
  return rs.filter(x => x && Number.isFinite(x.r));
}

function twr(returns) {
  // TWR = ∏(1 + r_i) − 1
  if (!returns.length) return null;
  return returns.reduce((acc, x) => acc * (1 + x.r), 1) - 1;
}

function cagr(twrVal, months) {
  if (twrVal == null || months <= 0) return null;
  return Math.pow(1 + twrVal, 12 / months) - 1;
}

function sharpe(returns) {
  if (returns.length < 2) return null;
  const rs = returns.map(x => x.r);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rs.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return ((mean - RISK_FREE_MONTHLY) / std) * Math.sqrt(12);
}

function mdd(returns) {
  // 잔고가 아닌 누적 TWR(수익) 곡선 기준 최대낙폭. 매달 신규 입금으로 잔고가 계속
  // 오르면 잔고 MDD는 항상 ~0%가 되므로, 입금 효과를 제거한 투자성과 낙폭을 측정한다.
  if (!returns || returns.length < 1) {
    return { mdd: null, peakLabel: null, troughLabel: null, recoveryMonths: null, recoveryLabel: null };
  }
  // equity curve: 첫 수익률 직전을 1.0 으로 두고 월수익률을 누적 곱.
  const curve = [{ value: 1, label: returns[0].prevLabel ?? returns[0].label }];
  let equity = 1;
  for (const x of returns) { equity *= (1 + x.r); curve.push({ value: equity, label: x.label }); }

  let peak = curve[0].value, peakIdx = 0;
  let worst = 0, worstPeakIdx = 0, worstTroughIdx = 0;
  curve.forEach((p, i) => {
    if (p.value > peak) { peak = p.value; peakIdx = i; }
    const dd = (p.value - peak) / peak;
    if (dd < worst) { worst = dd; worstPeakIdx = peakIdx; worstTroughIdx = i; }
  });
  if (worst === 0) return { mdd: 0, peakLabel: null, troughLabel: null, recoveryMonths: null, recoveryLabel: null };

  // 회복: trough 이후 직전 peak 재도달(회복) 시점
  const recoveryTarget = curve[worstPeakIdx].value;
  let recoveryIdx = -1;
  for (let i = worstTroughIdx + 1; i < curve.length; i++) {
    if (curve[i].value >= recoveryTarget) { recoveryIdx = i; break; }
  }
  return {
    mdd: worst,
    peakLabel: curve[worstPeakIdx]?.label,
    troughLabel: curve[worstTroughIdx]?.label,
    recoveryMonths: recoveryIdx >= 0 ? (recoveryIdx - worstTroughIdx) : null,
    recoveryLabel: recoveryIdx >= 0 ? curve[recoveryIdx].label : null,
  };
}

function sliceByMonths(series, lastN) {
  if (series.length <= lastN) return series;
  return series.slice(series.length - lastN);
}

function sliceYTD(series) {
  if (!series.length) return [];
  const lastYear = series[series.length - 1].year;
  // YTD = 전년 12월 + 올해 1~현재월 (전년 12월을 시작점으로 잡아 연초 효과 반영)
  const start = series.findIndex(p => p.year === lastYear - 1 && p.month === 12);
  const yEarliest = series.findIndex(p => p.year === lastYear);
  const startIdx = start >= 0 ? start : (yEarliest >= 0 ? yEarliest : 0);
  return series.slice(startIdx);
}

// ── 출력 포맷터 ──────────────────────────────────────────────────────────────
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const ratio = (v) => v == null ? '—' : v.toFixed(2);
const krw = (v) => v == null ? '—' : `₩${Math.round(v).toLocaleString('ko-KR')}`;

// 벤치마크 TWR: KOSPI 50% + S&P500 50% 블렌드 (metrics.js와 동일 로직)
function benchmarkTWR(series) {
  const bmReturns = [];
  for (let i = 1; i < series.length; i++) {
    const pk = series[i - 1].kospi, ck = series[i].kospi;
    const ps = series[i - 1].sp500, cs = series[i].sp500;
    if (pk > 0 && ck > 0 && ps > 0 && cs > 0) {
      bmReturns.push(0.5 * (ck / pk - 1) + 0.5 * (cs / ps - 1));
    }
  }
  if (bmReturns.length < 2) return null;
  const bmCum = bmReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  return { cum: bmCum, ann: Math.pow(1 + bmCum, 12 / bmReturns.length) - 1, months: bmReturns.length };
}

function reportWindow(label, series) {
  const returns = monthlyReturns(series);
  const twrV = twr(returns);
  const months = returns.length;
  const cagrV = cagr(twrV, months);
  const sharpeV = sharpe(returns);
  const m = mdd(returns);
  const bm = benchmarkTWR(series);
  return { label, months, twr: twrV, cagr: cagrV, sharpe: sharpeV, mdd: m, benchmark: bm, series };
}

function printSection(title, win) {
  console.log(`\n### ${title}`);
  console.log(`구간: ${win.series[0]?.label} → ${win.series[win.series.length - 1]?.label} (${win.months}개월 수익률 산정)`);
  console.log(`- TWR (누적):   ${pct(win.twr)}`);
  console.log(`- CAGR (연환산): ${pct(win.cagr)}`);
  if (win.benchmark) {
    console.log(`- 벤치마크 TWR: ${pct(win.benchmark.cum)}  (KOSPI50+SP50, ${win.benchmark.months}M)`);
    const alpha = win.cagr != null ? win.cagr - win.benchmark.ann : null;
    console.log(`- 알파:         ${alpha != null ? (alpha >= 0 ? '+' : '') + (alpha * 100).toFixed(2) + '%p' : '—'}`);
  } else {
    console.log(`- 벤치마크:     — (I/J열 데이터 부족)`);
  }
  console.log(`- 샤프:         ${ratio(win.sharpe)}`);
  console.log(`- MDD:          ${pct(win.mdd.mdd)}` + (win.mdd.peakLabel ? `  (${win.mdd.peakLabel} → ${win.mdd.troughLabel})` : ''));
  if (win.mdd.recoveryMonths != null) console.log(`  회복: ${win.mdd.recoveryMonths}개월 (→ ${win.mdd.recoveryLabel})`);
  else if (win.mdd.troughLabel) console.log(`  회복: 미회복 (현재 기준)`);
}

function markdownTable(rows) {
  const hdr = '| 시간대 | 기간 | TWR (누적) | CAGR | 벤치마크 | 알파 | 샤프 | MDD | 회복 |';
  const sep = '|--------|------|-----------|------|---------|------|------|-----|------|';
  const body = rows.map(w => {
    const periodLabel = w.series.length > 0
      ? `${w.series[0].label} → ${w.series[w.series.length - 1].label}`
      : '—';
    const bmCell = w.benchmark ? pct(w.benchmark.cum) : '—';
    const alphaVal = w.benchmark && w.cagr != null ? w.cagr - w.benchmark.ann : null;
    const alphaCell = alphaVal != null ? `${alphaVal >= 0 ? '+' : ''}${(alphaVal * 100).toFixed(1)}%p` : '—';
    const mddCell = w.mdd.mdd == null
      ? '—'
      : `${pct(w.mdd.mdd)}` + (w.mdd.peakLabel ? ` (${w.mdd.peakLabel}→${w.mdd.troughLabel})` : '');
    const recCell = w.mdd.recoveryMonths != null
      ? `${w.mdd.recoveryMonths}개월`
      : w.mdd.troughLabel ? '미회복' : '—';
    return `| ${w.label} | ${periodLabel} | ${pct(w.twr)} | ${pct(w.cagr)} | ${bmCell} | ${alphaCell} | ${ratio(w.sharpe)} | ${mddCell} | ${recCell} |`;
  });
  return [hdr, sep, ...body].join('\n');
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  let token = args[0]?.trim();
  if (token) {
    console.log('✓ 토큰 인수 사용');
  } else {
    console.log('OAuth 로그인으로 토큰 취득...');
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득\n');
  }

  console.log('1. 월별잔고 데이터 조회...');
  const resp = await getRange(token, '월별잔고!A2:J');
  const values = resp.values ?? [];
  const series = parseMonthlyBalance(values);

  if (series.length < 2) {
    console.error(`❌ 월별잔고 데이터 부족: ${series.length}개월`);
    console.error('   최소 2개월 이상 필요. 시트 [월별잔고] 탭을 확인하세요.');
    process.exit(1);
  }
  console.log(`   ✓ ${series.length}개월 데이터 (${series[0].label} → ${series[series.length - 1].label})\n`);

  // 윈도우별 KPI
  const winTotal = reportWindow('전체',  series);
  const win3Y    = reportWindow('3년',   sliceByMonths(series, 36 + 1));   // +1 for return base
  const win1Y    = reportWindow('1년',   sliceByMonths(series, 12 + 1));
  const winYTD   = reportWindow('YTD',   sliceYTD(series));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 포트폴리오 KPI 베이스라인');
  console.log(`기준일: ${series[series.length - 1].label}  ·  무위험 r_f: ${(RISK_FREE_ANNUAL * 100).toFixed(1)}% (연)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  printSection('YTD', winYTD);
  printSection('1년', win1Y);
  printSection('3년', win3Y);
  printSection('전체', winTotal);

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Markdown 표 (kpi_baseline.md 복사용)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(markdownTable([winYTD, win1Y, win3Y, winTotal]));

  // 최근 6개월 미리보기
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 최근 6개월 월별 수익률');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const recent = monthlyReturns(sliceByMonths(series, 7));
  console.log('| 월 | 시작잔고 | 입금 | 종료잔고 | 월수익률 |');
  console.log('|----|---------|------|---------|---------|');
  recent.forEach(x => {
    console.log(`| ${x.label} | ${krw(x.prevTotal)} | ${krw(x.inflow)} | ${krw(x.total)} | ${pct(x.r)} |`);
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 완료. profile/kpi_baseline.md (banana) §2~§4 TODO 영역에 위 표를 복사하세요.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => {
  console.error('\n❌ 오류:', e.message);
  if (e.message.includes('401')) console.error('  토큰 만료 또는 권한 부족. 재시도하세요.');
  process.exit(1);
});
