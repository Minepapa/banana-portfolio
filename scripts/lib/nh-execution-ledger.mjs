// NH daily execution responses report cumulative order fills. Only a terminal
// snapshot is persisted for a partial order, as one incremental ledger event.
// This avoids repeatedly applying the same cumulative quantity while allowing
// Kakao fill notices already in the ledger to cover part (or all) of that order.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecutionRecord } from './ledger-vault-writer.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { withLock, writeAtomic } from './state-writer.mjs';

const BROKER = 'NH투자증권';
const clean = (value) => String(value ?? '').trim();

function sameInstrument(record, input) {
  const recordCode = clean(record.stockCode);
  const inputCode = clean(input.stockCode);
  if (recordCode && inputCode) return recordCode === inputCode;
  return record.stockName === input.stockName;
}

function sameOrder(record, input) {
  return record.type === 'execution'
    && String(record.tradeDate ?? '').slice(0, 10) === input.tradeDate.slice(0, 10)
    && record.broker === BROKER
    && String(record.orderNo ?? '') === String(input.orderNo)
    && sameInstrument(record, input)
    && record.tradeType === input.tradeType;
}

function readOrderRecords(dir, input) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).flatMap((filename) => {
    const content = readFileSync(join(dir, filename), 'utf8');
    const record = parseFrontmatter(content);
    return sameOrder(record, input) ? [{ filename, content, ...record }] : [];
  });
}

function findCoveredSnapshot(records) {
  let api = null;
  const kakao = [];
  for (const record of records) {
    // New API events carry an explicit cumulative marker. Older NH API full-fill
    // records predate it and are recognizable by their resolved account and the
    // API's synthetic midnight timestamp.
    const isApi = record.source === 'NH_API'
      || (record.account && String(record.tradeDate).endsWith('00:00:00'));
    if (isApi) {
      const quantity = Number(record.orderCumulativeQty ?? record.quantity);
      const amount = Number(record.orderCumulativeAmount ?? (Number(record.quantity) * Number(record.price)));
      if (Number.isFinite(quantity) && Number.isFinite(amount)
        && (!api || quantity > api.quantity)) api = { quantity, amount };
    } else {
      // 아직 Holdings에 반영되지 않은 카카오 행은 API 누적량을 이미 적용한 것으로
      // 볼 수 없다. 여기서 차감하면 API delta만 적용되고 카카오 행은 뒤에서 중복으로
      // 건너뛰어 실제 수량보다 적게 반영된다.
      if (record.holdingsApplied !== true) continue;
      const quantity = Number(record.quantity);
      const amount = quantity * Number(record.price);
      if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(amount) && amount > 0) {
        kakao.push({ quantity, amount });
      }
    }
  }
  const kakaoSnapshot = kakao.length
    ? kakao.reduce((sum, item) => ({ quantity: sum.quantity + item.quantity, amount: sum.amount + item.amount }), { quantity: 0, amount: 0 })
    : null;
  if (!api) return kakaoSnapshot;
  if (!kakaoSnapshot || api.quantity >= kakaoSnapshot.quantity) return api;
  return kakaoSnapshot;
}

export function buildNhTerminalExecutionEvent({ row, tradeDate, account, acctNo = '' }, records = []) {
  const quantity = Number(row?.quantity);
  const price = Number(row?.price);
  const orderNo = clean(row?.orderNo);
  const orderQty = Number(row?.orderQty);
  const totalAmount = Number.isFinite(Number(row?.executionAmount)) && Number(row.executionAmount) > 0
    ? Number(row.executionAmount)
    : quantity * price;

  if (!orderNo || !tradeDate || !account || !row?.tradeType || !row?.stockName
    || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(orderQty) || orderQty < quantity
    || !Number.isFinite(price) || price <= 0 || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    return { ok: false, reason: 'NH 체결 필수 필드 결측 또는 잘못된 값' };
  }
  if (!row.fullyFilled && !(quantity < orderQty && row.unfilledQty === 0)) {
    return { ok: false, reason: '부분체결 주문이 아직 종료되지 않았거나 잔량 상태를 확인할 수 없음' };
  }
  // cns_amt is the API's cumulative execution amount. Reject inconsistent rows
  // rather than derive a plausible but incorrect incremental price.
  if (Math.abs(totalAmount - quantity * price) > Math.max(1, quantity)) {
    return { ok: false, reason: 'NH 누적 체결금액과 평균단가×체결수량이 일치하지 않음' };
  }

  const input = {
    tradeDate, tradeType: row.tradeType, stockCode: clean(row.stockCode), stockName: clean(row.stockName),
    quantity, price, currency: 'KRW', broker: BROKER, account, acctNo, orderNo,
  };
  // 계좌를 알 수 없는 과거 카카오 체결은 주문번호가 계좌별로 발급되는 경우 다른
  // 계좌의 주문일 수 있다. API 누적값에서 임의로 차감하지 않고, 원문을 보존한 채
  // 대사 보류로 남긴다.
  if (records.some((record) => record.source !== 'NH_API' && !record.account)) {
    return { ok: false, reason: '같은 주문번호의 계좌 미상 카카오 체결이 있어 API 누적수량을 안전하게 대조할 수 없음' };
  }
  if (records.some((record) => record.account && record.account !== account)) {
    return { ok: false, reason: '같은 주문번호·종목·방향이 다른 계좌 기록에도 있어 계좌 중복 여부 확인 필요' };
  }
  const previous = findCoveredSnapshot(records);
  const coveredQty = previous?.quantity ?? 0;
  const coveredAmount = previous?.amount ?? 0;
  if (coveredQty > quantity) {
    return { ok: false, reason: '기존 체결기록 수량이 NH 주문 누적수량보다 큼 — 주문번호·계좌 대조 필요' };
  }
  if (coveredQty === quantity) return { ok: true, event: null, coveredQty };

  const deltaQty = quantity - coveredQty;
  const deltaAmount = totalAmount - coveredAmount;
  if (deltaAmount <= 0) return { ok: false, reason: '이미 기록된 체결금액이 NH 누적금액 이상이라 증분을 계산할 수 없음' };
  const deltaPrice = deltaAmount / deltaQty;
  if (!Number.isFinite(deltaPrice) || deltaPrice <= 0) {
    return { ok: false, reason: '부분체결 증분 단가를 안전하게 계산할 수 없음' };
  }
  const sourceEventId = `nh-${orderNo}-cum-${quantity}`;
  const event = {
    ...input,
    quantity: deltaQty,
    price: deltaPrice,
    source: 'NH_API',
    sourceEventId,
    orderCumulativeQty: quantity,
    orderCumulativeAmount: totalAmount,
  };
  return { ok: true, event, coveredQty };
}

export async function recordNhTerminalExecution({ row, tradeDate, account, acctNo = '', dir, dryRun = false }) {
  const orderNo = clean(row?.orderNo);
  if (!orderNo) return { ok: false, reason: 'NH 주문번호 결측' };
  if (!dryRun) mkdirSync(dir, { recursive: true });

  const execute = async () => {
    const input = {
      tradeDate, tradeType: row.tradeType, stockCode: clean(row.stockCode), stockName: clean(row.stockName),
      quantity: Number(row.quantity), price: Number(row.price), currency: 'KRW', broker: BROKER, account, acctNo, orderNo,
    };
    const records = readOrderRecords(dir, input);
    const result = buildNhTerminalExecutionEvent({ row, tradeDate, account, acctNo }, records);
    if (!result.ok || !result.event) return result;
    const record = buildExecutionRecord(result.event);
    const filepath = join(dir, record.filename);
    if (existsSync(filepath)) return { ok: true, event: null, coveredQty: Number(row.quantity), duplicateFile: true };
    if (!dryRun) writeAtomic(filepath, record.content);
    return { ...result, filepath, dryRun };
  };

  if (dryRun) return execute();
  const lockFile = join(dir, `.nh-order-${orderNo}.lock`);
  return withLock(lockFile, execute);
}
