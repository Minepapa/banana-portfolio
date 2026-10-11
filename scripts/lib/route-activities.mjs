export const PAYMENT_GRACE_MINUTES = 10;
export const EVENT_OVERLAP_MINUTES = 30;
export const ACTIVITY_BY_CATEGORY = { FD6: '식사', CE7: '카페', CT1: '관람' };
export const EVENT_ACTIVITIES = [
  [/공연|콘서트|연주/, '공연'], [/영화/, '영화'], [/전시/, '관람'],
  [/식사|점심|저녁/, '식사'], [/진료|병원/, '진료'],
];

export const genericMerchant = (name) => /^(?:[가-힣]+(?:광역시|특별시|특별자치시|특별자치도|도))[가-힣]*(?:시|군|구)$/.test(name);
export const MOVE_ACTIVITY_BY_CATEGORY = { OL7: '주유', CS2: '편의점', CE7: '카페', FD6: '식사' };

export async function moveStopovers(start, end, payments, keyword = async () => null, attachedPayments = new Set()) {
  const labels = [];
  for (const payment of payments) {
    const at = Date.parse(payment.at);
    if (!(at > start && at < end) || attachedPayments.has(payment)
      || !payment.merchant || genericMerchant(payment.merchant)) continue;
    const found = await keyword(payment.merchant, payment);
    const activity = MOVE_ACTIVITY_BY_CATEGORY[found?.category];
    labels.push(activity ? `${activity}: ${payment.merchant}` : payment.merchant);
  }
  return labels.length ? ` (${labels.join(', ')})` : '';
}

export async function attachRouteActivities(stays, { payments = [], events = [], moves = [],
  keyword = async () => null, attachedPayments = new Set() } = {}) {
  const result = stays.map((stay) => ({ ...stay }));
  for (const payment of payments) {
    const at = Date.parse(payment.at);
    if (!Number.isFinite(at) || !payment.merchant || genericMerchant(payment.merchant)) continue;
    const candidates = result.filter((stay) => stay.kind !== 'move' && at >= Date.parse(stay.start)
      && at <= Date.parse(stay.end) + PAYMENT_GRACE_MINUTES * 60_000);
    const stay = candidates.find((candidate) => at <= Date.parse(candidate.end)) ?? candidates[0];
    // 이동 중 결제라도 앞 체류가 끝난 직후의 승인 유예에 해당하면 그 체류를 우선한다.
    if (moves.some((move) => at > Date.parse(move.start) && at < Date.parse(move.end))
      && (!stay || at < Date.parse(stay.end))) continue;
    if (!stay || stay.registered || stay.kind === 'roam') continue;
    const found = await keyword(payment.merchant, stay.lat, stay.lon);
    const activity = ACTIVITY_BY_CATEGORY[found?.category];
    if (!activity) continue;
    stay.label = found.name || payment.merchant;
    stay.activity = activity;
    attachedPayments.add(payment);
  }
  for (const stay of result) {
    if (stay.kind === 'move' || stay.activity) continue;
    for (const event of Array.isArray(events) ? events : []) {
      if (event.allDay) continue;
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      const overlap = Math.min(Date.parse(stay.end), end) - Math.max(Date.parse(stay.start), start);
      if (!Number.isFinite(overlap) || !Number.isFinite(end - start) || end <= start
        || overlap <= 0 || (overlap < EVENT_OVERLAP_MINUTES * 60_000 && overlap < (end - start) / 2)) continue;
      stay.activity = EVENT_ACTIVITIES.find(([pattern]) => pattern.test(event.title ?? ''))?.[1] ?? null;
      if (stay.activity) break;
    }
  }
  return result;
}
