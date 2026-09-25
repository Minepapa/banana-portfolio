// 체결 소스는 계좌와 상품별로 하나만 사용한다. API가 실제로 조회하는 범위는 API가
// 정본이고, API 조회가 없는 범위만 카카오 알림을 원장에 기록한다.
import {
  IRP_ACCOUNT_LABEL, IRP_ACCOUNT_NO, QUANT_ACCOUNT_NO, QUANT_TRACK_LABEL,
} from './account-resolver.mjs';
import { NH_ACCOUNT_MAP } from './nh-accounts.mjs';
import { GB_EXECUTION_API_CUTOVER_KST_DATE, kstDateOrNull } from './gb-execution-cutover.mjs';

export { GB_EXECUTION_API_CUTOVER_KST_DATE } from './gb-execution-cutover.mjs';

export function isGbKakaoExecutionAfterCutover({ event = {}, receivedAt } = {}) {
  // 해외 체결 알림에는 신뢰할 수 있는 체결일/주문일자 필드가 없다. parseExecution의
  // tradeDate는 현재 알림 수신시각(ts)에서 만들어지지만, 형식이 깨진 원문에도 대비해
  // 먼저 유효한 event 날짜를 쓰고 애매하면 원본 수신시각으로 한 번 더 판정한다.
  // 둘 다 YYYY-MM-DD로 확정할 수 없으면 새 제외를 추정하지 않고 기존 기록을 유지한다.
  const date = kstDateOrNull(event.tradeDate) ?? kstDateOrNull(receivedAt);
  return date != null && date >= GB_EXECUTION_API_CUTOVER_KST_DATE;
}

export function classifyKakaoExecution({ kind = 'stock', event = {}, receivedAt } = {}) {
  if (kind === 'gold') {
    if (event.broker !== 'NH투자증권') {
      return { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' };
    }
    return { action: 'exclude-api', account: '금현물', reason: 'NH_API' };
  }

  if (event.broker === 'NH투자증권 해외') {
    // 중개형 ISA는 해외 상장주식 직접거래가 불가하고(국내 상장 해외노출 ETF만
    // 가능), 이 프로젝트의 ISA 보유·주문·NH API 계좌목록도 그 제약과 일치한다.
    // 따라서 컷오버 이후 알림만 위탁 gbstock API의 확인용 원문으로 보관하고 Ledger에는
    // 쓰지 않는다. 이전(또는 날짜가 애매한) 알림은 이미 완료된 카카오 원장을 보존한다.
    if (isGbKakaoExecutionAfterCutover({ event, receivedAt })) {
      return { action: 'exclude-api', account: '위탁', reason: 'NH_API' };
    }
    return { action: 'record', account: null, reason: 'API_UNAVAILABLE' };
  }

  if (event.broker === '삼성증권') {
    return { action: 'record', account: '연금저축', reason: 'API_UNAVAILABLE' };
  }

  if (event.broker === '한국투자증권') {
    if (event.acctNo === QUANT_ACCOUNT_NO) {
      return { action: 'exclude-api', account: QUANT_TRACK_LABEL, reason: 'KIS_API' };
    }
    // IRP 체결조회 API는 구현돼 있으나 실거래 대사에서 계속 0건을 반환해, 현재는
    // 카카오 알림이 유일하게 검증된 체결 소스다.
    if (event.acctNo === IRP_ACCOUNT_NO) {
      return { action: 'record', account: IRP_ACCOUNT_LABEL, reason: 'API_UNAVAILABLE' };
    }
    return { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' };
  }

  if (event.broker === 'NH투자증권') {
    const account = NH_ACCOUNT_MAP[event.acctNo] ?? null;
    if (!account) return { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' };
    if (account === '위탁') return { action: 'exclude-api', account, reason: 'NH_API' };
    if (account === 'ISA') return { action: 'record', account, reason: 'API_UNAVAILABLE' };
    return { action: 'unresolved', account, reason: 'UNSUPPORTED_ACCOUNT' };
  }

  return { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' };
}
