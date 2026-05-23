/**
 * 평가요청 탭 셋업 — 모바일에서 평가 의뢰를 큐에 던지는 비동기 모델
 *
 * 흐름:
 *   1. 모바일 banana-portfolio "평가 의뢰" → 이 탭에 한 줄 append
 *   2. Frank가 Claude Pro에 "평가요청 처리해줘" 한 줄 명령
 *      → Trading Agent/playbooks/queue-evaluation.md 따라 처리
 *   3. 결과는 종목투자노트 탭에 적재 + 본 탭 상태=완료
 *
 * 사용법:
 *   node scripts/setup-eval-queue.mjs                  # 자동 OAuth
 *   node scripts/setup-eval-queue.mjs <TOKEN>          # 토큰 직접
 *
 * 안전 모드:
 *   탭이 없으면          → 생성 + 헤더 + 1행 고정
 *   탭이 있고 비어있으면 → 헤더 적용
 *   탭이 있고 헤더 일치  → 변경 없음
 *   탭이 있고 헤더 불일치 → 안내 후 종료 (수동 정리 필요)
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT  = 'http://localhost:8085/callback';
const AUTH_TIMEOUT_MS = 120_000;

const TAB_NAME = '평가요청';

// 컬럼 A~F (6개) — 최소 정보만. 처리 결과는 종목투자노트에 적재되므로 여기는 큐로만 사용.
const HEADERS = [
  '요청일시', '종목명', '시장', '상태', '처리일시', '메모',
];

// ── CLI 인수 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));

// ── OAuth ───────────────────────────────────────────────────────────────────
function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<p>인증 처리 중...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  if (t) {
    fetch('/token', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: t}) })
      .then(() => { document.body.innerHTML = '<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>'; });
  } else {
    document.body.innerHTML = '<h2 style="font-family:sans-serif;color:red">⚠️ 토큰을 받지 못했습니다.</h2>';
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

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth 타임아웃 (2분 초과)'));
    }, AUTH_TIMEOUT_MS);

    server.listen(8085, () => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}`;
      console.log('\n브라우저에서 Google 로그인 창을 엽니다...');
      console.log('자동으로 열리지 않으면 아래 URL을 복사:\n');
      console.log(url + '\n');
      exec(`open "${url}"`);
    });

    server.on('error', e => {
      clearTimeout(timer);
      if (e.code === 'EADDRINUSE') {
        reject(new Error(
          '포트 8085 사용 중. 토큰 직접 전달: node scripts/setup-eval-queue.mjs <TOKEN>'
        ));
      } else { reject(e); }
    });
  });
}

// ── Sheets API ──────────────────────────────────────────────────────────────
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function sheetsGet(token) {
  const res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) throw new Error('토큰 만료 또는 권한 없음 (401)');
    if (res.status === 403) throw new Error('Sheets API 접근 권한 없음 (403)');
    throw new Error(`시트 조회 실패: ${res.status} ${text}`);
  }
  return res.json();
}

async function getRange(token, range) {
  const res = await fetch(`${API}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${await res.text()}`);
  return res.json();
}

async function batchUpdate(token, requests) {
  const res = await fetch(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batchUpdate 실패: ${await res.text()}`);
  return res.json();
}

async function valuesUpdate(token, range, values) {
  const res = await fetch(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`update 실패: ${await res.text()}`);
}

// ── 헬퍼 ────────────────────────────────────────────────────────────────────
function findSheet(spreadsheet, title) {
  return spreadsheet.sheets.find(s => s.properties.title === title);
}

function headersMatch(existing, expected) {
  if (!Array.isArray(existing) || existing.length < expected.length) return false;
  return expected.every((h, i) => String(existing[i] ?? '').trim() === h);
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  let token = explicitToken?.trim();
  if (token) {
    console.log('✓ 토큰 인수 사용');
  } else {
    console.log('OAuth 로그인으로 토큰 취득...');
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득\n');
  }

  console.log(`1. 스프레드시트 조회...`);
  const spreadsheet = await sheetsGet(token);
  const existing = findSheet(spreadsheet, TAB_NAME);

  if (!existing) {
    console.log(`2. "${TAB_NAME}" 탭 생성 + 헤더 적용...`);
    const createResp = await batchUpdate(token, [{
      addSheet: {
        properties: {
          title: TAB_NAME,
          gridProperties: { rowCount: 500, columnCount: HEADERS.length, frozenRowCount: 1 },
        },
      },
    }]);
    const newSheetId = createResp.replies[0].addSheet.properties.sheetId;

    await valuesUpdate(token, `${TAB_NAME}!A1`, [HEADERS]);
    await batchUpdate(token, [{
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.12, green: 0.14, blue: 0.18 },
            textFormat: { foregroundColor: { red: 0.91, green: 0.92, blue: 0.94 }, bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    }]);

    console.log(`   ✓ 탭 생성, 헤더 ${HEADERS.length}개 컬럼, 1행 고정`);
  } else {
    console.log(`2. 기존 "${TAB_NAME}" 탭 발견. 헤더 검사...`);
    const headerRange = await getRange(token, `${TAB_NAME}!A1:F1`);
    const existingHeaders = headerRange.values?.[0] ?? [];

    if (existingHeaders.length === 0) {
      console.log('   기존 탭 비어있음. 헤더 적용...');
      await valuesUpdate(token, `${TAB_NAME}!A1`, [HEADERS]);
      await batchUpdate(token, [{
        updateSheetProperties: {
          properties: { sheetId: existing.properties.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      }]);
      console.log(`   ✓ 헤더 ${HEADERS.length}개 적용, 1행 고정`);
    } else if (headersMatch(existingHeaders, HEADERS)) {
      console.log('   ✓ 헤더가 신규 스키마와 일치. 변경 없음.');
    } else {
      console.log('\n   ⚠️  기존 헤더가 신규 스키마와 다릅니다.');
      console.log(`   기존: [${existingHeaders.join(', ')}]`);
      console.log(`   신규: [${HEADERS.join(', ')}]`);
      console.log('\n   자동 변경하지 않습니다. 시트에서 직접 정리 후 다시 실행해주세요.\n');
      process.exit(0);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 평가요청 탭 셋업 완료');
  console.log('');
  console.log('컬럼 스키마 (A~F):');
  HEADERS.forEach((h, i) => {
    const col = String.fromCharCode(65 + i);
    console.log(`  ${col}: ${h}`);
  });
  console.log('');
  console.log('상태 컬럼(D) 값: 대기 / 처리중 / 완료 / 오류');
  console.log('');
  console.log('다음 단계:');
  console.log('  1. banana-portfolio 평가 탭에서 "+ 평가 의뢰" → 큐에 던지기');
  console.log('  2. Claude Pro에 "평가요청 시트 처리해줘" 한 줄 명령');
  console.log('     → Trading Agent/playbooks/queue-evaluation.md 따라 처리');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => {
  console.error('\n❌ 오류:', e.message);
  if (e.message.includes('redirect_uri_mismatch') || e.message.includes('401')) {
    console.error('\n해결법: Google Cloud Console → OAuth 2.0 클라이언트 → 승인된 리디렉션 URI');
    console.error('  http://localhost:8085/callback 추가\n');
  }
  process.exit(1);
});
