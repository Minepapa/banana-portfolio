// 파싱된 알림 이벤트(체결·배당) → Vault Facts/Ledger 기록(파일명+YAML frontmatter) 빌더.
// 순수 함수 — 실제 파일 쓰기는 호출부(scripts/jobs/parse-notifications-to-vault.mjs)가
// state-writer.mjs의 writeAtomic으로 수행한다.
//
// 파일명 자체가 멱등성 키다 — 같은 체결/배당을 다시 파싱해도 같은 파일명이 나오므로,
// 호출부는 existsSync(filepath)만으로 dedup을 판정할 수 있다(디렉토리 스캔·별도 인덱스
// 불필요). dedupKey 필드는 frontmatter에도 남겨 사람이 파일을 열어 직접 확인할 수 있게
// 한다(v1 dedup 키를 그대로 이식 — docs/ARCHITECTURE-V2.md "구현 메모" 절).
//
// 계좌 귀속(account)은 이 시점에 비워둔다 — 어느 계좌 보유종목인지 판별하려면
// State/Holdings(구현계획서 Phase 8·9)가 있어야 하는데, Phase 2는 파싱→Ledger 기록까지만
// 범위로 정했다(2026-08-04 오너 확정). accountNote로 이유를 명시해 "누락"이 아니라
// "의도적으로 다음 단계로 미룸"임을 남긴다.

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${s}"`;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${yamlValue(v)}`);
  lines.push('---', '');
  return lines.join('\n');
}

const ACCOUNT_NOTE = 'Phase 8·9(State/Holdings) 이후 별도 배치로 채워짐 — Phase 2 범위 밖(2026-08-04 확정)';

// e: parseExecution()의 반환값 { tradeDate, tradeType, stockCode, stockName, quantity, price, currency, broker }
export function buildExecutionRecord(e) {
  const dedupKey = `${e.tradeDate}|${e.tradeType}|${e.stockName}|${e.quantity}`;
  const datePart = e.tradeDate.slice(0, 10);
  const timePart = e.tradeDate.slice(11).replace(/:/g, '') || '000000';
  const filename = `execution-${datePart}-${timePart}-${sanitizeSegment(e.tradeType)}-${sanitizeSegment(e.stockName)}.md`;
  const content = buildFrontmatter({
    type: 'execution',
    tradeDate: e.tradeDate,
    tradeType: e.tradeType,
    stockCode: e.stockCode || '',
    stockName: e.stockName,
    quantity: e.quantity,
    price: e.price,
    currency: e.currency,
    broker: e.broker,
    account: null,
    accountNote: ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content };
}

// d: parseDividend()의 반환값 { date, afterTaxAmount, stockName, acctRaw, broker, receivedTime, uniqueKey }
export function buildDividendRecord(d) {
  const dedupKey = `${d.date}|${d.stockName}|${d.uniqueKey}`;
  const timePart = String(d.receivedTime ?? '').replace(/:/g, '') || '000000';
  const filename = `dividend-${d.date}-${timePart}-${sanitizeSegment(d.stockName)}.md`;
  const content = buildFrontmatter({
    type: 'dividend',
    date: d.date,
    stockName: d.stockName,
    afterTaxAmount: d.afterTaxAmount,
    receivedTime: d.receivedTime,
    uniqueKey: d.uniqueKey,
    broker: d.broker || '',
    acctRaw: d.acctRaw || '',
    account: null,
    accountNote: ACCOUNT_NOTE,
    dedupKey,
    recordedAt: new Date().toISOString(),
  });
  return { dedupKey, filename, content };
}
