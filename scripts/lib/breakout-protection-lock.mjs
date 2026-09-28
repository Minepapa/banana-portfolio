// 돌파매매 청산 관리(reconcile-breakout-protection.mjs, 매일 08:35 자동)와 수동
// 재시도 CLI(retry-breakout-protection.mjs)가 공유하는 락 경로·유효기간 —
// 둘 다 같은 포지션 파일에 실주문을 낼 수 있어 락이 갈려 있으면 동시 실행 시
// 중복 손절주문 위험이 있다(2026-09-29 3차 코드리뷰 MEDIUM 지적 — 오너가 08:35
// 잡의 긴급 경고를 받고 그 자리에서 CLI를 돌리는 게 정확히 그 경합 시나리오).
// 처음엔 CLI가 잡 파일에서 이 상수를 직접 import했는데, tools/가 jobs/의 전체
// 의존 그래프(텔레그램·장부기록·킬스위치 등)를 딸려 들여오고 계층 방향도 거꾸로라
// (2026-09-29 4차 코드리뷰 LOW 지적), 둘 다 이 작은 공용 모듈을 보게 옮겼다.
import { join } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';

export const BREAKOUT_PROTECTION_LOCK_FILE = join(VAULT_PATHS.state.breakoutPositions, '.protection.lock');
// 계좌조회·여러 보유종목 순회·주문 재시도보다 state-writer 기본 10초 stale 기준을
// 충분히 길게 둔다 — 중복 실행이 이 락을 만료로 오판해 제거하면 같은 주문을 둘
// 낼 위험이 있다.
export const BREAKOUT_PROTECTION_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
