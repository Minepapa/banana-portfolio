/**
 * 종목투자노트 탭 셋업 — AI 능동 평가 카드 적재용 스키마
 *
 * 단일 출처: Trading Agent/playbooks/active-evaluation.md §6 (컬럼 A~T)
 *
 * 사용법:
 *   node scripts/setup-evaluation-tab.mjs                  # 자동 OAuth + 안전 모드
 *   node scripts/setup-evaluation-tab.mjs <TOKEN>          # 토큰 직접
 *   node scripts/setup-evaluation-tab.mjs --migrate        # 기존 탭 백업 후 새로
 *   node scripts/setup-evaluation-tab.mjs --with-sample    # 샘플 1행 적재
 *
 * 안전 모드:
 *   탭이 없으면          → 생성 + 헤더 + 1행 고정
 *   탭이 있고 비어있으면 → 헤더 적용
 *   탭이 있고 데이터 있으면 → 기존 헤더와 신규 스키마 비교
 *                          호환 시: 그대로 유지
 *                          불일치 시: --migrate 없으면 안내 후 종료
 *                          --migrate 있으면 백업 후 새로 생성
 */

import { createServer } from 'http';
import { exec } from 'child_process';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT  = 'http://localhost:8085/callback';
const AUTH_TIMEOUT_MS = 120_000;

const TAB_NAME = '종목투자노트';

// playbook §6 — 컬럼 A~T (20개)
const HEADERS = [
  '평가일', '종목명', '종목코드', '시장',
  '결론', '수익성', '안정성', '밸류에이션', '현금흐름', '모멘텀',
  '근거', '리스크', 'Frank액션',
  'Frank메모', '매수여부', '매수일', '매수가', '목표기간', '목표수익률', 'AI의견',
];

// SK하이닉스 샘플 (--with-sample)
const SAMPLE_ROW = [
  '2026-05-17', 'SK하이닉스', '000660', 'KR',
  '🟢 O', '🟢', '🟢', '🟢', '🟢', '🟡',
  '1) HBM 사이클 구조적 수혜로 영업이익률 30%대 정착, 동종 12% 대비 2.6배. ' +
  '2) Fwd PER 6.8x는 5년 밴드 하단 + FCF yield 8.2%로 채권(4.6%) 대비 매력. ' +
  '3) ROIC 21.4% 5년 추세 유효 — 자본 효율 강력.',
  '1) 외국인 4거래일 순매도 −2,300억 — 단기 환율/지정학 영향 가능. ' +
  '2) 미·중 반도체 규제 강화 시 중국향 매출(전체 22%) 노출.',
  '1회 300만원 미만 분할 매수 가능. 외국인 4일 흐름 순매수 전환 후 1차 진입. ' +
  '52주 위치 60% 이하 눌림 시 추가 매수.',
  '', '보류', '', '', '장기', '30%',
  'HBM 사이클 + 저평가 콤보',
];

// ── CLI 인수 파싱 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flagMigrate    = args.includes('--migrate');
const flagWithSample = args.includes('--with-sample');
const explicitToken  = args.find(a => !a.startsWith('--'));

// ── OAuth (setup-sheets.mjs 동일 패턴) ──────────────────────────────────────
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
    fetch('/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: t})
    }).then(() => {
      document.body.innerHTML = '<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>';
    });
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
          '포트 8085 사용 중. 토큰 직접 전달: node scripts/setup-evaluation-tab.mjs <TOKEN>'
        ));
      } else { reject(e); }
    });
  });
}

// ── Sheets API 래퍼 ──────────────────────────────────────────────────────────
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

async function valuesAppend(token, range, values) {
  const res = await fetch(
    `${API}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`append 실패: ${await res.text()}`);
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

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function findSheet(spreadsheet, title) {
  return spreadsheet.sheets.find(s => s.properties.title === title);
}

function headersMatch(existing, expected) {
  if (!Array.isArray(existing) || existing.length < expected.length) return false;
  // 기존 헤더가 신규 스키마를 모두 포함하는지(부분 호환 허용)
  return expected.every((h, i) => String(existing[i] ?? '').trim() === h);
}

function timestampForBackup() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  // 토큰
  let token = explicitToken?.trim();
  if (token) {
    console.log('✓ 토큰 인수 사용');
  } else {
    console.log('OAuth 로그인으로 토큰 취득...');
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득\n');
  }

  // 1. 스프레드시트 조회
  console.log(`1. 스프레드시트 조회...`);
  const spreadsheet = await sheetsGet(token);
  const existing = findSheet(spreadsheet, TAB_NAME);

  if (!existing) {
    // ── CASE A: 탭 없음 → 신규 생성 ────────────────────────────────────────
    console.log(`2. "${TAB_NAME}" 탭 생성 + 헤더 적용...`);
    const createResp = await batchUpdate(token, [{
      addSheet: {
        properties: {
          title: TAB_NAME,
          gridProperties: { rowCount: 1000, columnCount: HEADERS.length, frozenRowCount: 1 },
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
    // ── CASE B/C: 탭 존재 ──────────────────────────────────────────────────
    console.log(`2. 기존 "${TAB_NAME}" 탭 발견. 헤더 검사...`);
    const headerRange = await getRange(token, `${TAB_NAME}!A1:T1`);
    const existingHeaders = headerRange.values?.[0] ?? [];
    const dataRange = await getRange(token, `${TAB_NAME}!A2:A`);
    const hasData = (dataRange.values ?? []).some(r => String(r[0] ?? '').trim());

    if (existingHeaders.length === 0) {
      // CASE B: 헤더 없음 → 헤더만 적용
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
      // CASE C1: 헤더 일치
      console.log('   ✓ 헤더가 신규 스키마와 일치. 변경 없음.');
    } else {
      // CASE C2: 헤더 불일치
      console.log('\n   ⚠️  기존 헤더가 신규 스키마와 다릅니다.');
      console.log(`   기존: [${existingHeaders.slice(0, 10).join(', ')}${existingHeaders.length > 10 ? ', ...' : ''}]`);
      console.log(`   신규: [${HEADERS.slice(0, 10).join(', ')}, ...]`);

      if (!flagMigrate) {
        console.log(`\n   데이터 존재 여부: ${hasData ? '있음' : '없음'}`);
        console.log('\n   안전을 위해 자동 변경하지 않습니다.');
        console.log('   기존 데이터를 백업 후 새로 생성하려면:');
        console.log('     node scripts/setup-evaluation-tab.mjs --migrate\n');
        process.exit(0);
      }

      // --migrate: 백업 + 새로 생성
      const backupName = `${TAB_NAME}_backup_${timestampForBackup()}`;
      console.log(`\n3. 마이그레이션 모드: 기존 탭 → "${backupName}"로 이름 변경`);
      await batchUpdate(token, [{
        updateSheetProperties: {
          properties: { sheetId: existing.properties.sheetId, title: backupName },
          fields: 'title',
        },
      }]);
      console.log(`   ✓ 백업 완료: "${backupName}"`);

      console.log(`\n4. 새 "${TAB_NAME}" 탭 생성 + 헤더 적용...`);
      const createResp = await batchUpdate(token, [{
        addSheet: {
          properties: {
            title: TAB_NAME,
            gridProperties: { rowCount: 1000, columnCount: HEADERS.length, frozenRowCount: 1 },
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
      console.log('   ✓ 신규 탭 준비 완료');
    }
  }

  // 샘플 데이터
  if (flagWithSample) {
    console.log('\n5. 샘플 1행 적재 (SK하이닉스)...');
    await valuesAppend(token, `${TAB_NAME}!A:T`, [SAMPLE_ROW]);
    console.log('   ✓ 샘플 적재 완료');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 종목투자노트 탭 셋업 완료');
  console.log('');
  console.log('컬럼 스키마 (A~T):');
  HEADERS.forEach((h, i) => {
    const col = String.fromCharCode(65 + i);
    console.log(`  ${col}: ${h}`);
  });
  console.log('\n다음 단계:');
  console.log('  1. banana-portfolio 평가 탭에서 프롬프트 복사');
  console.log('  2. Claude Code에 종목명 채워 실행 → 5축 카드 생성');
  console.log('  3. 결과를 시트에 직접 또는 향후 자동 적재');
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
