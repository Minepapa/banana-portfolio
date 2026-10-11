// 알림 원문에서 확인 가능한 결제 사실만 꺼낸다. 알 수 없는 형식은 추정하지 않는다.
export const PAYMENT_DUPLICATE_MINUTES = 3;
const amountOf = (text) => Number(text?.replaceAll(',', ''));
const atOf = (record) => {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/.exec(record.ts ?? '');
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}:00+09:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

export function parseSpendingRecord(record) {
  const at = atOf(record);
  if (!at) return null;
  const body = String(record.body ?? '');
  const sender = String(record.sender ?? '');
  const packageName = String(record.packageName ?? '');
  let match;
  let card;
  let amount;
  let merchant = null;
  if ((match = /삼성\d{4}\s*승인[\s\S]*?([\d,]+)원\s*일시불[\s\S]*?\d{2}\/\d{2}\s+\d{2}:\d{2}\s+([^\n\r]+)/.exec(body))) {
    card = '삼성'; amount = amountOf(match[1]); merchant = match[2].trim();
  } else if (/하나/.test(sender + body) && (match = /(?:사용금액|승인금액)\s*[:：]?\s*([\d,]+)원/.exec(body))) {
    card = '하나'; amount = amountOf(match[1]);
    merchant = /(?:가맹점명?|사용처)\s*[:：]\s*([^\n\r]+)/.exec(body)?.[1]?.trim() ?? null;
  } else if (/하나|hanaskcard/i.test(packageName + sender + body)
    && (match = /(?:\(결제\)\s*)?([\d,]+)원/.exec(sender))
    && /신용\(일시불/.test(body)) {
    card = '하나'; amount = amountOf(match[1]); merchant = body.split(/[\n\r/]/)[0]?.trim() || null;
  } else if (/카카오페이/.test(packageName + sender) && (match = /계좌로\s*([\d,]+)원을\s*송금했어요/.exec(body))) {
    card = '카카오페이'; amount = amountOf(match[1]);
  } else return null;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return { at, amount, merchant, card, source: packageName || sender };
}

export function parseSpendingRecords(records) {
  const parsed = records.map(parseSpendingRecord).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
  const payments = [];
  for (const payment of parsed) {
    const duplicate = payments.find((prior) => prior.amount === payment.amount && prior.card === payment.card
      && Math.abs(Date.parse(prior.at) - Date.parse(payment.at)) <= PAYMENT_DUPLICATE_MINUTES * 60_000);
    if (!duplicate) payments.push(payment);
    else if (!duplicate.merchant && payment.merchant) Object.assign(duplicate, payment);
  }
  return payments;
}
