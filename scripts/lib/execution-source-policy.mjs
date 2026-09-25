// 체결 소스는 계좌와 상품별로 하나만 사용한다. API가 실제로 조회하는 범위는 API가
// 정본이고, API 조회가 없는 범위만 카카오 알림을 원장에 기록한다.
import {
  IRP_ACCOUNT_LABEL, IRP_ACCOUNT_NO, QUANT_ACCOUNT_NO, QUANT_TRACK_LABEL,
} from './account-resolver.mjs';
import { NH_ACCOUNT_MAP } from './nh-accounts.mjs';

export function classifyKakaoExecution({ kind = 'stock', event = {} } = {}) {
  if (kind === 'gold') {
    if (event.broker !== 'NH투자증권') {
      return { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' };
    }
    return { action: 'exclude-api', account: '금현물', reason: 'NH_API' };
  }

  if (event.broker === 'NH투자증권 해외') {
    // 현재 NH 체결 대사는 국내주식·금현물만 지원한다.
    // ISA와 위탁이 모두 후보이므로 여기서 계좌까지 추정하지 않는다.
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
