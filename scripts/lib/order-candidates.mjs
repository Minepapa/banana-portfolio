// 주문 후보 조립기 — 순수 함수(네트워크 없음, 테스트 order-candidates.test.js).
// 신호(리밸런싱 갭·급락O·논리훼손B·평가🟢) raw rows에서 "완성된 주문서 후보"를 결정론으로
// 산출한다. AI는 이 후보 중 최종 선택·근거 산문만 담당(코드베이스 철학: 숫자는 LLM이 안 만든다).
//
// 단가는 계좌 시트 F열(위탁 해외주식은 USD)이 아니라 평가금/수량(H/D, 항상 KRW)을 쓴다 —
// 수량 산출이 통화 혼동 없이 원화 기준으로 일관되게 하기 위함.

import { NOTE_COL as N, JOURNAL_COL as J, RISK_COL as R, EXEC_COL as T, JOURNAL_STATUS, PROPOSAL_SOURCE } from './sheet-contracts.mjs';

export const RULE500_WON = 5_000_000;   // 1회 매수 상한 (profile §3 — 확신 종목은 예외 라벨)
export const GAP_TRIGGER_PCT = 5;       // 리밸런싱 갭 트리거 ±5%p (오늘탭·자산분배와 동일)

const s = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,%+\s]/g, '')); return Number.isFinite(n) ? n : null; };

// 시트 날짜 셀 → 'YYYY-MM-DD'. 일반 서식 셀은 구글 시리얼(예: 46193)로 오는데, 이를 그대로
// 두면 ISO 문자열과의 사전순 비교가 항상 어긋나고(예: '2026-07-09' < '46193') 근거 체인에도
// 시리얼이 노출된다. src/lib/textFormat.js toDateStr와 동일 변환(브라우저 모듈이라 import 불가).
export function toDateStr(v) {
  const str = s(v);
  if (!str) return '';
  if (/^\d+(\.\d+)?$/.test(str)) {
    const serial = parseFloat(str);
    if (serial > 1) {
      const d = new Date(Math.round((serial - 25569) * 86400000));
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
  }
  return str.slice(0, 10);
}

// 현금성 행 — 주문 대상 아님 (movers.js isCashLike와 동일 기준)
const isCashLike = (name) => {
  const n = s(name);
  return n === '예수금' || n === '외화 RP' || n.includes('MMF');
};

// ── 공통 파서 ────────────────────────────────────────────────────────────────

// 계좌 시트 raw rows(A2:I) → 보유 목록. 자산군(A열)은 병합셀이라 직전 값 유지.
export function parseHoldingRows(acct, rows) {
  const out = [];
  let lastType = '';
  for (const r of rows || []) {
    const type = s(r[0]); if (type) lastType = type;
    const name = s(r[1]); if (!name || isCashLike(name)) continue;
    const qty = num(r[3]) ?? 0;
    const evalWon = num(r[7]) ?? 0;
    if (!(qty > 0) || !(evalWon > 0)) continue;
    out.push({ acct, name, assetType: lastType, qty, evalWon, unitKrw: evalWon / qty });
  }
  return out;
}

// 종목투자노트 → 종목별 최신 카드 {date, emoji(🟢🟡🔴⚪|null), isSell}
// (parseSheetData normalizeConclusion과 동일한 이모지 우선 판별 — 산문 결론도 안전)
export function latestConclusions(noteRows) {
  const map = new Map();
  for (const r of noteRows || []) {
    const name = s(r[N.NAME]); if (!name) continue;
    const date = toDateStr(r[N.DATE]);   // 시리얼 → ISO (비교·근거 표기 일관성)
    const concl = s(r[N.CONCL]);
    const emoji = concl.includes('🟢') ? '🟢' : concl.includes('🟡') ? '🟡'
      : concl.includes('🔴') ? '🔴' : concl.includes('⚪') ? '⚪' : null;
    const isSell = s(r[N.STATUS]) === '매도';
    const targetRet = s(r[N.TARGET_RET]);
    const prev = map.get(name);
    if (!prev || date > prev.date) map.set(name, { date, emoji, isSell, concl, targetRet });
  }
  return map;
}

// 포지션저널 → 보유 종목의 유형 맵 (확신|배분). 미기재는 배분 취급.
export function convictionMap(journalRows) {
  const map = new Map();
  for (const r of journalRows || []) {
    if (s(r[J.STATUS]) === JOURNAL_STATUS.CLOSED) continue;
    const name = s(r[J.NAME]); if (!name) continue;
    map.set(name, s(r[J.KIND]) === '확신' ? '확신' : '배분');
  }
  return map;
}

// 리스크모니터 → 유형별 종목당 최신 신호 {signal, summary, date}
export function latestRiskByType(riskRows, type) {
  const map = new Map();
  for (const r of riskRows || []) {
    if (s(r[R.TYPE]) !== type) continue;
    const target = s(r[R.TARGET]); if (!target) continue;
    const date = s(r[R.DATE]);
    const prev = map.get(target);
    if (!prev || date > prev.date) map.set(target, { date, signal: s(r[R.SIGNAL]), summary: s(r[4]) });
  }
  return map;
}

// ── 후보 생성 ────────────────────────────────────────────────────────────────

// 리밸런싱: 갭 ±5%p 자산군 → 매도(초과)/매수(부족) 후보 1건씩.
// 매도 선정: 확신 제외 → 평가 나쁜 순(🔴>🟡>무평가>🟢) → 평가금 큰 순(한 번에 갭 해소).
// 매수 선정: 해당 자산군 기존 보유 중 평가금 큰 순(기존 포지션에 적립 — 신규 종목 발굴은 평가 큐 소관).
// gaps: [{acct, assetType, targetPct, currentPct, rebalAmt}] (rebalAmt: +매수/−매도 필요 원화)
export function buildRebalanceCandidates({ gaps, holdings, conviction, conclusions }) {
  const out = [];
  const sellRank = { '🔴': 0, '🟡': 1, null: 2, '⚪': 2, '🟢': 3 };
  for (const g of gaps || []) {
    const gapPct = (g.currentPct ?? 0) - (g.targetPct ?? 0);
    if (Math.abs(gapPct) < GAP_TRIGGER_PCT) continue;
    const amt = Math.abs(g.rebalAmt ?? 0);
    if (!(amt > 0)) continue;
    const pool = (holdings || []).filter(h => h.acct === g.acct && h.assetType === g.assetType);
    if (!pool.length) continue;

    if (gapPct > 0) {   // 초과 → 매도
      const ranked = pool
        .filter(h => (conviction.get(h.name) ?? '배분') !== '확신')
        .sort((a, b) => {
          const ra = sellRank[conclusions.get(a.name)?.emoji ?? null] ?? 2;
          const rb = sellRank[conclusions.get(b.name)?.emoji ?? null] ?? 2;
          return ra !== rb ? ra - rb : b.evalWon - a.evalWon;
        });
      const pick = ranked[0];
      if (!pick) continue;   // 전부 확신 종목 → 매도 제안 없음(성향 존중)
      const qty = Math.min(Math.floor(amt / pick.unitKrw), pick.qty);
      if (qty < 1) continue;
      out.push(mk(PROPOSAL_SOURCE.REBALANCE, pick.acct, '매도', pick.name, qty, pick.unitKrw, {
        갭: `${g.assetType} ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(1)}%p (${g.rebalAmt.toLocaleString()}원)`,
        선정: `확신 제외 · 평가 ${conclusions.get(pick.name)?.emoji ?? '무평가'} · 자산군 내 최대 포지션`,
      }));
    } else {            // 부족 → 매수
      const pick = [...pool].sort((a, b) => b.evalWon - a.evalWon)[0];
      const qty = Math.floor(amt / pick.unitKrw);
      if (qty < 1) continue;
      out.push(mk(PROPOSAL_SOURCE.REBALANCE, pick.acct, '매수', pick.name, qty, pick.unitKrw, {
        갭: `${g.assetType} ${gapPct.toFixed(1)}%p (+${amt.toLocaleString()}원 필요)`,
        선정: '해당 자산군 기존 최대 보유에 적립',
      }));
    }
  }
  return out;
}

// 급락(O🔴) 매수: 보유 종목의 급락 신호 → 500만·예수금 이내 매수.
export function buildCrashBuyCandidates({ oSignals, holdings, cash }) {
  const out = [];
  for (const [name, sig] of oSignals || new Map()) {
    if (!sig.signal.includes('🔴')) continue;
    const h = (holdings || []).find(x => x.name === name);   // 보유 계좌 그대로 추가 매수
    if (!h) continue;
    const budget = Math.min(RULE500_WON, cash?.[h.acct] ?? 0);
    const qty = Math.floor(budget / h.unitKrw);
    if (qty < 1) continue;
    out.push(mk(PROPOSAL_SOURCE.CRASH, h.acct, '매수', name, qty, h.unitKrw, {
      신호: `${sig.date} 급락O🔴 — ${sig.summary}`.slice(0, 120),
      성향: '급락 저점매수 선호(확정 성향)와 정합',
    }));
  }
  return out;
}

// 논리훼손(B🔴): 최신 매도평가 카드가 매도 결론(🔴)이면 매도 후보, 없으면 매도평가 자동 의뢰.
// (근거 없는 매도 주문은 안 만든다 — 평가 파이프라인이 정본 판단 경로)
export function buildSellFromThesis({ bSignals, holdings, conviction, conclusions }) {
  const candidates = [], evalRequests = [];
  for (const [name, sig] of bSignals || new Map()) {
    if (!sig.signal.includes('🔴')) continue;
    const h = (holdings || []).find(x => x.name === name);
    if (!h) continue;
    const card = conclusions.get(name);
    if (card?.isSell && card.emoji === '🔴') {
      candidates.push(mk(PROPOSAL_SOURCE.THESIS, h.acct, '매도', name, h.qty, h.unitKrw, {
        신호: `${sig.date} 논리훼손B🔴 — ${sig.summary}`.slice(0, 120),
        평가: `매도평가 ${card.date} 🔴(부적합) — 전량 매도`,
        확신도: conviction.get(name) ?? '배분',
      }));
    } else {
      evalRequests.push({ name, reason: `논리훼손B🔴 (${sig.date}) — 매도평가 필요` });
    }
  }
  return { candidates, evalRequests };
}

// 평가🟢 후 미매수: 🟢 유효 매수평가가 있는데 평가일 이후 매수 체결이 없는 종목 → 매수 후보.
// 미보유 종목은 단가를 모름 → price=null 로 반환, 잡이 yfinance로 채운다(순수/네트워크 분리).
export function buildBuyFromEval({ conclusions, execRows, holdings, cash, defaultAcct = '위탁' }) {
  const out = [];
  const buys = (execRows || []).filter(r => s(r[T.SIDE]) === '매수')
    .map(r => ({ name: s(r[T.NAME]), date: toDateStr(r[T.DATE]) }));   // 시리얼 방어 + 날짜만
  for (const [name, card] of conclusions || new Map()) {
    if (card.isSell || card.emoji !== '🟢') continue;
    if (buys.some(b => b.name === name && b.date >= card.date)) continue;   // 이미 실행함
    const h = (holdings || []).find(x => x.name === name);
    const acct = h?.acct ?? defaultAcct;
    const budget = Math.min(RULE500_WON, cash?.[acct] ?? 0);
    if (!(budget > 0)) continue;
    const qty = h ? Math.floor(budget / h.unitKrw) : null;   // 미보유 → 잡이 단가 해결 후 산출
    if (h && qty < 1) continue;
    out.push(mk(PROPOSAL_SOURCE.EVAL, acct, '매수', name, qty, h?.unitKrw ?? null, {
      평가: `${card.date} 🟢 유효 — 이후 미매수(선별 실행 중이던 종목)`,
    }));
  }
  return out;
}

// 보유 종목별 회전(로테이션) 판단 재료 — 이미 읽고 있는 raw rows에서 조립하는 순수함수
// (신규 네트워크 호출 없음). AI가 "이 급락 후보로 교체할 만큼 상승여력이 낮은 기존 보유"를
// 판단할 때 근거로 쓴다. conviction(확신/배분)은 그대로 노출만 하고, 확신 종목을 매도 후보에서
// 제외하는 건 소비자(order-proposals.mjs 프롬프트·검증)가 conviction!=='확신' 필터로 한다 —
// buildRebalanceCandidates가 이미 쓰는 것과 동일 원칙, 이 함수는 판단 재료 조립만 담당.
export function buildHoldingsFacts({ holdings, conclusions, conviction, journalRows }) {
  const targets = new Map();
  for (const r of journalRows || []) {
    if (s(r[J.STATUS]) === JOURNAL_STATUS.CLOSED) continue;
    const name = s(r[J.NAME]); if (!name) continue;
    const target = s(r[J.TARGET]);
    if (target) targets.set(name, target);
  }
  return (holdings || []).map(h => {
    const card = (conclusions || new Map()).get(h.name);
    return {
      name: h.name,
      acct: h.acct,
      evalWon: h.evalWon,
      qty: h.qty,
      conviction: (conviction || new Map()).get(h.name) ?? '배분',
      grade: card?.emoji ?? null,
      gradeDate: card?.date ?? null,
      gradeText: card?.concl ? s(card.concl).slice(0, 200) : '',
      target: targets.get(h.name) ?? '',
      targetRet: card?.targetRet ?? '',
    };
  });
}

// ── 논리훼손 가드 ────────────────────────────────────────────────────────────

// 최근 논리훼손(B🔴)에서 막 회복한 종목 감지 — "차단해제"는 Zeus 결정 게이트(헌장 §2,
// 리스크실 의무 반대검증 선행)다. 애초엔 이 함수가 리스크모니터 시트의 B이력에서 직전↔최신
// 전환을 직접 재구성하려 했으나, risk-monitor.mjs의 pruneRiskSheet가 매 실행 끝에 종목당
// 최신 B행 1개만 남겨(시트 자체엔 "직전 신호가 뭐였는지"가 안 남음) 이 시점엔 이미 이력이
// 사라진 뒤라 절대 발동하지 않는 죽은 게이트였다(구조조정 안건7, code-reviewer 지적으로
// 발견). 그래서 감지는 risk-monitor.mjs가 전환이 실제로 일어나는 순간(프루닝 전) 별도
// 영구 로그(차단해제이력 시트)에 남기고, 이 함수는 그 로그를 읽어 "아직 Zeus 미확인"인
// 항목만 반환한다. 14일 이내로 창을 두는 이유: 무기한 누적 방지(다른 경고 플래그와 동일한
// 자연 소멸 방식) — 그 안에 Zeus가 검토하지 않으면 조용히 사라지되, 리스크실 상시감시(B)가
// 계속 지켜보므로 재훼손 시엔 새 로그 행으로 다시 걸린다.
// releaseRows: 차단해제이력 시트 원본 행(감지일시|종목명|이전신호일|신규신호일|신규신호).
// todayStr: 'YYYY-MM-DD' 기준일(순수함수 유지 — 내부에서 현재시각을 직접 조회하지 않음).
const RELEASE_WINDOW_DAYS = 14;

function daysBeforeStr(dateStr, days) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function detectThesisReleases(releaseRows, todayStr) {
  const cutoff = todayStr ? daysBeforeStr(todayStr, RELEASE_WINDOW_DAYS) : null;
  const releases = new Map();
  for (const r of releaseRows || []) {
    const name = s(r[1]); if (!name) continue;
    const detectedAt = s(r[0]);
    if (cutoff && detectedAt.slice(0, 10) < cutoff) continue;
    const prevBest = releases.get(name);
    if (prevBest && prevBest.detectedAt >= detectedAt) continue;   // 같은 종목은 최신 감지만
    releases.set(name, { detectedAt, from: s(r[2]), to: s(r[3]), newSignal: s(r[4]) });
  }
  return releases;
}

// 매수 후보를 B(논리) 신호와 대조. playbook §4.1(급락매수 전제=펀더멘털 훼손 없음) +
// 리스크 우선순위 B(논리)>가격을 코드로 강제한다(Frank 결정 2026-07: 🔴제외·🟡경고유지).
//   B🔴(훼손)  → 매수 부적합 → dropped 로 분리(주문에서 제외).
//   B🟡(약화)  → 급락 저점매수 선호 존중 → 유지하되 why.논리충돌 스탬프(주문 탭에 ✗ 노출).
//   B🟢/무신호 → 통과. 매도 후보는 대상 아님(B🔴 매도는 buildSellFromThesis가 정본 처리).
//   막 회복(releases)  → 통과하되 why.차단해제대기 스탬프 — Zeus 반대검증 확인 전엔 다른
//   후보와 섞여 보이지 않도록 표시만 한다(자동 차단은 아님 — 최종 판단은 Zeus/Frank).
// bSignals: latestRiskByType(riskRows, 'B') 결과(Map name→{signal, summary, date}).
// releases: detectThesisReleases(releaseRows, todayStr) 결과(Map name→{detectedAt, from, to, newSignal}).
export function applyThesisGuard(candidates, bSignals, releases) {
  const kept = [], dropped = [];
  for (const c of candidates || []) {
    if (c.side !== '매수') { kept.push(c); continue; }
    const b = (bSignals || new Map()).get(c.name);
    const sig = b?.signal ?? '';
    if (sig.includes('🔴')) {
      dropped.push({ ...c, reason: `논리훼손B🔴 (${b.date}) — 매수 부적합, 주문 제외` });
      continue;
    }
    if (sig.includes('🟡')) {
      c.why = { ...c.why, 논리충돌: `B🟡 논리약화 (${b.date}) — ${b.summary}`.slice(0, 120) };
    }
    const rel = (releases || new Map()).get(c.name);
    if (rel) {
      c.why = { ...c.why, 차단해제대기: `B🔴(${rel.from})→${rel.newSignal}(${rel.to}) 최근 회복 — Zeus 반대검증 확인 필요(헌장 §2)`.slice(0, 120) };
    }
    kept.push(c);
  }
  return { kept, dropped };
}

// ── 제약 검증 (J열 JSON) ─────────────────────────────────────────────────────

// 후보별 체크리스트. ok=false 가 있어도 후보는 유지(카드에 ✗로 표시 — 최종 판단은 Frank).
export function checkConstraints(c, { cash, conviction }) {
  const checks = [];
  if (c.side === '매수') {
    const avail = cash?.[c.acct] ?? 0;
    checks.push({ k: '예수금', ok: c.amount != null ? avail >= c.amount : null,
      d: `${c.acct} ${Math.round(avail).toLocaleString()}원 보유${c.amount != null ? ` / 주문 ${Math.round(c.amount).toLocaleString()}원` : ''}` });
    if (c.amount != null) {
      const within = c.amount <= RULE500_WON;
      const conv = conviction.get(c.name) === '확신';
      checks.push({ k: '500만원칙', ok: within || conv,
        d: within ? `${Math.round(c.amount).toLocaleString()}원 ≤ 500만` : (conv ? '초과하나 확신 종목 예외(확정 성향)' : '500만 초과') });
    }
    // 논리훼손 가드가 스탬프한 충돌(B🟡) — 급락매수여도 펀더멘털 약화를 명시(최종 판단은 Frank).
    if (c.why?.논리충돌) checks.push({ k: '논리상태', ok: false, d: c.why.논리충돌 });
    // 차단해제 대기(구조조정 안건7) — B🔴에서 막 회복한 종목은 Zeus 반대검증 확인 전엔
    // 다른 후보와 섞여 조용히 통과하지 않도록 체크리스트에 별도로 노출한다.
    if (c.why?.차단해제대기) checks.push({ k: '차단해제확인', ok: false, d: c.why.차단해제대기 });
  } else {
    checks.push({ k: '확신보호', ok: conviction.get(c.name) !== '확신',
      d: conviction.get(c.name) === '확신' ? '확신 종목 매도 — 재확인 필요' : '배분형 — 매도 가능' });
  }
  return checks;
}

export const makeMatchKey = (c) => `${c.acct}|${c.name}|${c.side}`;

// AI가 회전(로테이션) 매도로 지목한 종목명을 보유 데이터와 대조해 결정론으로 후보 조립.
// 순수함수 — 시트 I/O·activeKeys 원본 없이 호출부가 넘긴 값만으로 판단(테스트 가능).
// 반환: 유효하면 {candidate, reason:null}, 무효면 {candidate:null, reason:'왜 거절했는지'}.
//   sellName/buyName: AI가 지목한 매도 종목명 / 이 회전과 짝지어질 매수 후보 종목명(자기참조 방지).
//   holdings: parseHoldingRows 결과(수량·단가 소스).
//   rotatable: 확신 종목이 이미 빠진 holdingsFacts 부분집합(호출부가 conviction!=='확신'으로 필터).
//   isDuplicateKey(matchKey): 이미 대기/승인 중이거나 이번 실행에서 이미 나온 매도인지 판단하는 호출부 콜백.
export function resolveRotationSell({ sellName, buyName, holdings, rotatable, isDuplicateKey }) {
  const name = s(sellName);
  if (!name) return { candidate: null, reason: '이름 없음' };
  if (name === buyName) return { candidate: null, reason: '자기참조(매수 후보와 동일 종목)' };
  const h = (holdings || []).find(x => x.name === name);
  const fact = (rotatable || []).find(f => f.name === name);
  if (!h || !fact) return { candidate: null, reason: '보유 미확인 또는 확신 종목' };
  const candidate = mk(PROPOSAL_SOURCE.ROTATION, h.acct, '매도', h.name, h.qty, h.unitKrw, {
    회전: `${buyName} 매수와 연동된 회전 매도`,
  });
  if (isDuplicateKey && isDuplicateKey(makeMatchKey(candidate))) {
    return { candidate: null, reason: '이미 대기/승인 중이거나 이번 실행에서 이미 제안된 매도' };
  }
  return { candidate, reason: null };
}

// AI가 회전(로테이션) 매도측을 새로 지목했을 때 order-proposals.mjs가 동일 후보 형태로
// 결정론 조립하기 위해 export(그 외 내부 빌더들과 동일 계약).
export function mk(source, acct, side, name, qty, unitKrw, why) {
  const price = unitKrw != null ? Math.round(unitKrw) : null;
  return {
    source, acct, side, name, qty,
    price,
    amount: (qty != null && price != null) ? qty * price : null,
    why,   // 근거 체인 씨앗(사실만) — AI가 산문으로 확장하거나 그대로 I열 JSON에
  };
}
