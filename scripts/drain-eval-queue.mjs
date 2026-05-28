/**
 * 평가요청 큐 드레인 (반자동)
 *
 * 흐름:
 *   1. OAuth → 시트 평가요청 탭에서 대기 행 읽기
 *   2. 각 대기 건마다 Claude Pro용 프롬프트 출력 → Frank가 복사해서 붙여넣기
 *   3. Claude Pro 응답 JSON을 이 스크립트에 붙여넣기
 *   4. 종목투자노트!A2:U에 append + 평가요청 상태 '완료'로 업데이트
 *
 * 사용법:
 *   node scripts/drain-eval-queue.mjs              # 자동 OAuth
 *   node scripts/drain-eval-queue.mjs <TOKEN>      # 토큰 직접
 */

import { createServer } from 'http';
import { exec } from 'child_process';
import { createInterface } from 'readline';

const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID  = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';
const REDIRECT  = 'http://localhost:8085/callback';
const AUTH_TIMEOUT_MS = 120_000;
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run'); // 시트 쓰기 없이 프롬프트만 출력

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
        reject(new Error('포트 8085 사용 중. 토큰 직접 전달: node scripts/drain-eval-queue.mjs <TOKEN>'));
      } else { reject(e); }
    });
  });
}

// ── Sheets API ──────────────────────────────────────────────────────────────
async function getRange(token, range) {
  const res = await fetch(`${API}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${await res.text()}`);
  return res.json();
}

async function appendValues(token, range, values) {
  const res = await fetch(
    `${API}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`append 실패: ${await res.text()}`);
  return res.json();
}

async function updateCell(token, range, value) {
  const res = await fetch(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  if (!res.ok) throw new Error(`셀 업데이트 실패 (${range}): ${await res.text()}`);
}

// ── readline ────────────────────────────────────────────────────────────────
function createRL() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function readMultiline(rl) {
  return new Promise(resolve => {
    console.log('  (JSON 붙여넣기 후 빈 줄에서 Enter 2번 → 완료)\n');
    let lines = [];
    let emptyCount = 0;
    const onLine = (line) => {
      if (line.trim() === '') {
        emptyCount++;
        if (emptyCount >= 2) {
          rl.removeListener('line', onLine);
          resolve(lines.join('\n'));
          return;
        }
      } else {
        emptyCount = 0;
      }
      lines.push(line);
    };
    rl.on('line', onLine);
  });
}

// ── JSON 파싱 ───────────────────────────────────────────────────────────────
function parseEvalJson(raw) {
  const fence = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/);
  let candidate = fence ? fence[1] : raw;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('JSON 블록을 찾지 못했습니다.');
  candidate = candidate.slice(first, last + 1);
  const obj = JSON.parse(candidate);
  if (!obj.date || !obj.name || !obj.conclusion) {
    throw new Error(`필수 필드 누락: ${['date','name','conclusion'].filter(k => !obj[k]).join(', ')}`);
  }
  return obj;
}

function buildRow(obj) {
  const grades = obj.grades || {};
  const joinNum = (arr) => (arr || []).map((s, i) => `${i + 1}) ${s}`).join(' ');
  return [
    obj.date, obj.name, obj.ticker || '', obj.market || '',
    obj.conclusion,
    grades.수익성 || '', grades.안정성 || '', grades.밸류에이션 || '', grades.현금흐름 || '', grades.모멘텀 || '',
    joinNum(obj.reasons), joinNum(obj.risks), joinNum(obj.actions),
    obj.frankMemo || '', obj.status || '보류',
    obj.buyDate || '', obj.buyPrice || '',
    obj.targetTerm || '', obj.targetRet || '',
    obj.aiNote || '',
    obj.axisItems ? JSON.stringify(obj.axisItems) : '',
  ];
}

function nowKST() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}

function todayKST() {
  return nowKST().slice(0, 10);
}

// 날짜 → 분기 키 ("2026-Q1" 등). 4~5월=Q1, 6~8월=Q2, 9~11월=Q3, 1~3월=Q4prev
function getQuarterKey(dateStr) {
  const [y, m] = (dateStr || '').split('-').map(Number);
  if (!y || !m) return null;
  const q = m <= 3 ? 'Q4prev' : m <= 5 ? 'Q1' : m <= 8 ? 'Q2' : m <= 11 ? 'Q3' : 'Q4';
  return `${y}-${q}`;
}

// 같은 분기 내 같은 종목 기존 평가 조회 → axisItems 반환 (없으면 null)
function findSameQuarterEval(noteRows, stockName, todayStr) {
  const todayQK = getQuarterKey(todayStr);
  if (!todayQK) return null;
  for (const r of (noteRows || [])) {
    if (String(r[1] ?? '').trim() !== stockName) continue;
    const rowQK = getQuarterKey(String(r[0] ?? '').trim());
    if (rowQK !== todayQK) continue;
    const axisJson = String(r[20] ?? '').trim();
    if (!axisJson) continue;
    try {
      return { date: String(r[0]).trim(), axisItems: JSON.parse(axisJson) };
    } catch { continue; }
  }
  return null;
}

// 숫자 문자열 파싱 (쉼표·% 제거)
function pn(v) { return parseFloat(String(v ?? '').replace(/[,%]/g, '')) || 0; }

// 4계좌 보유현황에서 종목 포지션 조회. 반환: [{ acct, type, avgPrice, qty, invest, profit, rate }]
function findHolding(holdingsByAcct, stockName) {
  const results = [];
  for (const [acct, rows] of Object.entries(holdingsByAcct)) {
    let lastType = '';
    for (const r of (rows || [])) {
      const t = String(r[0] ?? '').trim();
      if (t) lastType = t;
      if (String(r[1] ?? '').trim() !== stockName) continue;
      const qty = pn(r[3]);
      const invest = pn(r[4]);
      if (qty <= 0 && invest <= 0) continue;
      results.push({ acct, type: lastType, avgPrice: pn(r[2]), qty, invest, profit: pn(r[6]), rate: pn(r[8]) });
    }
  }
  return results;
}

// 자산배분 현황 구성 (위탁·연금저축 자산분배 시트 → {위탁:[{name,target,current,rebalAmt}...], 연금저축:[...]})
const REBAL_ASSETS = ['채권', '금', '달러', '배당주', '리츠', '국내주식', '해외주식'];
function buildAllocationData(위탁Rebal, 연금저축Rebal) {
  const parse = (vr) => (vr?.values ?? []).map(r => ({ target: pn(r[0]), current: pn(r[1]), rebalAmt: pn(r[2]) }));
  const w = parse(위탁Rebal);
  const y = parse(연금저축Rebal);
  return {
    위탁:     REBAL_ASSETS.map((name, i) => ({ name, ...(w[i] || {target:0, current:0, rebalAmt:0}) })),
    연금저축: REBAL_ASSETS.map((name, i) => ({ name, ...(y[i] || {target:0, current:0, rebalAmt:0}) })),
  };
}

// ── 매도 평가 여부 판단 ──────────────────────────────────────────────────────
function isSellEval(entry) {
  return /매도\s*평가/i.test(entry.memo || '');
}

// ── 매수 평가 프롬프트 ────────────────────────────────────────────────────────
function buildBuyPrompt(entry, cachedEval, holdings, allocationData) {
  const market = entry.market || '(자동감지)';
  const memo = entry.memo ? `\n메모: "${entry.memo}"` : '';

  const fmt = n => Math.round(n).toLocaleString('ko-KR');

  // ① 현재 포지션
  let posSection;
  if (holdings && holdings.length > 0) {
    const lines = holdings.map(h =>
      `  [${h.acct}${h.type ? ` · ${h.type}` : ''}] 평균단가 ${fmt(h.avgPrice)}원 × ${h.qty}주 = 투자금 ${fmt(h.invest)}원 (수익률 ${h.rate}%)`
    ).join('\n');
    posSection = `[Frank 현재 포지션]\n${lines}`;
  } else {
    posSection = `[Frank 현재 포지션] 미보유`;
  }

  // ② 자산배분 현황 — 이 종목의 해당 자산군
  const assetType = holdings?.[0]?.type
    || ((entry.market || '').toUpperCase() === 'KR' ? '국내주식'
      : (entry.market || '').toUpperCase() === 'US' ? '해외주식' : null);

  let allocationSection = '';
  if (allocationData && assetType) {
    const rows = [];
    for (const [acct, assets] of Object.entries(allocationData)) {
      const a = assets.find(x => x.name === assetType);
      if (!a || (a.target === 0 && a.current === 0)) continue;
      const gap = (a.target - a.current).toFixed(1);
      const dir = a.rebalAmt > 0 ? `매수 여력 ${fmt(a.rebalAmt)}원` : a.rebalAmt < 0 ? `초과 ${fmt(-a.rebalAmt)}원` : '균형';
      rows.push(`  ${acct} ${assetType}: 현재 ${a.current}% vs 목표 ${a.target}% (갭 ${gap > 0 ? '+' : ''}${gap}%p, ${dir})`);
    }
    if (rows.length) allocationSection = `\n[포트폴리오 배분 현황 — ${assetType}]\n${rows.join('\n')}\n`;
  }

  let cacheSection = '';
  if (cachedEval) {
    const fin = {
      수익성:   (cachedEval.axisItems['수익성']   || []).map(i => `  {label:"${i.label}", value:"${i.value}", source:"${i.source}"${i.metric ? `, metric:"${i.metric}"` : ''}}`).join('\n'),
      안정성:   (cachedEval.axisItems['안정성']   || []).map(i => `  {label:"${i.label}", value:"${i.value}", source:"${i.source}"${i.metric ? `, metric:"${i.metric}"` : ''}}`).join('\n'),
      현금흐름: (cachedEval.axisItems['현금흐름'] || []).map(i => `  {label:"${i.label}", value:"${i.value}", source:"${i.source}"${i.metric ? `, metric:"${i.metric}"` : ''}}`).join('\n'),
    };
    cacheSection = `
⚡ 동일 분기 재평가 — 재무제표 캐시 활용 (이전 평가일: ${cachedEval.date})
수익성/안정성/현금흐름 항목은 OpenDart 재호출 없이 아래 데이터를 axisItems에 그대로 복사하세요.
밸류에이션(현재 주가 기반 PER/PBR)과 모멘텀(RSI/52주/수급)만 새로 fetch하면 됩니다.

[캐시 재무제표 — 수익성]
${fin.수익성 || '  (데이터 없음)'}

[캐시 재무제표 — 안정성]
${fin.안정성 || '  (데이터 없음)'}

[캐시 재무제표 — 현금흐름]
${fin.현금흐름 || '  (데이터 없음)'}
`;
  }

  return `다음 종목을 5축 평가해줘 (Trading Agent/playbooks/active-evaluation.md 따라):

종목: ${entry.name}
시장: ${market}${memo}

${posSection}
${allocationSection}${cacheSection}
출력 조건:
1. active-evaluation.md §5 표준 카드 양식으로 먼저 보여줘
2. 마지막에 \`\`\`json 펜스로 JSON 블록 출력 (queue-evaluation.md §2.4 양식)
3. JSON에 반드시 "axisItems" 필드 포함 — 각 축별 세부 지표({label, value, source, metric})
4. status는 항상 "보류"
5. 데이터 부족 항목은 추정 금지, "(데이터 부족: 소스)" 표기

⚠️ Frank 액션 권고 필수 포함 항목 (위 포지션 기반으로 구체화):
- 현재 포지션 상태: 보유/미보유, 보유 시 평균단가 대비 현재가 갭
- 매수/추가 진입 조건: RSI + 구체적 가격대 명시 (예: "RSI 45 이하 + 270,000원 이하 시 1차 진입")
- 1회 진입 금액: 300만원 이하 원칙 준수
- 차익실현/손절 조건: 52주 위치 또는 RSI 기반 구체적 레벨
- 보유 중이라면: 추가매수 여부 또는 홀딩 의견
- 미보유라면: 진입 우선순위 (지금 바로 / 조정 후 / 보류)

⚠️ 데이터 최신성 필수:
- 현재 날짜 기준으로 가장 최신 재무 데이터를 사용할 것 (OpenDart reprt_code: 최신 사업보고서 또는 분기보고서)
- 2026년에 분석 시 반드시 2025 사업보고서 + 2026 분기보고서 사용. 2024년 이전 데이터를 최신으로 사용하면 안 됨
- KR: OpenDart (get_financial_index, get_full_financial_statement) + 네이버 뉴스
- KR 모멘텀(RSI/52주): api.finance.naver.com/siseJson.naver?symbol={종목코드}&requestType=1&startTime={1년전}&endTime={오늘}&timeframe=day
  → 종가 배열로 RSI(14) 직접 계산, 52주 고저·위치(%) 산출
- US: get_stock_info, get_financial_statement + 뉴스`;
}

// ── 매도 평가 프롬프트 ────────────────────────────────────────────────────────
function buildSellPrompt(entry, buyCard) {
  const market = entry.market || '(자동감지)';
  const reasonLines = (buyCard?.reasons || []).map((r, i) => `근거 ${i+1}: ${r}`).join('\n');
  const riskLines   = (buyCard?.risks   || []).map((r, i) => `리스크 ${i+1}: ${r}`).join('\n');
  const cardSection = buyCard
    ? `[최초 매수 카드]
평가일: ${buyCard.date}
결론: ${buyCard.conclusion}
${reasonLines || '(근거 미기록)'}
${riskLines || ''}
AI 한줄: ${buyCard.aiNote || '—'}`
    : `[최초 매수 카드]
(종목투자노트에 매수 평가 없음 — 노트 탭에서 먼저 매수 평가를 기록해주세요)`;

  return `[매도 평가 요청] sell-evaluation.md 따라 매도 평가 카드 생성해줘.

종목: ${entry.name}
시장: ${market}
트리거: 수동 요청 (drain-eval-queue)

${cardSection}

출력 조건:
1. sell-evaluation.md §5 표준 카드 양식 (최초 ↔ 현재 ↔ 근거 점검 ↔ 리스크 점검 ↔ 판정 ↔ 권고 4안)
2. 판정 4단계: 🟢 유효 / 🟡 약화 / 🔴 훼손 / ⚪ 판단보류
3. 현재 펀더멘털 재산출: active-evaluation.md §3 동일 5축·동일 MCP
4. 분할 매도 시나리오 최소 3안 (CLAUDE.md §3)
5. 다음 재평가 시점 명시
6. 마지막에 \`\`\`json 펜스로 20필드 JSON (적재용, status는 "매도" 또는 "보류")
7. 데이터 부족 항목 추정 금지`;
}

// ── 종목투자노트에서 최초 매수 카드 조회 ────────────────────────────────────
function findEarliestBuyCard(noteRows, stockName) {
  const matches = [];
  (noteRows || []).forEach((r, idx) => {
    const name = String(r[1] ?? '').trim();
    if (name !== stockName) return;
    const status = String(r[14] ?? '').trim(); // O열: 매수여부
    if (status === '매도') return; // 매도 완료된 행은 제외
    matches.push({
      rowNum: idx + 2,
      date:       String(r[0]  ?? '').trim(),
      conclusion: String(r[4]  ?? '').trim(),
      reasons:    String(r[10] ?? '').split(/\d+\)\s*/).filter(Boolean),
      risks:      String(r[11] ?? '').split(/\d+\)\s*/).filter(Boolean),
      aiNote:     String(r[19] ?? '').trim(),
    });
  });
  // 날짜 오름차순 → 가장 오래된 = 최초 매수
  matches.sort((a, b) => a.date.localeCompare(b.date));
  return matches[0] || null;
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) console.log('🔍 DRY-RUN 모드: 시트 쓰기 없이 프롬프트만 출력합니다.\n');

  let token = explicitToken?.trim();
  if (token) {
    console.log('✓ 토큰 인수 사용\n');
  } else {
    console.log('OAuth 로그인으로 토큰 취득...');
    token = await getTokenViaBrowser();
    console.log('✓ 토큰 취득\n');
  }

  // 1. 큐 + 종목투자노트 + 4계좌 보유현황 병렬 읽기
  console.log('━━━ 평가요청 큐 읽기 ━━━');
  const [queueData, noteData, 위탁Data, 연금저축Data, ISAData, IRPData, 위탁Rebal, 연금저축Rebal] = await Promise.all([
    getRange(token, '평가요청!A2:F'),
    getRange(token, '종목투자노트!A2:U'),
    getRange(token, '위탁!A2:I'),
    getRange(token, '연금저축!A2:I'),
    getRange(token, 'ISA!A2:I'),
    getRange(token, 'IRP!A2:I'),
    getRange(token, '자산분배!B3:D9'),
    getRange(token, '자산분배!B12:D18'),
  ]);
  const rows = queueData.values || [];
  const noteRows = noteData.values || [];
  const holdingsByAcct = {
    위탁:     위탁Data.values    || [],
    연금저축: 연금저축Data.values || [],
    ISA:      ISAData.values     || [],
    IRP:      IRPData.values     || [],
  };
  const allocationData = buildAllocationData(위탁Rebal, 연금저축Rebal);

  const pending = [];
  rows.forEach((r, idx) => {
    const status = String(r[3] ?? '').trim();
    if (status === '대기') {
      pending.push({
        rowNum: idx + 2,
        requestedAt: String(r[0] ?? '').trim(),
        name: String(r[1] ?? '').trim(),
        market: String(r[2] ?? '').trim(),
        memo: String(r[5] ?? '').trim(),
      });
    }
  });

  if (pending.length === 0) {
    console.log('  처리할 의뢰가 없습니다 (대기 0건).\n');
    process.exit(0);
  }

  // 요약 출력
  const buyCount  = pending.filter(e => !isSellEval(e)).length;
  const sellCount = pending.filter(e =>  isSellEval(e)).length;
  console.log(`  대기 ${pending.length}건 (매수평가 ${buyCount}건 / 매도평가 ${sellCount}건):`);
  pending.forEach((e, i) => {
    const tag = isSellEval(e) ? '🔴매도' : '🟢매수';
    console.log(`    ${i + 1}. [${tag}] ${e.name} (${e.market || '?'}) — ${e.memo || '메모 없음'}`);
  });
  console.log('');

  const rl = createRL();
  let completed = 0;
  let errors = 0;

  for (const entry of pending) {
    const sellMode = isSellEval(entry);
    const typeLabel = sellMode ? '🔴 매도 평가' : '🟢 매수 평가';
    console.log(`\n━━━ [${entry.name}] ${typeLabel} ━━━`);

    // 매도 평가 시 최초 매수 카드 조회
    let buyCard = null;
    if (sellMode) {
      buyCard = findEarliestBuyCard(noteRows, entry.name);
      if (buyCard) {
        console.log(`  ✓ 최초 매수 카드 발견 (${buyCard.date}, ${buyCard.conclusion})`);
      } else {
        console.log(`  ⚠️ 종목투자노트에 [${entry.name}] 매수 카드 없음 — 프롬프트에 경고 포함`);
      }
    }

    // 매수 평가 시 동일 분기 기존 평가 캐시 확인
    let cachedEval = null;
    if (!sellMode) {
      cachedEval = findSameQuarterEval(noteRows, entry.name, todayKST());
      if (cachedEval) {
        console.log(`  ⚡ 분기 내 재평가 캐시 발견 (${cachedEval.date}) — 재무제표 재사용, 밸류에이션·모멘텀만 새로 fetch`);
      }
    }

    // 현재 보유현황 조회
    const holdings = findHolding(holdingsByAcct, entry.name);
    if (holdings.length > 0) {
      const summary = holdings.map(h => `${h.acct} ${h.qty}주 @${Math.round(h.avgPrice).toLocaleString('ko-KR')}원`).join(', ');
      console.log(`  📊 보유 현황: ${summary}`);
    } else {
      console.log(`  📊 보유 현황: 미보유`);
    }

    // dry-run은 시트 상태 변경 없이 프롬프트만 출력
    if (!DRY_RUN) {
      await updateCell(token, `평가요청!D${entry.rowNum}`, '처리중');
      console.log(`  ✓ 큐 상태 → 처리중`);
    }

    // 프롬프트 출력
    const prompt = sellMode ? buildSellPrompt(entry, buyCard) : buildBuyPrompt(entry, cachedEval, holdings, allocationData);
    console.log('\n┌─── Claude Pro에 붙여넣을 프롬프트 ───┐');
    console.log(prompt);
    console.log('└──────────────────────────────────────┘\n');

    if (DRY_RUN) {
      console.log('  [DRY-RUN] 시트 변경 건너뜀\n');
      continue;
    }

    const action = await ask(rl, '  Claude Pro 응답 JSON을 붙여넣으시겠습니까? (y/skip) ');

    if (action.trim().toLowerCase() === 'skip') {
      await updateCell(token, `평가요청!D${entry.rowNum}`, '대기');
      console.log(`  ↩ ${entry.name} 건너뜀, 상태 복원 → 대기`);
      continue;
    }

    console.log(`\n  Claude Pro 응답 JSON을 붙여넣으세요:`);
    const rawJson = await readMultiline(rl);

    try {
      const obj = parseEvalJson(rawJson);
      const row = buildRow(obj);

      // 종목투자노트에 적재
      await appendValues(token, '종목투자노트!A2:U', [row]);
      console.log(`  ✓ 종목투자노트에 적재 완료 (${sellMode ? '매도 평가' : '매수 평가'})`);

      // 큐 상태 업데이트
      await updateCell(token, `평가요청!D${entry.rowNum}`, '완료');
      await updateCell(token, `평가요청!E${entry.rowNum}`, nowKST());
      console.log(`  ✓ 큐 상태 → 완료 (${nowKST()})`);
      completed++;
    } catch (e) {
      console.error(`  ⚠️ 처리 실패: ${e.message}`);
      if (!DRY_RUN) {
        await updateCell(token, `평가요청!D${entry.rowNum}`, '오류');
        const existingMemo = entry.memo ? `${entry.memo} / ` : '';
        await updateCell(token, `평가요청!F${entry.rowNum}`, `${existingMemo}오류: ${e.message.slice(0, 80)}`);
      }
      errors++;
    }
  }

  if (!DRY_RUN) rl.close();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN 완료 — 시트 변경 없음`);
  } else {
    console.log(`✅ 평가요청 처리 완료`);
    console.log(`  · 완료 ${completed}건`);
    if (errors > 0) console.log(`  · 오류 ${errors}건`);
    console.log(`  모바일 banana-portfolio 평가/노트 탭에서 ↻ 새로고침하면 카드가 표시됩니다.`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => {
  console.error('\n❌ 오류:', e.message);
  process.exit(1);
});
