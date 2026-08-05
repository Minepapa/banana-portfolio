// v1(구글시트) → Vault 1회성 마이그레이션 레코드 빌더 — 순수 함수(구현계획서 Phase 7).
// docs/ARCHITECTURE-V2.md "v1 → v2 마이그레이션 계획" 매핑표(확정) 그대로 구현.
//
// ⚠️ "가장 위험한 지점"(원문 표현) — 개인 재무 이력 전체를 다룬다. 그래서:
// - 실제 시트 읽기·Vault 쓰기는 전부 호출부(scripts/jobs/migrate-v1-to-vault.mjs)가 하고,
//   이 모듈은 fs·구글API를 만지지 않는 순수함수만 모아 각각 독립적으로 테스트한다.
// - 컬럼 레이아웃은 scripts/lib/sheet-contracts.mjs(정본, scripts 쪽 소비자 공용)를
//   우선 신뢰한다. 단 체결내역·리스크기준선 2곳은 sheet-contracts.mjs와 실제 쓰기
//   로직(TradeEditModal이 쓰는 src/lib/constants.js CHEOL_COLS, backfill-baselines.mjs의
//   BASELINE_HEADER)이 서로 어긋나 있는 걸 이번에 발견했다(체결 K·L·M을 EXEC_COL은
//   PNL·EVAL·RETPCT로, CHEOL_COLS는 수수료·세금·정산금액으로 다르게 봄 — 단 EXEC_COL의
//   그 세 필드는 실제로 어디서도 안 읽힘, 죽은 상수. 기준선은 SHEET_RANGES가 10열(J까지,
//   PBR 없음)인데 실제 쓰기 로직은 11열(K까지, PBR 포함) — parseSheetData 쪽이 PBR 값을
//   "비고"로 잘못 읽는 v1 UI 버그로 추정). 두 경우 다 **실제로 쓰는 로직(writer) 쪽을
//   신뢰**했다 — 체결은 CHEOL_COLS, 기준선은 BASELINE_HEADER 11열.
//
// 파일명 규칙: 이벤트 로그류(체결·배당·실현손익·일별스냅샷·평가·리스크판정·주문제안·
// 리포트·성향관찰)는 `날짜-구분자-r{시트행번호}.md` — 시트 행번호가 그 자체로 안정적인
// 고유키라, 재실행해도 같은 파일명이 나와 idempotent(existsSync만으로 dedup 가능,
// ledger-vault-writer.mjs와 동일 원칙). 현재값류(보유종목·자산분배·기준선)는
// `계좌-이름.md`로 매번 덮어쓴다(State 원칙과 동일 — "지금 상태"만 정확하면 됨).
import { buildFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';
// v1 시트 숫자 셀은 "2,018,000"·"391.1%"처럼 콤마·퍼센트가 섞인 문자열로 온다.
// Number("2,018,000")은 NaN이 되고 `NaN || 0`이 조용히 0으로 뭉개버린다(2026-08-05
// 실사고 — 위탁 삼성전자 매입단가·투자금액·평가액이 전부 0으로 마이그레이션됐던 걸
// 대조검증 스크립트도 아니라 실제 파일을 직접 열어봐서 발견함, 대조검증조차 v1·Vault
// 양쪽에서 똑같이 0으로 나와 "0건 불일치"로 위장됐었다). parseNum은 parseFloat라 콤마
// 제거 후 "391.1%"도 391.1까지는 정상 파싱한다 — v1 앱 코드가 이미 쓰는 것과 동일 함수.
import { parseNum } from '../../src/lib/textFormat.js';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-') || '_';
}

const LEGACY_NOTE = 'v1(구글시트) → Vault 마이그레이션(2026-08-05, Phase 7)으로 옮겨진 과거 기록';

// ── Facts/Ledger/Executions (체결내역, CHEOL_COLS 레이아웃 A~M) ────────────────
export function buildMigratedExecutionRecord(row, rowNum) {
  const [date, side, acct, code, asset, name, price, qty, amount, current, fee, tax, settlement] = row;
  const content = buildFrontmatter({
    type: 'execution', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    tradeDate: String(date ?? '').trim(), tradeType: String(side ?? '').trim(),
    account: String(acct ?? '').trim() || null, stockCode: String(code ?? '').trim(),
    assetClass: String(asset ?? '').trim(), stockName: String(name ?? '').trim(),
    price: parseNum(price), quantity: parseNum(qty), amount: parseNum(amount),
    currentPriceAtRecord: parseNum(current), fee: parseNum(fee), tax: parseNum(tax),
    settlementAmount: parseNum(settlement),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-${sanitizeSegment(side)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.facts.ledger.executions };
}

// ── Facts/Ledger/Dividends (배당금 A~C: 날짜,금액,종목명) ──────────────────────
export function buildMigratedDividendRecord(row, rowNum) {
  const [date, amount, name] = row;
  const content = buildFrontmatter({
    type: 'dividend', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), stockName: String(name ?? '').trim(),
    afterTaxAmount: parseNum(amount), account: null,
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.facts.ledger.dividends };
}

// ── Facts/Ledger/Profits (수익금 A~F: 날짜,종목명,수량,매수단가,매도단가,수익금) ──
export function buildMigratedProfitRecord(row, rowNum) {
  const [date, name, qty, buyPrice, sellPrice, profit] = row;
  const content = buildFrontmatter({
    type: 'realized-profit', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), stockName: String(name ?? '').trim(),
    quantity: parseNum(qty), buyPrice: parseNum(buyPrice), sellPrice: parseNum(sellPrice),
    profit: parseNum(profit), account: null,
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.facts.ledger.profits };
}

// ── Facts/Ledger/DailySnapshots (일별스냅샷 A~E) — byAccount·byHolding은 v1도 이미
// JSON 문자열 셀이라 그대로 문자열 필드로 옮긴다(파싱·재해석 안 함, 손실 없음).
export function buildMigratedDailySnapshotRecord(row, rowNum) {
  const [date, snapTs, totalEval, byAccountJson, byHoldingJson] = row;
  const content = buildFrontmatter({
    type: 'daily-snapshot', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), snapshotTs: String(snapTs ?? '').trim(),
    totalEval: parseNum(totalEval),
    byAccountJson: String(byAccountJson ?? '{}'), byHoldingJson: String(byHoldingJson ?? '{}'),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.facts.ledger.dailySnapshots };
}

// ── State/Holdings (ISA·위탁·연금저축·IRP, 계좌별 A~I) — 현재값만, 덮어쓰기 ─────
// holding: { account, type(자산군), name, price(평단), qty, invest, currentPrice, profit, eval, rate, isCashLike }
//
// ⚠️ rowNum(시트 행번호)까지 파일명에 포함한다 — 같은 계좌에 같은 종목명이 서로 다른
// 매입단가·수량으로 두 번 이상 나오는 실제 사례가 있었다(2026-08-05, 위탁 삼성전자
// 40주@50,450원 + 30주@54,700원, 서로 다른 매입 로트). 처음엔 계좌+이름만으로 파일명을
// 지어 뒤 로트가 앞 로트를 조용히 덮어써 40주치(투자금 7,892,000원)가 통째로 유실되는
// 사고가 났다 — 대조검증 스크립트가 잡아냄. State는 "현재값만"이 원칙이지만, v1이 이미
// 로트를 별도 행으로 구분해 관리하고 있다면 그 구분을 없앨 이유가 없다(마이그레이션은
// 손실 없는 이관이 최우선).
export function buildMigratedHoldingRecord(holding, rowNum) {
  // 다른 빌더들과 달리 raw row가 아니라 이미 조립된 객체를 받지만, 숫자 필드는 여기서도
  // parseNum을 거친다 — 호출부가 미리 파싱해뒀을 거라 믿지 않는다(콤마 포함 문자열이
  // 그대로 들어와도 이 함수 하나만 보면 안전한 게 보장되도록, 책임을 호출부와 나누지 않음).
  const content = buildFrontmatter({
    type: 'holding', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    account: holding.account, assetClass: holding.type, name: holding.name,
    ticker: '', market: '', // v1 보유종목 시트엔 티커·시장 필드가 없음 — 정직하게 빈 값
    avgPrice: parseNum(holding.price), qty: parseNum(holding.qty), invest: parseNum(holding.invest),
    curPrice: parseNum(holding.currentPrice), evalAmount: parseNum(holding.eval), profitAmount: parseNum(holding.profit),
    profitPct: parseNum(holding.rate), isCashLike: holding.isCashLike,
    updatedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(holding.account)}-${sanitizeSegment(holding.name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.state.holdings };
}

// ── State/Allocation (자산분배, 계좌×자산군 조합 1파일) — 현재값만, 덮어쓰기 ────
export function buildMigratedAllocationRecord({ account, assetName, target, current, rebalAmt }) {
  const content = buildFrontmatter({
    type: 'allocation', legacy: true, legacyNote: LEGACY_NOTE,
    account, assetName, targetPct: parseNum(target), currentPct: parseNum(current), rebalAmt: parseNum(rebalAmt),
    updatedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(account)}-${sanitizeSegment(assetName)}.md`;
  return { filename, content, dir: VAULT_PATHS.state.allocation };
}

// ── State/Baselines (리스크기준선, 실제 11열 — BASELINE_HEADER 기준, PBR 포함) ──
export function buildMigratedBaselineRecord(row) {
  const [name, ticker, market, date, grossMargin, opMargin, roe, debtRatio, eps, pbr, note] = row;
  const content = buildFrontmatter({
    type: 'baseline', legacy: true, legacyNote: LEGACY_NOTE,
    name: String(name ?? '').trim(), ticker: String(ticker ?? '').trim(), market: String(market ?? '').trim(),
    baselineDate: String(date ?? '').trim(),
    grossMargin: String(grossMargin ?? '').trim(), operatingMargin: String(opMargin ?? '').trim(),
    roe: String(roe ?? '').trim(), debtRatio: String(debtRatio ?? '').trim(), eps: String(eps ?? '').trim(),
    pbr: String(pbr ?? '').trim(), note: String(note ?? '').trim(),
    updatedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(name)}.md`;
  return { filename, content, dir: VAULT_PATHS.state.baselines };
}

// ── Decisions/Evaluations (종목투자노트 A~U) — 나머지 텍스트 항목은 분리(splitNumbered
// 등) 안 하고 원문 그대로 보존한다(마이그레이션은 손실 없는 이관이 우선, 재구조화는
// 필요해지면 읽는 쪽에서). axisItems(U열)는 v1도 이미 JSON 문자열이라 그대로 passthrough.
export function buildMigratedEvaluationRecord(row, rowNum) {
  const [date, name, ticker, market, concl, ax1, ax2, ax3, ax4, ax5, reasons, risks, actions,
    frankMemo, status, buyDate, buyPrice, targetTerm, targetRet, aiNote, axisItemsJson] = row;
  const content = buildFrontmatter({
    type: 'evaluation', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), stockName: String(name ?? '').trim(),
    ticker: String(ticker ?? '').trim(), market: String(market ?? '').trim(),
    conclusion: String(concl ?? '').trim(),
    axis수익성: String(ax1 ?? '').trim(), axis안정성: String(ax2 ?? '').trim(),
    axis밸류에이션: String(ax3 ?? '').trim(), axis현금흐름: String(ax4 ?? '').trim(), axis모멘텀: String(ax5 ?? '').trim(),
    reasonsRaw: String(reasons ?? '').trim(), risksRaw: String(risks ?? '').trim(), actionsRaw: String(actions ?? '').trim(),
    frankMemo: String(frankMemo ?? '').trim(), status: String(status ?? '').trim(),
    buyDate: String(buyDate ?? '').trim(), buyPrice: String(buyPrice ?? '').trim(),
    targetTerm: String(targetTerm ?? '').trim(), targetRet: String(targetRet ?? '').trim(),
    aiNote: String(aiNote ?? '').trim(), axisItemsJson: String(axisItemsJson ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.decisions.evaluations };
}

// ── Decisions/PositionJournal (포지션저널 A~P, JOURNAL_COL 레이아웃) ───────────
export function buildMigratedPositionJournalRecord(row, rowNum) {
  const [name, ticker, market, account, kind, thesis, target, exit, hold, entry, status,
    exitDate, result, lesson, confirm, updated] = row;
  const content = buildFrontmatter({
    type: 'position-journal', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    stockName: String(name ?? '').trim(), ticker: String(ticker ?? '').trim(), market: String(market ?? '').trim(),
    account: String(account ?? '').trim() || null, kind: String(kind ?? '').trim(),
    thesis: String(thesis ?? '').trim(), target: String(target ?? '').trim(), exitCondition: String(exit ?? '').trim(),
    expectedHold: String(hold ?? '').trim(), entryDate: String(entry ?? '').trim(),
    status: String(status ?? '').trim() || '보유', exitDate: String(exitDate ?? '').trim(),
    result: String(result ?? '').trim(), lesson: String(lesson ?? '').trim(),
    confirmStatus: String(confirm ?? '').trim() || '미작성', updatedAt: String(updated ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(account)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.decisions.positionJournal };
}

// ── Decisions/RiskMonitor (리스크모니터 A~H, RISK_COL 레이아웃) ────────────────
export function buildMigratedRiskMonitorRecord(row, rowNum) {
  const [date, type, target, signal, summary, detail, evidence, baselineRef] = row;
  const content = buildFrontmatter({
    type: 'risk-judgment', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), riskType: String(type ?? '').trim(), target: String(target ?? '').trim(),
    signal: String(signal ?? '').trim(), summary: String(summary ?? '').trim(), detail: String(detail ?? '').trim(),
    evidenceJson: String(evidence ?? '').trim(), baselineRef: String(baselineRef ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-${sanitizeSegment(target)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.decisions.riskMonitor };
}

// ── Decisions/Proposals (주문제안, 과거 아카이브 — 원본 필드 그대로, 오너 확정
// 2026-08-05: v2 Proposal 스키마로 억지 변환하지 않는다. legacy:true로 새 스키마
// 레코드와 구분되고, 파일명 패턴도 새 Proposal의 `{track}-{side}-{assetKey}-{ts}`와
// 겹치지 않아 order-gate.mjs의 단일활성제안 판정 등에 절대 섞이지 않는다) ──────
export function buildMigratedProposalRecord(row, rowNum) {
  const [date, source, acct, side, name, qty, price, amount, rationale, constraints,
    status, responded, rejectReason, matchKey] = row;
  const content = buildFrontmatter({
    type: 'legacy-proposal', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), source: String(source ?? '').trim(), account: String(acct ?? '').trim(),
    side: String(side ?? '').trim(), stockName: String(name ?? '').trim(),
    quantity: parseNum(qty), price: parseNum(price), amount: parseNum(amount),
    rationaleJson: String(rationale ?? '').trim(), constraintsJson: String(constraints ?? '').trim(),
    status: String(status ?? '').trim(), respondedAt: String(responded ?? '').trim(),
    rejectReason: String(rejectReason ?? '').trim(), matchKey: String(matchKey ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `legacy-${sanitizeSegment(date)}-${sanitizeSegment(name)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.decisions.proposals };
}

// ── Knowledge/Reports (주간리포트 A~C: 날짜,요약,본문) ─────────────────────────
export function buildMigratedReportRecord(row, rowNum) {
  const [date, summary, body] = row;
  const content = buildFrontmatter({
    type: 'weekly-report', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), summary: String(summary ?? '').trim(), body: String(body ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.knowledge.reports };
}

// ── Knowledge/Profile (성향관찰 A~H) ────────────────────────────────────────
export function buildMigratedPreferenceRecord(row, rowNum) {
  const [date, type, observation, evidence, vsProfile, confidence, status, updated] = row;
  const content = buildFrontmatter({
    type: 'preference-observation', legacy: true, legacyNote: LEGACY_NOTE, legacySourceRow: rowNum,
    date: String(date ?? '').trim(), signalType: String(type ?? '').trim(),
    observation: String(observation ?? '').trim(), evidence: String(evidence ?? '').trim(),
    vsProfile: String(vsProfile ?? '').trim(), confidence: String(confidence ?? '').trim(),
    status: String(status ?? '').trim() || '관찰', updatedAt: String(updated ?? '').trim(),
    recordedAt: new Date().toISOString(),
  });
  const filename = `${sanitizeSegment(date)}-r${rowNum}.md`;
  return { filename, content, dir: VAULT_PATHS.knowledge.profile };
}
