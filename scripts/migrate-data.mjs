/**
 * Banana 탭 → 새 탭 구조 데이터 이전 스크립트
 *
 * 사용법: node scripts/migrate-data.mjs
 *
 * 이전 항목:
 *   - 종목 (ISA / 위탁 / 연금저축 / IRP) — 수식 포함
 *   - 리밸런싱 (목표비율 / 현재비율 / 리밸런싱금액)
 *   - 월별잔고
 *   - 배당금 (2025+2026 통합, 날짜 정렬)
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID  = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID   = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT   = 'http://localhost:8085/callback';

// ── OAuth (setup-sheets.mjs 와 동일) ─────────────────────────────────────────
function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body><p>인증 처리 중...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  if (t) {
    fetch('/token', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})
      .then(()=>{ document.body.innerHTML='<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>'; });
  } else {
    document.body.innerHTML='<h2 style="font-family:sans-serif;color:red">⚠️ 토큰 없음</h2>';
  }
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
            server.close(); clearTimeout(timer);
            resolve(token);
          } catch (e) { res.writeHead(400); res.end(); reject(e); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });

    const timer = setTimeout(() => { server.close(); reject(new Error('OAuth 타임아웃')); }, 120_000);

    server.listen(8085, () => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token&scope=${encodeURIComponent(SCOPE)}`;
      console.log('\n브라우저에서 Google 로그인 창을 엽니다...');
      console.log('자동으로 열리지 않으면 아래 URL을 브라우저에 붙여넣으세요:\n' + url + '\n');
      exec(`open "${url}"`);
    });
    server.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Sheets API 래퍼 ──────────────────────────────────────────────────────────
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function readRange(token, range, renderOption = 'FORMULA') {
  const url = `${BASE}/values/${encodeURIComponent(range)}?valueRenderOption=${renderOption}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`읽기 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values ?? [];
}

async function batchWrite(token, data) {
  const res = await fetch(`${BASE}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!res.ok) throw new Error(`쓰기 실패: ${await res.text()}`);
}

// ── 이전 로직 ─────────────────────────────────────────────────────────────────
async function migrate(token) {
  const writes = [];

  // ── 1. 종목 이전 ─────────────────────────────────────────────────────────
  console.log('\n1. 종목 데이터 이전 중...');
  const holdingMap = [
    { tab: 'ISA',    src: 'Banana!K6:S10'  },
    { tab: '위탁',   src: 'Banana!K14:S39' },
    { tab: '연금저축', src: 'Banana!K43:S64' },
    { tab: 'IRP',   src: 'Banana!K68:S69' },
  ];

  for (const { tab, src } of holdingMap) {
    const rows = await readRange(token, src, 'FORMULA');
    // 종목명(L=index 1) 이 있는 행만 유지
    const valid = rows.filter(r => String(r[1] ?? '').trim());
    if (!valid.length) { console.log(`   - ${tab}: 데이터 없음 (건너뜀)`); continue; }

    const transformed = valid.map((r, i) => {
      const newRow = 2 + i;  // 헤더가 row 1, 데이터 row 2부터
      // K→A(자산군), L→B(종목명), M→C(매수단가), N→D(수량), O→E(투자금)
      // P→F(현재가), Q→G(수익손실), R→H(평가금), S→I(수익률)
      let 현재가 = r[5] ?? '';
      if (typeof 현재가 === 'string') {
        현재가 = 현재가.replace(/\*I37\b/g, '*설정!B2');  // 환율 셀 재참조
      }
      return [
        r[0] ?? '',                   // A: 자산군
        r[1] ?? '',                   // B: 종목명
        r[2] ?? '',                   // C: 매수단가
        r[3] ?? '',                   // D: 수량
        `=C${newRow}*D${newRow}`,     // E: 투자금 (수식)
        현재가,                        // F: 현재가 (수식 변환 포함)
        `=H${newRow}-E${newRow}`,     // G: 수익손실
        `=D${newRow}*F${newRow}`,     // H: 평가금
        `=H${newRow}/E${newRow}-1`,   // I: 수익률
      ];
    });

    writes.push({ range: `${tab}!A2:I${1 + transformed.length}`, values: transformed });
    console.log(`   ✓ ${tab}: ${transformed.length}개 종목`);
  }

  // ── 2. 리밸런싱 이전 ─────────────────────────────────────────────────────
  console.log('\n2. 리밸런싱 데이터 이전 중...');
  const ASSET_7 = ['채권', '금', '달러', '배당주', '리츠', '국내주식', '해외주식'];
  const rebalSrc = [
    { label: '[ 위탁 ]',    목표: 'Banana!C11:C17', 현재: 'Banana!F11:F17', 리밸: 'Banana!G11:G17', labelRow: 2,  dataStart: 3  },
    { label: '[ 연금저축 ]', 목표: 'Banana!C23:C29', 현재: 'Banana!F23:F29', 리밸: 'Banana!G23:G29', labelRow: 11, dataStart: 12 },
    { label: '[ ISA ]',     목표: 'Banana!C6:C6',   현재: 'Banana!F6:F6',   리밸: 'Banana!G6:G6',   labelRow: 20, dataStart: 21 },
    { label: '[ IRP ]',     목표: 'Banana!C35:C35', 현재: 'Banana!F35:F35', 리밸: 'Banana!G35:G35', labelRow: 23, dataStart: 24 },
  ];

  for (const { label, 목표, 현재, 리밸, labelRow, dataStart } of rebalSrc) {
    const [tVals, cVals, rVals] = await Promise.all([
      readRange(token, 목표, 'FORMATTED_VALUE'),
      readRange(token, 현재, 'FORMATTED_VALUE'),
      readRange(token, 리밸, 'FORMATTED_VALUE'),
    ]);
    const count = Math.max(tVals.length, cVals.length, rVals.length);
    // 레이블 행
    writes.push({ range: `리밸런싱!A${labelRow}:A${labelRow}`, values: [[label]] });
    // 자산군 이름
    const assetNames = label === '[ ISA ]' ? [['배당주']] : label === '[ IRP ]' ? [['TDF']] : ASSET_7.slice(0, count).map(n => [n]);
    writes.push({ range: `리밸런싱!A${dataStart}:A${dataStart + count - 1}`, values: assetNames });
    // 데이터 (B~D)
    const rows = Array.from({ length: count }, (_, i) => [
      tVals[i]?.[0] ?? '',
      cVals[i]?.[0] ?? '',
      rVals[i]?.[0] ?? '',
    ]);
    writes.push({ range: `리밸런싱!B${dataStart}:D${dataStart + count - 1}`, values: rows });
  }
  console.log('   ✓ 리밸런싱 완료');

  // ── 3. 월별잔고 이전 ─────────────────────────────────────────────────────
  console.log('\n3. 월별잔고 이전 중...');
  const monthly = await readRange(token, 'Banana!B43:I89', 'FORMATTED_VALUE');
  // 총잔고(index 7)가 있는 행만
  const validMonthly = monthly.filter(r => String(r[7] ?? '').trim());
  if (validMonthly.length) {
    writes.push({ range: `월별잔고!A2:H${1 + validMonthly.length}`, values: validMonthly });
    console.log(`   ✓ 월별잔고: ${validMonthly.length}개 행`);
  } else {
    console.log('   - 월별잔고: 데이터 없음 (건너뜀)');
  }

  // ── 4. 배당금 이전 (2025+2026 통합 → 날짜 정렬) ─────────────────────────
  console.log('\n4. 배당금 이전 중...');
  const [div2025, div2026] = await Promise.all([
    readRange(token, 'Banana!U5:W78', 'FORMATTED_VALUE'),
    readRange(token, 'Banana!Y5:AA78', 'FORMATTED_VALUE'),
  ]);

  const allDivs = [];
  for (const rows of [div2025, div2026]) {
    for (const r of rows) {
      const date = String(r[0] ?? '').trim();
      const name = String(r[1] ?? '').trim();  // V 또는 Z: 종목명
      const amt  = r[2] ?? '';                 // W 또는 AA: 배당금
      if (date && amt) allDivs.push([date, amt, name]);
    }
  }
  allDivs.sort((a, b) => a[0].localeCompare(b[0]));  // YYYY-MM-DD 문자열 정렬

  if (allDivs.length) {
    writes.push({ range: `배당금!A2:C${1 + allDivs.length}`, values: allDivs });
    console.log(`   ✓ 배당금: ${allDivs.length}개 항목 (2025+2026 통합, 종목명 포함)`);
  } else {
    console.log('   - 배당금: 데이터 없음 (건너뜀)');
  }

  // ── 일괄 쓰기 ────────────────────────────────────────────────────────────
  console.log('\n데이터 쓰는 중...');
  if (writes.length) {
    await batchWrite(token, writes);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 데이터 이전 완료!');
  console.log('  앱에서 새 탭 구조로 동기화 확인하세요.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
async function main() {
  let token = process.argv[2]?.trim();
  if (token) {
    console.log('✓ 토큰을 인수로 받아 사용합니다.');
  } else {
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득 성공');
  }
  await migrate(token);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
