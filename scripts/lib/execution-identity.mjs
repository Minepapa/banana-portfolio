// 경로(NH API·카카오·v1 이전)와 무관하게 같은 체결인지 판정한다. 파일명·dedupKey가 아니라
// 체결 값 자체를 비교하고, 옛 행에 비어 있는 필드는 "다르다"의 근거로 쓰지 않는다.
// 지금은 일회성 표시 도구(mark-duplicate-executions)만 쓴다. 원장 쓰기 단계의 자동
// 중복 제거는 별개 체결을 버릴 위험(2026-10-14 리뷰 HIGH 2건)이 있어 넣지 않았다 —
// 2026-09-25부터 API가 덮는 계좌의 카카오 체결은 원장에 기록되지 않아 새 쌍이 생기지
// 않고, 보유 이중 반영은 update-holdings의 findMatchingKnownExecution이 막는다.

const clean = (value) => String(value ?? '').trim();

function tradeDayAndTime(value) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}${part('minute')}${part('second')}` };
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2})[:_]?([0-5]\d)[:_]?([0-5]\d))?/);
  if (!match) return null;
  return { day: match[1], time: match[2] ? `${match[2].padStart(2, '0')}${match[3]}${match[4]}` : null };
}

function equivalent(candidate, existing) {
  if (candidate?.type && candidate.type !== 'execution') return false;
  if (existing?.type && existing.type !== 'execution') return false;
  const left = tradeDayAndTime(candidate?.tradeDate);
  const right = tradeDayAndTime(existing?.tradeDate);
  if (!left || !right || left.day !== right.day || !clean(candidate.tradeType)
    || candidate.tradeType !== existing.tradeType) return false;
  const leftCode = clean(candidate.stockCode);
  const rightCode = clean(existing.stockCode);
  if (leftCode && rightCode ? leftCode !== rightCode
    : !clean(candidate.stockName) || candidate.stockName !== existing.stockName) return false;
  const quantity = Number(candidate.quantity);
  const price = Number(candidate.price);
  if (!Number.isFinite(quantity) || !Number.isFinite(price)
    || quantity <= 0 || price <= 0
    || quantity !== Number(existing.quantity) || price !== Number(existing.price)) return false;
  if (clean(candidate.currency) && clean(existing.currency)
    && candidate.currency !== existing.currency) return false;
  if (clean(candidate.account) && clean(existing.account)
    && candidate.account !== existing.account) return false;
  if (clean(candidate.orderNo) && clean(existing.orderNo)
    && clean(candidate.orderNo) !== clean(existing.orderNo)) return false;
  // Midnight in NH daily responses means the API did not supply a fill time.
  if (left.time && right.time && left.time !== '000000' && right.time !== '000000'
    && left.time !== right.time) return false;
  return true;
}

export function findEquivalentExecutions(candidate, existingRecords) {
  return existingRecords.filter((record) => equivalent(candidate, record));
}

export function findEquivalentExecution(candidate, existingRecords) {
  const matches = findEquivalentExecutions(candidate, existingRecords);
  return matches.length === 1 ? matches[0] : null;
}
