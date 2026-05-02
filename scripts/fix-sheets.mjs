/**
 * 시트 데이터 수정 스크립트 (1회성)
 *
 * 수정 내용:
 *   1. ISA/위탁/연금저축/IRP  E열: 투자금 수식 =C*D 로 재생성
 *   2. 리밸런싱  계좌명 레이블 행 추가 + 데이터 행 재배치
 *   3. 배당금  C열 종목명 추가 (Banana V/Z 컬럼에서 읽음)
 *
 * 사용법: node scripts/fix-sheets.mjs
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT  = 'http://localhost:8085/callback';

// ── OAuth ────────────────────────────────────────────────────────────────────
function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body><p>인증 처리 중...</p>
<script>
  const p=new URLSearchParams(location.hash.slice(1));const t=p.get('access_token');
  if(t){fetch('/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})
    .then(()=>{document.body.innerHTML='<h2 style="font-family:sans-serif">✅ 인증 완료! 창 닫으세요.</h2>';});}
  else{document.body.innerHTML='<h2 style="color:red">⚠️ 토큰 없음</h2>';}
</script></body></html>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        let b = '';
        req.on('data', c => (b += c));
        req.on('end', () => {
          try { const { token } = JSON.parse(b); res.writeHead(200); res.end(); server.close(); clearTimeout(timer); resolve(token); }
          catch (e) { res.writeHead(400); res.end(); reject(e); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('OAuth 타임아웃')); }, 120_000);
    server.listen(8085, () => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token&scope=${encodeURIComponent(SCOPE)}`;
      console.log('\n브라우저 로그인 창을 엽니다... (자동으로 열리지 않으면 아래 URL 사용)\n' + url + '\n');
      exec(`open "${url}"`);
    });
    server.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Sheets API ───────────────────────────────────────────────────────────────
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function readRange(token, range, render = 'FORMULA') {
  const res = await fetch(`${BASE}/values/${encodeURIComponent(range)}?valueRenderOption=${render}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`읽기 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values ?? [];
}

async function batchClear(token, ranges) {
  const res = await fetch(`${BASE}/values:batchClear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ranges }),
  });
  if (!res.ok) throw new Error(`클리어 실패: ${await res.text()}`);
}

async function batchWrite(token, data) {
  const res = await fetch(`${BASE}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!res.ok) throw new Error(`쓰기 실패: ${await res.text()}`);
}

// ── 수정 로직 ─────────────────────────────────────────────────────────────────
async function fix(token) {
  const writes = [];

  // ── 1. 계좌 탭 E열: =C*D 수식으로 재생성 ────────────────────────────────
  console.log('1. 계좌 탭 E열 수식 수정 중...');
  const holdingMap = [
    { tab: 'ISA',    src: 'Banana!K6:S10'  },
    { tab: '위탁',   src: 'Banana!K14:S39' },
    { tab: '연금저축', src: 'Banana!K43:S64' },
    { tab: 'IRP',   src: 'Banana!K68:S69' },
  ];

  const clearRanges = holdingMap.map(({ tab }) => `${tab}!A2:I1000`);
  await batchClear(token, clearRanges);

  for (const { tab, src } of holdingMap) {
    const rows = await readRange(token, src, 'FORMULA');
    const valid = rows.filter(r => String(r[1] ?? '').trim());
    if (!valid.length) { console.log(`   - ${tab}: 데이터 없음`); continue; }

    const transformed = valid.map((r, i) => {
      const row = 2 + i;
      let 현재가 = r[5] ?? '';
      if (typeof 현재가 === 'string') 현재가 = 현재가.replace(/\*I37\b/g, '*설정!B2');
      return [
        r[0] ?? '',             // A: 자산군
        r[1] ?? '',             // B: 종목명
        r[2] ?? '',             // C: 매수단가
        r[3] ?? '',             // D: 수량
        `=C${row}*D${row}`,     // E: 투자금 (수식)
        현재가,                  // F: 현재가
        `=H${row}-E${row}`,     // G: 수익손실
        `=D${row}*F${row}`,     // H: 평가금
        `=H${row}/E${row}-1`,   // I: 수익률
      ];
    });

    writes.push({ range: `${tab}!A2:I${1 + transformed.length}`, values: transformed });
    console.log(`   ✓ ${tab}: ${transformed.length}개 종목`);
  }

  // ── 2. 리밸런싱: 계좌 레이블 행 추가 ────────────────────────────────────
  // 새 구조:
  //   Row 1  : 헤더
  //   Row 2  : [ 위탁 ] 레이블
  //   Row 3-9: 위탁 데이터 (7행)
  //   Row 10 : 빈 줄
  //   Row 11 : [ 연금저축 ] 레이블
  //   Row 12-18: 연금저축 데이터 (7행)
  //   Row 19 : 빈 줄
  //   Row 20 : [ ISA ] 레이블
  //   Row 21 : ISA 데이터
  //   Row 22 : 빈 줄
  //   Row 23 : [ IRP ] 레이블
  //   Row 24 : IRP 데이터
  console.log('\n2. 리밸런싱 탭 재구성 중...');

  const rebalSrc = [
    { label: '[ 위탁 ]',    목표: 'Banana!C11:C17', 현재: 'Banana!F11:F17', 리밸: 'Banana!G11:G17', dataStart: 3  },
    { label: '[ 연금저축 ]', 목표: 'Banana!C23:C29', 현재: 'Banana!F23:F29', 리밸: 'Banana!G23:G29', dataStart: 12 },
    { label: '[ ISA ]',     목표: 'Banana!C6:C6',   현재: 'Banana!F6:F6',   리밸: 'Banana!G6:G6',   dataStart: 21 },
    { label: '[ IRP ]',     목표: 'Banana!C35:C35', 현재: 'Banana!F35:F35', 리밸: 'Banana!G35:G35', dataStart: 24 },
  ];

  const ASSET_7 = ['채권', '금', '달러', '배당주', '리츠', '국내주식', '해외주식'];

  await batchClear(token, ['리밸런싱!A2:D30']);

  for (const { label, 목표, 현재, 리밸, dataStart } of rebalSrc) {
    const [tVals, cVals, rVals] = await Promise.all([
      readRange(token, 목표, 'FORMATTED_VALUE'),
      readRange(token, 현재, 'FORMATTED_VALUE'),
      readRange(token, 리밸, 'FORMATTED_VALUE'),
    ]);
    const count = Math.max(tVals.length, cVals.length, rVals.length);

    // 레이블 행
    writes.push({ range: `리밸런싱!A${dataStart - 1}:A${dataStart - 1}`, values: [[label]] });

    // 데이터 행
    const dataRows = Array.from({ length: count }, (_, i) => [
      tVals[i]?.[0] ?? '',
      cVals[i]?.[0] ?? '',
      rVals[i]?.[0] ?? '',
    ]);
    writes.push({ range: `리밸런싱!B${dataStart}:D${dataStart + count - 1}`, values: dataRows });

    // 자산군 이름 재기입 (A열)
    if (label === '[ ISA ]') {
      writes.push({ range: `리밸런싱!A${dataStart}:A${dataStart}`, values: [['배당주']] });
    } else if (label === '[ IRP ]') {
      writes.push({ range: `리밸런싱!A${dataStart}:A${dataStart}`, values: [['TDF']] });
    } else {
      writes.push({ range: `리밸런싱!A${dataStart}:A${dataStart + count - 1}`, values: ASSET_7.slice(0, count).map(n => [n]) });
    }
  }
  console.log('   ✓ 리밸런싱 재구성 완료');

  // ── 3. 배당금: C열 종목명 추가 (Banana V/Z 컬럼) ─────────────────────────
  console.log('\n3. 배당금 C열 종목명 추가 중...');

  const [div2025, div2026] = await Promise.all([
    readRange(token, 'Banana!U5:W78', 'FORMATTED_VALUE'),
    readRange(token, 'Banana!Y5:AA78', 'FORMATTED_VALUE'),
  ]);

  const allDivs = [];
  for (const rows of [div2025, div2026]) {
    for (const r of rows) {
      const date = String(r[0] ?? '').trim();
      const name = String(r[1] ?? '').trim();   // V or Z: 종목명
      const amt  = r[2] ?? '';                  // W or AA: 배당금
      if (date && amt) allDivs.push([date, amt, name]);
    }
  }
  allDivs.sort((a, b) => a[0].localeCompare(b[0]));

  await batchClear(token, ['배당금!A1:C1000']);
  writes.push({ range: '배당금!A1:C1', values: [['일자', '배당금', '종목명']] });
  if (allDivs.length) {
    writes.push({ range: `배당금!A2:C${1 + allDivs.length}`, values: allDivs });
  }
  console.log(`   ✓ 배당금: ${allDivs.length}개 항목 (종목명 포함)`);

  // ── 일괄 쓰기 ────────────────────────────────────────────────────────────
  console.log('\n데이터 쓰는 중...');
  await batchWrite(token, writes);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 수정 완료!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
async function main() {
  let token = process.argv[2]?.trim();
  if (token) { console.log('✓ 토큰 인수 사용'); }
  else { token = await getTokenViaBrowser(); console.log('✓ 토큰 취득 성공'); }
  await fix(token);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
