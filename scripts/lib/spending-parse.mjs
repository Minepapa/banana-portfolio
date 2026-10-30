// 알림에서 형식이 확인된 사실만 꺼낸다. 미확인 송금은 지출 합계에 넣지 않는다.
export const PAYMENT_DUPLICATE_MINUTES = 3;
const WALLET_CARD = '삼성월렛';
const amountOf = (text) => Number(text?.replaceAll(',', ''));
const atOf = (record) => {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/.exec(record.ts ?? '');
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}:00+09:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
// 카톡 하나카드는 법인명만(`현대오일뱅크(주)`), 하나카드 앱은 지점명까지(`…직영송도팰리스`) 보낸다.
// 짧은 쪽이 4자 이상이고 긴 쪽의 앞부분이면 같은 가게로 본다. 알림 하나가 빠진 진짜 두 결제를 합치지 않도록
// 앞부분 일치는 두 알림의 카드 번호(끝4 또는 마스크)가 모두 있고 같을 때만 쓴다.
const sameCardNumber = (a, b) => Boolean((a.cardLast4 && a.cardLast4 === b.cardLast4)
  || (a.cardMask && a.cardMask === b.cardMask));
const sameMerchant = (a, b) => {
  if (a.merchant === b.merchant) return true;
  const [short, long] = a.merchant.length <= b.merchant.length ? [a.merchant, b.merchant] : [b.merchant, a.merchant];
  return sameCardNumber(a, b) && short.length >= 4 && long.startsWith(short);
};
const longerMerchant = (a, b) => (a.merchant && b.merchant && sameMerchant(a, b)
  && b.merchant.length > a.merchant.length ? b.merchant : a.merchant || b.merchant);
const categoryOf = (isOnnuri, merchant) => isOnnuri ? '온누리상품권'
  : /(?:교통|버스|지하철|택시)/.test(merchant ?? '') ? '교통비' : '일반';

export function parseSpendingRecord(record, { ownAccounts = [], recipientDecisions = [] } = {}) {
  const at = atOf(record);
  if (!at) return null;
  const body = String(record.body ?? '');
  const sender = String(record.sender ?? '');
  const packageName = String(record.packageName ?? '');
  const samsungOnnuri = sender === '삼성카드' && packageName === 'com.kakao.talk'
    ? /^\[삼성카드\]([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)원 승인\(온누리상품권 \1원 사용\)\r?\n\*결제대금에 미포함$/.exec(body)
    : null;
  // 하나카드 앱 자동납부 정상승인은 통신비(`[SK텔레콤(자동납부)]`)와 관리비(`[아파트관리비]`)처럼 괄호 안 이름만 다르다.
  const hanaAutopay = sender === '자동납부 요금 정상승인 안내'
    && packageName === 'com.hanaskcard.paycla'
    ? /^\[([^\]\n]*[^\]\s][^\]\n]*)\] 자동납부 요금 정상승인 안내 ([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)원$/.exec(body)
    : null;
  const cancellationMarker = '(?:승인취소|사용취소|결제취소|취소|환불|광고)';
  const cancellation = /(?:취소|환불|광고)/.test(sender)
    || new RegExp(`(?:^|\\n)\\s*[-*]?\\s*(?:${cancellationMarker}(?=\\s|$|[:：])|\\[${cancellationMarker}\\]|\\(${cancellationMarker}\\)|(?:거래종류|거래상태|상태)\\s*[:：]\\s*${cancellationMarker}(?=\\s|$))`, 'm').test(body);
  if (cancellation || (hanaAutopay && /(?:취소|환불|결제대금)/.test(hanaAutopay[1]))
    || (/(?:결제대금|카드값)/.test(sender + body) && !samsungOnnuri)) return null;

  let match;
  let card;
  let amount;
  let merchant = null;
  let cardLast4 = null;
  let cardMask = null;
  let status = 'expense';
  let recipientBank = null;
  let recipientLast4 = null;
  let recipient = null;
  if (samsungOnnuri) {
    card = '삼성'; amount = amountOf(samsungOnnuri[1]);
  } else if (hanaAutopay) {
    card = '하나'; merchant = hanaAutopay[1].replace(/(?:\(자동납부\)| 자동납부)$/, '').trim(); amount = amountOf(hanaAutopay[2]);
  } else if ((match = /삼성(\d{4})\s*승인[\s\S]*?([\d,]+)원\s*일시불[\s\S]*?\d{2}\/\d{2}\s+\d{2}:\d{2}\s+([^\n\r]+)/.exec(body))) {
    card = '삼성'; cardLast4 = match[1]; amount = amountOf(match[2]); merchant = match[3].trim();
  } else if (/하나/.test(sender + body) && (match = /(?:사용금액|승인금액)\s*[:：]?\s*([\d,]+)원/.exec(body))) {
    card = '하나'; amount = amountOf(match[1]);
    merchant = /(?:가맹점명?|사용처)\s*[:：]\s*([^\n\r]+)/.exec(body)?.[1]?.trim() ?? null;
    // 카톡은 `이용카드 : MG+ 하나 5*8*`처럼 카드 이름 뒤에 번호를 붙인다. 이 형식은 '이용카드 :' 줄 끝의 번호만 읽는다
    // (`트래블로그 2030`처럼 카드 이름 안 숫자는 번호가 아니다). 하나카드 앱도 지금까지 마스크만 보냈다.
    const cardNumber = (/(?:카드번호|카드)\s*[:：]?\s*(\d{4}|\d\*\d\*)/.exec(body)
      ?? /^\s*-?\s*이용카드\s*[:：][^\n]*?\s(\d\*\d\*|\d{4})(?:온누리)?[ \t]*$/m.exec(body))?.[1] ?? null;
    cardLast4 = /^\d{4}$/.test(cardNumber ?? '') ? cardNumber : null;
    cardMask = cardNumber?.includes('*') ? cardNumber : null;
  } else if (/하나|hanaskcard/i.test(packageName + sender + body)
    && (match = /(?:\(결제\)\s*)?([\d,]+)원/.exec(sender))
    && /신용\(일시불/.test(body)) {
    card = '하나'; amount = amountOf(match[1]); merchant = body.split(/[\n\r/]/)[0]?.trim() || null;
    const cardNumber = /일시불,\s*(\d\*\d\*|\d{4})/.exec(body)?.[1] ?? null;
    cardLast4 = /^\d{4}$/.test(cardNumber ?? '') ? cardNumber : null;
    cardMask = cardNumber?.includes('*') ? cardNumber : null;
  } else if (/hanaskcard/i.test(packageName) && sender === '결제'
    && (match = /^온누리\((\d\*\d\*)\)[^\n]*?\/일시불\/승인\/([\d,]+)원\/([^\n/]+)/.exec(body))) {
    card = '하나'; cardMask = match[1]; amount = amountOf(match[2]); merchant = match[3].trim();
  } else if (/카카오페이|kakaopay/i.test(packageName + sender)
    && (match = /계좌로\s*([\d,]+)원을?\s*송금했어요/.exec(body))
    && (/송금이 완료되었어요/.test(sender) || /카카오페이/.test(packageName + sender))) {
    card = '카카오페이'; amount = amountOf(match[1]); status = 'pending';
    const recipient = /(?:^|\n)\s*([^\n\d()]+?)\s+(\d{4})\s*\([^\n)]*\)계좌로/.exec(body);
    if (recipient) { recipientBank = recipient[1].trim(); recipientLast4 = recipient[2]; }
  } else if ((packageName === 'com.smg.spbs' || sender === 'MG새마을금고')
    && (match = /^\[출금\] ([\d,]+)원 \S+ 잔액 [\d,]+원 \d{2}\/\d{2} \d{2}:\d{2} ([^\n]+)$/.exec(body.trim()))) {
    // 계좌 출금은 카드대금·보험·본인 증권계좌 이체가 섞여 있어 판정 전까지 합계에 넣지 않는다.
    // 계좌번호는 요약에 남기지 않는다(원문 JSONL에는 그대로 있다). 상대 이름이 결제대금이면 위에서 이미 뺐다.
    card = '새마을금고'; amount = amountOf(match[1]); merchant = match[2].normalize('NFKC').trim(); status = 'pending';
  } else if (packageName === 'com.samsung.android.spay'
    && (match = /^₩([\d,]+) 결제 완료$/.exec(sender)) && body.trim()) {
    // 삼성 월렛 결제는 실제 카드 승인 알림과 겹친다. 같은 결제의 카드 알림이 있으면 parseSpendingRecords가 지운다.
    card = WALLET_CARD; amount = amountOf(match[1]); merchant = body.trim();
  } else return null;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  if (status === 'pending' && recipientBank && recipientLast4 && ownAccounts.some((account) =>
    account.bank === recipientBank && account.last4 === recipientLast4)) status = 'excluded';
  if (status === 'pending' && recipientBank && recipientLast4) {
    const decision = recipientDecisions.find((entry) => entry.bank === recipientBank
      && entry.last4 === recipientLast4);
    // 가족 판정은 계좌가 일치하는 설정에서 확인된 수취인에게만 적용한다.
    recipient = ['휘영', '미네'].includes(decision?.recipient) ? decision.recipient : null;
    if (decision?.status === 'expense' || decision?.status === 'excluded') status = decision.status;
    else if (recipient) status = 'excluded';
  }
  const isOnnuri = Boolean(samsungOnnuri || (card === '하나'
    && /(?:^|\n)\s*-\s*이용카드\s*[:：]\s*[^\n]*온누리/.test(body))
    || (card === '하나' && sender === '결제' && /^온누리\(/.test(body)));
  const category = ['카카오페이', '새마을금고'].includes(card) ? '계좌이체' : categoryOf(isOnnuri, merchant);
  // 자동납부는 그 시각 있던 곳과 무관하다. 동선·장소별 소비가 위치에 붙이지 않도록 표시한다.
  return { at, amount, merchant, card, cardLast4, cardMask, status, category,
    recipientBank, recipientLast4, recipient, source: packageName || sender, ...(hanaAutopay ? { autopay: true } : {}) };
}

export function parseSpendingRecords(records, options = {}) {
  const parsed = records.map((record) => parseSpendingRecord(record, options)).filter(Boolean)
    .sort((a, b) => a.at.localeCompare(b.at));
  const payments = [];
  for (const payment of parsed) {
    const duplicate = payments.find(({ entry: prior, sources }) => !sources.has(payment.source)
      && prior.amount === payment.amount && prior.card === payment.card
      && prior.status === payment.status
      && prior.category === payment.category
      && prior.source !== payment.source
      && (!prior.cardLast4 || !payment.cardLast4 || prior.cardLast4 === payment.cardLast4)
      && (!prior.cardMask || !payment.cardMask || prior.cardMask === payment.cardMask)
      && (!(prior.cardLast4 || prior.cardMask) || !(payment.cardLast4 || payment.cardMask)
        || (prior.cardLast4 && payment.cardLast4 && prior.cardLast4 === payment.cardLast4)
        || (prior.cardMask && payment.cardMask && prior.cardMask === payment.cardMask))
      && ((prior.cardLast4 === payment.cardLast4 && prior.cardMask === payment.cardMask)
        || (prior.merchant && payment.merchant && sameMerchant(prior, payment)))
      && (!prior.recipientLast4 || !payment.recipientLast4 || prior.recipientLast4 === payment.recipientLast4)
      && (!prior.recipientBank || !payment.recipientBank || prior.recipientBank === payment.recipientBank)
      && (!prior.merchant || !payment.merchant || sameMerchant(prior, payment))
      && (prior.cardLast4 || prior.cardMask
        || (prior.merchant && payment.merchant && prior.source !== payment.source)
        || (prior.recipientBank && prior.recipientLast4 && payment.recipientBank
          && payment.recipientLast4 && prior.source !== payment.source))
      && Math.abs(Date.parse(prior.at) - Date.parse(payment.at)) <= PAYMENT_DUPLICATE_MINUTES * 60_000);
    if (!duplicate) payments.push({ entry: payment, sources: new Set([payment.source]) });
    else {
      const prior = duplicate.entry;
      const preferPayment = (!prior.merchant && payment.merchant)
        || (payment.source.includes('kakaopay.app') && !prior.source.includes('kakaopay.app'));
      const richerFields = {
        merchant: longerMerchant(prior, payment),
        cardLast4: prior.cardLast4 ?? payment.cardLast4,
        cardMask: prior.cardMask ?? payment.cardMask,
        recipientBank: prior.recipientBank ?? payment.recipientBank,
        recipientLast4: prior.recipientLast4 ?? payment.recipientLast4,
        recipient: prior.recipient ?? payment.recipient,
        category: prior.category === '계좌이체' || payment.category === '계좌이체'
          ? '계좌이체' : prior.category === '온누리상품권' || payment.category === '온누리상품권'
            ? '온누리상품권' : prior.category === '교통비' || payment.category === '교통비'
              ? '교통비' : '일반',
      };
      if (preferPayment) Object.assign(prior, payment);
      Object.assign(prior, richerFields);
      duplicate.sources.add(payment.source);
    }
  }
  // 월렛 결제는 어느 카드인지 알려 주지 않는다. 같은 금액·3분 안의 카드 승인 하나와 짝지어 지우고,
  // 짝이 없을 때만(카드 알림이 빠졌을 때) 지출로 남긴다. 카드 승인 하나는 월렛 결제 하나와만 짝짓는다.
  const entries = payments.map(({ entry }) => entry);
  const claimed = new Set();
  return entries.filter((wallet) => {
    if (wallet.card !== WALLET_CARD) return true;
    const card = entries.find((entry) => entry.card !== WALLET_CARD && !claimed.has(entry)
      && entry.status === 'expense' && entry.category !== '계좌이체' && entry.amount === wallet.amount
      && Math.abs(Date.parse(entry.at) - Date.parse(wallet.at)) <= PAYMENT_DUPLICATE_MINUTES * 60_000);
    if (!card) return true;
    claimed.add(card);
    return false;
  });
}
