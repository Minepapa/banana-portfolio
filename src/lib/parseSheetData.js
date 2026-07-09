// 구글 시트 valueRanges → 앱 상태 객체 파싱 함수 모음. App.jsx에서 추출 (동작 불변).
// parseSheetData가 진입점 — 나머지는 내부 헬퍼. parseNum/DEFAULT_ACCOUNTS/computeAssets에 의존.
import { parseNum, toDateStr } from './textFormat.js';
import { DEFAULT_ACCOUNTS } from './constants.js';
import { computeAssets } from './metrics.js';

function parseMonthly(vr) {
  const rows = vr?.values ?? [];
  let lastYear = 0;
  const result = [];
  rows.forEach(r => {
    // B열(index 0): 연도 — 숫자만 추출하므로 "2024", "2024년", "2,024" 모두 처리
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;

    // C열(index 1): 월 — 숫자만 추출하므로 "1", "1월", "01" 모두 처리
    const month = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));

    // I열(index 7 in B:I 범위): 총잔고
    const total = parseNum(r[7]);

    if (!total || !month || !lastYear) return;
    const yearShort = String(lastYear).slice(-2);
    const savings = parseNum(r[2]);
    const kospi  = parseNum(r[8]);   // I열: KOSPI 월말 지수 (0이면 미입력)
    const sp500  = parseNum(r[9]);   // J열: S&P500 월말 지수 (0이면 미입력)
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total, savings, year: lastYear, kospi, sp500 });
  });
  return result;
}

function findMonthlyRow(vr) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const rows = vr?.values ?? [];
  let lastYear = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;
    const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
    if (lastYear === year && mNum === month) return 2 + i;
  }
  return null;
}

function parseDividends(vrAll) {
  const result = {};
  (vrAll?.values ?? []).forEach((r, i) => {
    const dateStr = toDateStr(r[0]);   // 시리얼/타임스탬프 → YYYY-MM-DD
    const amt  = parseNum(r[1] ?? 0);  // B열: 금액
    const name = String(r[2] ?? '').trim(); // C열: 종목명
    if (!dateStr || !amt) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, amount: 0, items: [] };
    result[key].amount += amt;
    // row: 배당금!A2:C 기준 시트 행번호 (종목명 편집 시 C열 타겟)
    result[key].items.push({ date: dateStr, name, amount: amt, row: i + 2 });
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

function parseProfits(vr) {
  const result = {};
  (vr?.values ?? []).forEach(r => {
    const dateStr = toDateStr(r[0]);   // 시리얼/타임스탬프 → YYYY-MM-DD
    const name    = String(r[1] ?? '').trim();
    const profit  = parseNum(r[5]); // F열: 수익금
    if (!dateStr) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year  = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, total: 0, items: [] };
    result[key].total += profit;
    if (name) result[key].items.push({ date: dateStr, name, profit });
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

// 결론(E) 표준 어휘 — 단일 통합 4단계 (매수·매도 공통). 이모지가 표준 단어를 결정.
const CONCLUSION_STD = { '🟢': '🟢 유효', '🟡': '🟡 관망', '🔴': '🔴 부적합', '⚪': '⚪ 판단보류' };
function normalizeConclusion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 이모지 우선 (includes — 정규식 charclass의 surrogate 깨짐 회피)
  if (s.includes('🟢')) return CONCLUSION_STD['🟢'];
  if (s.includes('🟡')) return CONCLUSION_STD['🟡'];
  if (s.includes('🔴')) return CONCLUSION_STD['🔴'];
  if (s.includes('⚪')) return CONCLUSION_STD['⚪'];
  // 이모지 없으면 단어로 추정 (구체→일반 순서)
  if (/판단\s*보류/.test(s)) return CONCLUSION_STD['⚪'];
  if (/부적합|훼손|불가|매도|\bX\b/i.test(s)) return CONCLUSION_STD['🔴'];
  if (/관망|약화|보류|축소|△/.test(s)) return CONCLUSION_STD['🟡'];
  if (/유효|적합|매수|\bO\b/i.test(s)) return CONCLUSION_STD['🟢'];
  return s;
}

// 종목투자노트 탭 (playbook §6 컬럼 A~T) → 평가 카드 객체 배열
function parseEvaluations(vr) {
  const rows = vr?.values ?? [];
  const splitNumbered = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return [];
    // "1) ... 2) ..." or "1. ... 2. ..." or 줄바꿈 분리
    if (/\d[).]\s/.test(t)) {
      return t.split(/(?=\d[).]\s)/).map(x => x.replace(/^\d[).]\s*/, '').trim()).filter(Boolean);
    }
    return t.split(/[\n;]+/).map(x => x.trim()).filter(Boolean);
  };
  const splitBullets = (s) => splitNumbered(s).length
    ? splitNumbered(s)
    : String(s ?? '').split(/\.\s+(?=[A-Z가-힣])/).map(x => x.trim()).filter(Boolean);

  return rows.map(r => {
    const date = toDateStr(r[0]);      // 시리얼/타임스탬프 → YYYY-MM-DD
    const name = String(r[1] ?? '').trim();
    if (!date || !name) return null;
    return {
      stock: {
        name,
        ticker: String(r[2] ?? '').trim(),
        market: String(r[3] ?? '').trim(),
      },
      date,
      conclusion: { raw: normalizeConclusion(r[4]) },
      axisGrades: {
        수익성:     String(r[5] ?? '').trim(),
        안정성:     String(r[6] ?? '').trim(),
        밸류에이션: String(r[7] ?? '').trim(),
        현금흐름:   String(r[8] ?? '').trim(),
        모멘텀:     String(r[9] ?? '').trim(),
      },
      reasons:   splitNumbered(r[10]),
      risks:     splitNumbered(r[11]),
      actions:   splitBullets(r[12]),
      frankMemo: String(r[13] ?? '').trim(),
      status:    String(r[14] ?? '').trim(),  // 매수 / 보류 / 매도
      buyDate:   String(r[15] ?? '').trim(),
      buyPrice:  String(r[16] ?? '').trim(),
      targetTerm:(() => { const v = String(r[17] ?? '').trim(); return v.startsWith('#') ? '' : v; })(),
      targetRet: (() => { const v = String(r[18] ?? '').trim(); return v.startsWith('#') ? '' : v; })(),
      aiNote:    String(r[19] ?? '').trim(),
      axisItems: (() => { try { const v = String(r[20] ?? '').trim(); return v ? JSON.parse(v) : null; } catch { return null; } })(),
    };
  }).filter(Boolean).reverse();  // 최신순
}

// 평가요청 큐 (컬럼 A~F) → { entries, counts }
function parseEvalQueue(vr) {
  const rows = vr?.values ?? [];
  const entries = rows.map((r, idx) => {
    const requestedAt = toDateStr(r[0]);   // 시리얼/타임스탬프 → YYYY-MM-DD
    const name = String(r[1] ?? '').trim();
    if (!requestedAt || !name) return null;
    return {
      rowIndex: idx,
      requestedAt,
      name,
      market: String(r[2] ?? '').trim(),
      status: String(r[3] ?? '').trim() || '대기',
      processedAt: String(r[4] ?? '').trim(),
      memo: String(r[5] ?? '').trim(),
    };
  }).filter(Boolean);

  const counts = entries.reduce((acc, e) => {
    const k = e.status === '완료' ? 'done'
            : e.status === '처리중' ? 'processing'
            : e.status === '오류' ? 'error'
            : 'pending';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, { pending: 0, processing: 0, done: 0, error: 0 });

  // 최신 요청 순으로 정렬해서 반환
  return { entries: entries.slice().reverse(), counts };
}

// 주간리포트 파서 (날짜, 요약, 본문) → 최신순 배열
function parseWeeklyReports(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = toDateStr(r[0]);      // 시리얼/타임스탬프 → YYYY-MM-DD
    if (!date) return null;
    return { date, summary: String(r[1] ?? '').trim(), body: String(r[2] ?? '').trim() };
  }).filter(Boolean).reverse();
}

// 포지션저널 파서 (A~P) → 거래 생애주기 전제 배열. 보유 우선, 그 안에서 시트 순서 유지
function parsePositionJournal(vr) {
  const rows = vr?.values ?? [];
  const list = rows.map((r, idx) => {
    const name = String(r[0] ?? '').trim();
    if (!name) return null;
    return {
      rowIndex: idx,            // 시트 행 = idx + 2 (A2 기준)
      name,
      ticker:  String(r[1] ?? '').trim(),
      market:  String(r[2] ?? '').trim(),
      account: String(r[3] ?? '').trim(),
      kind:    String(r[4] ?? '').trim(),   // 배분 / 확신
      thesis:  String(r[5] ?? '').trim(),
      target:  String(r[6] ?? '').trim(),
      exit:    String(r[7] ?? '').trim(),
      hold:    String(r[8] ?? '').trim(),
      entry:   toDateStr(r[9]),                        // 진입일 — 시리얼 방어
      status:  String(r[10] ?? '').trim() || '보유',  // 보유 / 청산
      exitDate:toDateStr(r[11]),                       // 청산일 — 시리얼 방어
      result:  String(r[12] ?? '').trim(),
      lesson:  String(r[13] ?? '').trim(),
      confirm: String(r[14] ?? '').trim() || '미작성',  // 대기 / 확인 / 미작성
      updated: String(r[15] ?? '').trim(),
    };
  }).filter(Boolean);
  // 보유 먼저, 청산 뒤로
  return list.sort((a, b) => (a.status === '청산' ? 1 : 0) - (b.status === '청산' ? 1 : 0));
}

// 성향관찰 파서 (날짜,신호유형,관찰,증거,§3대비,신뢰도,상태,갱신시각) → 최신순.
// 행동 학습 로그 — 앱 성향확인 탭이 표시·확정/기각. rowIndex로 G(상태)·H(갱신) writeback.
function parsePreferences(vr) {
  const rows = vr?.values ?? [];
  return rows.map((r, idx) => {
    const observation = String(r[2] ?? '').trim();
    if (!observation) return null;
    return {
      rowIndex: idx,                                  // 시트 행 = idx + 2 (A2 기준)
      date:       toDateStr(r[0]),                    // 시리얼/타임스탬프 → YYYY-MM-DD
      type:       String(r[1] ?? '').trim(),          // 신호유형
      observation,
      evidence:   String(r[3] ?? '').trim(),          // 근거(체결·평가·저널·발화)
      vsProfile:  String(r[4] ?? '').trim(),          // 일치(보강) | 신규 | 상충
      confidence: String(r[5] ?? '').trim(),          // 높음 | 보통 | 낮음
      status:     String(r[6] ?? '').trim() || '관찰', // 관찰 | 승격후보 | 확정 | 기각
      updated:    String(r[7] ?? '').trim(),
    };
  }).filter(Boolean).reverse();                       // 최신이 위로
}

// 보유 포지션 × 리스크 신호(🟡/🔴) 조인 → 전제 점검 대상 [{ position, signal }]
// riskMonitor 는 최신순 → find 가 최신 신호를 반환. target 은 종목명 또는 코드.
// 리스크모니터 파서 (날짜,유형,대상,신호,요약,상세,근거,기준선참조) → 최신순
function parseRiskMonitor(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = toDateStr(r[0]);      // 시리얼/타임스탬프 → YYYY-MM-DD
    if (!date) return null;
    return {
      date,
      type: String(r[1] ?? '').trim(),       // B(논리) | D(거시)
      target: String(r[2] ?? '').trim(),
      signal: String(r[3] ?? '').trim(),     // 🟢 | 🟡 | 🔴
      summary: String(r[4] ?? '').trim(),
      detail: String(r[5] ?? '').trim(),
      evidence: String(r[6] ?? '').trim(),   // JSON 문자열
      baselineRef: String(r[7] ?? '').trim(),
    };
  }).filter(Boolean).reverse();
}

// 리스크기준선 파서 (종목,티커,시장,기준일,매총이,영익,ROE,부채,EPS,비고)
function parseBaselines(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const name = String(r[0] ?? '').trim();
    if (!name) return null;
    return {
      name,
      ticker: String(r[1] ?? '').trim(),
      market: String(r[2] ?? '').trim(),
      date: String(r[3] ?? '').trim(),
      grossMargin: String(r[4] ?? '').trim(),
      operatingMargin: String(r[5] ?? '').trim(),
      roe: String(r[6] ?? '').trim(),
      debtRatio: String(r[7] ?? '').trim(),
      eps: String(r[8] ?? '').trim(),
      note: String(r[9] ?? '').trim(),
    };
  }).filter(Boolean);
}

// 주문제안 파서 (A~N) — 컬럼 레이아웃은 scripts/lib/sheet-contracts.mjs PROPOSAL_COL 계약과
// 동일(브라우저라 import 불가 → parseSheetData.test.js 핀 테스트가 정합 고정).
// rowNum(1-base 시트 행번호)은 승인/기각 writeRange에 필요.
function parseProposals(vr) {
  const rows = vr?.values ?? [];
  const safeJson = (str, fb) => { try { return JSON.parse(String(str ?? '') || 'null') ?? fb; } catch { return fb; } };
  return rows.map((r, i) => {
    const name = String(r[4] ?? '').trim();
    if (!name) return null;
    return {
      rowNum: i + 2,
      date: toDateStr(r[0]),                    // 시리얼 방어 (표시·정렬 일관성)
      source: String(r[1] ?? '').trim(),
      acct: String(r[2] ?? '').trim(),
      side: String(r[3] ?? '').trim(),          // 매수/매도
      name,
      qty: parseNum(r[5]),
      price: parseNum(r[6]),
      amount: parseNum(r[7]),
      rationale: safeJson(r[8], { text: '', facts: {} }),
      checks: safeJson(r[9], []),
      status: String(r[10] ?? '').trim() || '제안',
      responded: String(r[11] ?? '').trim(),
      rejectReason: String(r[12] ?? '').trim(),
      matchKey: String(r[13] ?? '').trim(),
    };
  }).filter(Boolean).reverse();                  // 최신 먼저
}

// 일별스냅샷 파서 — 최신 1행(max 날짜)만 "오늘 기준선"으로 반환. 빈 시트/미존재 → null.
// A날짜 B스냅시각 C총평가 D계좌별JSON E종목별JSON. JSON 파싱 실패 시 해당 필드 빈 객체.
function parseDailySnapshot(vr) {
  const rows = vr?.values ?? [];
  let latest = null;
  for (const r of rows) {
    const date = toDateStr(r[0]);
    if (!date) continue;
    if (!latest || date > latest._date) latest = { _date: date, row: r };
  }
  if (!latest) return null;
  const r = latest.row;
  const safeJson = (s) => { try { return JSON.parse(String(s ?? '') || '{}'); } catch { return {}; } };
  const totalEval = parseNum(r[2]);
  if (!(totalEval > 0)) return null;               // 총평가 0 = 오염된 기준선 → 무시(폴백 유도)
  return {
    date: latest._date,
    ts: String(r[1] ?? '').trim() || latest._date,
    totalEval,
    byAccount: safeJson(r[3]),
    byHolding: safeJson(r[4]),
  };
}

export function parseSheetData(valueRanges) {
  // indices: ISA(0) 위탁(1) 연금저축(2) IRP(3)
  //          위탁리밸(4) 연금저축리밸(5) ISA리밸(6) IRP리밸(7)
  //          월별잔고(8) 배당금(9)
  const accountKeys = ['ISA', '위탁', '연금저축', 'IRP'];
  const result = {};
  let anyData = false;

  accountKeys.forEach((key, i) => {
    const allRows = valueRanges[i]?.values ?? [];
    let lastType = '';
    const holdings = [];
    allRows.forEach((r, rowOffset) => {
      if (!r[1]) return;
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type;
      holdings.push({
        name: String(r[1] ?? ''),
        price: parseNum(r[2]),
        qty: parseNum(r[3]),
        invest: parseNum(r[4]),
        currentPrice: parseNum(r[5]),
        eval: parseNum(r[7]),
        profit: parseNum(r[6]),
        rate: parseNum(r[8]),
        type: lastType,
        rowOffset,
      });
    });
    if (!holdings.length) return;
    anyData = true;

    const total_invest = holdings.reduce((s, h) => s + h.invest, 0);
    const total_eval = holdings.reduce((s, h) => s + h.eval, 0);
    const isCash = (h) => h.name === '예수금' || (key === '연금저축' && String(h.name).includes('MMF'));
    const nonCashHoldings = holdings.filter(h => !isCash(h));
    const asset_eval = nonCashHoldings.reduce((s, h) => s + h.eval, 0);

    result[key] = {
      ...DEFAULT_ACCOUNTS[key],
      total_invest,
      total_eval,
      profit: total_eval - total_invest,
      holdings,
      assets: computeAssets(nonCashHoldings, asset_eval || total_eval, DEFAULT_ACCOUNTS[key].assets),
    };
  });

  // 리밸런싱: 각 계좌별 단일 범위 [목표비율(B), 현재비율(C), 리밸런싱금액(D)]
  const parseRebalRows = (vr) => {
    const rows = vr?.values ?? [];
    return {
      targets:  rows.map(r => parseNum(r[0])),
      currents: rows.map(r => parseNum(r[1])),
      rebals:   rows.map(r => parseNum(r[2])),
    };
  };

  if (result['위탁']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[4]);
    result['위탁'].assets = result['위탁'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['연금저축']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[5]);
    result['연금저축'].assets = result['연금저축'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['ISA']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[6]);
    result['ISA'].assets = result['ISA'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  if (result['IRP']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[7]);
    result['IRP'].assets = result['IRP'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  const monthly = parseMonthly(valueRanges[8]);
  const monthlyRow = findMonthlyRow(valueRanges[8]);
  const dividends = parseDividends(valueRanges[9]);
  const profits = parseProfits(valueRanges[10]);
  const evaluations = parseEvaluations(valueRanges[11]);
  const evalQueue = parseEvalQueue(valueRanges[12]);
  const weeklyReports = parseWeeklyReports(valueRanges[13]);
  const riskMonitor = parseRiskMonitor(valueRanges[14]);
  const baselines = parseBaselines(valueRanges[15]);
  const positionJournal = parsePositionJournal(valueRanges[16]);
  const usdRate = parseNum(valueRanges[17]?.values?.[0]?.[0]);
  const preferences = parsePreferences(valueRanges[18]);
  const dailySnapshot = parseDailySnapshot(valueRanges[19]);
  const proposals = parseProposals(valueRanges[20]);

  return anyData ? { accounts: result, monthly, monthlyRow, dividends, profits, evaluations, evalQueue, weeklyReports, riskMonitor, baselines, positionJournal, usdRate, preferences, dailySnapshot, proposals } : null;
}
