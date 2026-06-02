/**
 * 새 스프레드시트 탭 구조 생성 스크립트
 *
 * 사용법 (자동 OAuth):
 *   node scripts/setup-sheets.mjs
 *
 * 사용법 (토큰 직접 전달):
 *   node scripts/setup-sheets.mjs <ACCESS_TOKEN>
 *
 * ※ 자동 OAuth 사용 시 Google Cloud Console 에서
 *   http://localhost:8085/callback 을 승인된 리디렉션 URI로 추가 필요
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID   = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID    = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE       = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT    = 'http://localhost:8085/callback';
const AUTH_TIMEOUT_MS = 120_000;

// ── OAuth 토큰 취득 ───────────────────────────────────────────────────────────
function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        // 브라우저에서 hash fragment 를 읽어 /token 으로 POST
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<p>인증 처리 중...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  if (t) {
    fetch('/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: t})
    }).then(() => {
      document.body.innerHTML = '<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>';
    });
  } else {
    document.body.innerHTML = '<h2 style="font-family:sans-serif;color:red">⚠️ 토큰을 받지 못했습니다. 터미널을 확인하세요.</h2>';
  }
</script></body></html>`);
        return;
      }

      if (req.method === 'POST' && req.url === '/token') {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body);
            res.writeHead(200); res.end('ok');
            server.close();
            clearTimeout(timer);
            resolve(token);
          } catch (e) {
            res.writeHead(400); res.end('bad');
            reject(new Error('토큰 파싱 실패: ' + e.message));
          }
        });
        return;
      }

      res.writeHead(404); res.end();
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth 타임아웃 (2분 초과)'));
    }, AUTH_TIMEOUT_MS);

    server.listen(8085, () => {
      const url =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}`;

      console.log('\n브라우저에서 Google 로그인 창을 엽니다...');
      console.log('자동으로 열리지 않으면 아래 URL을 복사해서 브라우저에 붙여넣으세요:\n');
      console.log(url + '\n');
      exec(`open "${url}"`);
    });

    server.on('error', e => {
      clearTimeout(timer);
      if (e.code === 'EADDRINUSE') {
        reject(new Error(
          '포트 8085가 이미 사용 중입니다. 다른 프로세스를 종료하거나\n' +
          '토큰을 직접 전달하세요: node scripts/setup-sheets.mjs <ACCESS_TOKEN>'
        ));
      } else {
        reject(e);
      }
    });
  });
}

// ── Sheets API 래퍼 ──────────────────────────────────────────────────────────
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function sheetsGet(token) {
  const res = await fetch(API, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error('토큰이 만료되었거나 권한이 없습니다 (401).');
    if (res.status === 403) throw new Error('Sheets API 접근 권한이 없습니다 (403).\n  → Google Cloud Console 에서 Sheets API가 활성화되어 있는지 확인하세요.');
    throw new Error(`시트 정보 조회 실패: ${res.status} ${text}`);
  }
  return res.json();
}

async function createSheet(token, title) {
  const res = await fetch(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) throw new Error(`탭 생성 실패 (${title}): ${await res.text()}`);
}

async function writeValues(token, data) {
  const res = await fetch(`${API}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!res.ok) throw new Error(`값 쓰기 실패: ${await res.text()}`);
}

// ── 탭 데이터 정의 ────────────────────────────────────────────────────────────
const HOLDING_HEADERS = [['자산군', '종목명', '매수단가', '수량', '투자금', '현재가', '수익손실', '평가금', '수익률']];
const ASSET_7 = [['채권'], ['금'], ['달러'], ['배당주'], ['리츠'], ['국내주식'], ['해외주식']];
const TABS_TO_CREATE = ['ISA', '위탁', '연금저축', 'IRP', '자산분배', '월별잔고', '배당금', '설정'];

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  // 토큰 취득
  let token = process.argv[2]?.trim();
  if (token) {
    console.log('✓ 토큰을 인수로 받아 사용합니다.');
  } else {
    console.log('OAuth 로그인으로 토큰을 취득합니다...');
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득 성공\n');
  }

  // 1. 기존 탭 목록 조회
  console.log('1. 기존 탭 목록 조회 중...');
  const spreadsheet = await sheetsGet(token);
  const existing = spreadsheet.sheets.map(s => s.properties.title);
  console.log(`   기존 탭: [${existing.join(', ')}]\n`);

  // 2. 없는 탭 생성
  console.log('2. 없는 탭 생성 중...');
  for (const title of TABS_TO_CREATE) {
    if (existing.includes(title)) {
      console.log(`   - 건너뜀 (이미 존재): ${title}`);
    } else {
      await createSheet(token, title);
      console.log(`   ✓ 생성: ${title}`);
    }
  }

  // 3. 헤더 및 초기 데이터 작성
  console.log('\n3. 헤더 및 초기 데이터 작성 중...');
  await writeValues(token, [
    // 계좌 탭 헤더
    { range: 'ISA!A1:I1',       values: HOLDING_HEADERS },
    { range: '위탁!A1:I1',      values: HOLDING_HEADERS },
    { range: '연금저축!A1:I1',  values: HOLDING_HEADERS },
    { range: 'IRP!A1:I1',       values: HOLDING_HEADERS },

    // 자산분배 탭
    // Row 1: 헤더 / Row 2: [위탁] 레이블 / Rows 3-9: 위탁 / Row 10: 빈 구분
    // Row 11: [연금저축] 레이블 / Rows 12-18: 연금저축 / Row 19: 빈 구분
    // Row 20: [ISA] 레이블 / Row 21: ISA / Row 22: 빈 구분
    // Row 23: [IRP] 레이블 / Row 24: IRP
    { range: '자산분배!A1:D1',   values: [['자산군', '목표비율', '현재비율', '자산분배금액']] },
    { range: '자산분배!A2:A2',   values: [['[ 위탁 ]']] },
    { range: '자산분배!A3:A9',   values: ASSET_7 },
    { range: '자산분배!A11:A11', values: [['[ 연금저축 ]']] },
    { range: '자산분배!A12:A18', values: ASSET_7 },
    { range: '자산분배!A20:A20', values: [['[ ISA ]']] },
    { range: '자산분배!A21:A21', values: [['배당주']] },
    { range: '자산분배!A23:A23', values: [['[ IRP ]']] },
    { range: '자산분배!A24:A24', values: [['TDF']] },

    // 월별잔고 탭
    { range: '월별잔고!A1:H1',   values: [['연도', '월', '저축금', 'ISA', '위탁', '연금저축', 'IRP', '총잔고']] },

    // 배당금 탭
    { range: '배당금!A1:C1',     values: [['일자', '배당금', '종목명']] },

    // 설정 탭
    { range: '설정!A1:B1',       values: [['항목', '값']] },
    { range: '설정!A2:B2',       values: [['USD/KRW환율', '=GOOGLEFINANCE("CURRENCY:USDKRW")']] },
  ]);
  console.log('   ✓ 작성 완료');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 탭 구조 생성 완료!');
  console.log('');
  console.log('다음 단계 — 기존 Banana 탭에서 데이터 복사:');
  console.log('  Banana K6:S10   → ISA!A2:I');
  console.log('  Banana K14:S39  → 위탁!A2:I');
  console.log('  Banana K43:S64  → 연금저축!A2:I');
  console.log('  Banana K68:S69  → IRP!A2:I');
  console.log('  Banana C/F/G    → 자산분배!B/C/D (계좌별 섹션 맞춰서)');
  console.log('  Banana B43:I89  → 월별잔고!A2:H');
  console.log('  Banana U:W + Y:AA 배당 → 배당금!A:B (날짜 오름차순)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => {
  console.error('\n❌ 오류:', e.message);
  if (e.message.includes('redirect_uri_mismatch') || e.message.includes('401')) {
    console.error('\n해결법: Google Cloud Console → OAuth 2.0 클라이언트 → 승인된 리디렉션 URI 에');
    console.error('  http://localhost:8085/callback  을 추가하세요.\n');
  }
  process.exit(1);
});
