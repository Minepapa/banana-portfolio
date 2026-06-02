/**
 * 스프레드시트의 '리밸런싱' 탭을 '자산분배'로 리네임하는 1회성 스크립트
 *
 * 사용법: node scripts/rename-rebal-tab.mjs
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT  = 'http://localhost:8085/callback';

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
      console.log('\n브라우저 로그인 창을 엽니다...\n' + url + '\n');
      exec(`open "${url}"`);
    });
    server.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function renameTab(token) {
  const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

  // 1. 현재 탭 목록 조회
  const metaRes = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) throw new Error(`메타 조회 실패: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const sheet = meta.sheets.find(s => s.properties.title === '리밸런싱');
  if (!sheet) {
    const existing = meta.sheets.map(s => s.properties.title).join(', ');
    console.log(`\n⚠️  '리밸런싱' 탭을 찾을 수 없습니다.`);
    console.log(`   현재 탭: [${existing}]`);

    const already = meta.sheets.find(s => s.properties.title === '자산분배');
    if (already) console.log(`   → '자산분배' 탭이 이미 존재합니다. 작업 불필요.`);
    return;
  }

  // 2. 탭 이름 변경
  const res = await fetch(`${BASE}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, title: '자산분배' },
          fields: 'title',
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`리네임 실패: ${await res.text()}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log("✅ '리밸런싱' → '자산분배' 리네임 완료!");
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

async function main() {
  let token = process.argv[2]?.trim();
  if (token) { console.log('✓ 토큰 인수 사용'); }
  else { token = await getTokenViaBrowser(); console.log('✓ 토큰 취득 성공'); }
  await renameTab(token);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
