// Vault State 파일 동시쓰기 방지 — 락파일(원자적 생성) + 원자적 교체(임시파일 쓰기 후
// rename). 여러 잡(가격폴링·카카오파싱·투자실행협의체 체결반영 등)이 같은 State 파일
// (예: 보유종목 현재수량)을 거의 동시에 갱신하려 들 수 있다 — 이 모듈 하나로 통일해
// 잡마다 락 처리를 다르게 짜서 생기는 사각을 없앤다
// (docs/ARCHITECTURE-V2.md "동시성·시크릿 보관" 절, 구현계획서 Phase 1).
//
// 락 획득 실패 시 짧게 재시도 후 포기한다(무한 대기 금지) — 죽은 프로세스가 락을 들고
// 있으면 그 자리에서 시스템 전체가 멈추면 안 되므로, 오래된 락(staleLockMs 초과)은
// 죽은 프로세스의 잔재로 간주하고 정리한다.

import {
  writeFileSync, renameSync, unlinkSync, closeSync, openSync, statSync, readFileSync,
} from 'node:fs';
import { updateFrontmatter } from './vault-frontmatter.mjs';

const DEFAULT_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_MS = 10_000;

function lockPath(filePath) {
  return `${filePath}.lock`;
}

// O_EXCL(wx) 플래그로 락파일을 원자적으로 생성 — 이미 존재하면 EEXIST로 실패(다른
// 프로세스가 쓰는 중). 오래된 락은 죽은 프로세스의 잔재로 보고 정리 후 다음 루프에서
// 재시도(이 호출 자체는 실패로 반환 — 정리 직후 바로 뺏지 않고 한 박자 쉬어 경합 완화).
function tryAcquireLock(filePath, staleLockMs) {
  const lp = lockPath(filePath);
  try {
    const fd = openSync(lp, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const stat = statSync(lp);
      if (Date.now() - stat.mtimeMs > staleLockMs) unlinkSync(lp);
    } catch {
      // 그 사이 다른 프로세스가 이미 정리·해제했으면 무시 — 다음 재시도에서 다시 판단
    }
    return false;
  }
}

function releaseLock(filePath) {
  try {
    unlinkSync(lockPath(filePath));
  } catch {
    // 이미 없으면(예: 정리됨) 무시 — 해제는 best-effort
  }
}

// 락을 획득한 뒤 fn을 실행하고, 끝나면 반드시 락을 해제한다. 획득 실패 시 retryDelayMs
// 간격으로 최대 retries회 재시도하고, 그래도 안 되면 포기하고 던진다(무한 대기 금지).
export async function withLock(filePath, fn, {
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    if (tryAcquireLock(filePath, staleLockMs)) {
      try {
        return await fn();
      } finally {
        releaseLock(filePath);
      }
    }
    if (attempt >= retries) {
      throw new Error(
        `락 획득 실패(포기): ${filePath} — 다른 프로세스가 ${retries}회 재시도 동안 계속 점유 중`,
      );
    }
    await sleep(retryDelayMs);
  }
}

// 원자적 쓰기 — 같은 프로세스·시각 조합으로 유일한 임시 파일에 먼저 쓴 뒤 rename.
// rename은 같은 파일시스템 내에서 원자적이라, 쓰는 도중 다른 프로세스가 절반만 쓰인
// 파일을 보는 사고를 방지한다. 락 없이 단독으로도 쓸 수 있으나(원자성은 이것만으로도
// 확보), 여러 프로세스의 read-modify-write 경합까지 막으려면 withLock과 함께 써야 한다.
export function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

// 락+원자적쓰기를 한 번에 — State 파일을 쓸 때는 기본적으로 이 함수 하나만 쓰면 된다.
export async function writeStateFile(filePath, content, lockOpts = {}) {
  return withLock(filePath, () => writeAtomic(filePath, content), lockOpts);
}

// ⚠️ read-modify-write 경합 방지(2026-09-04, VIP펀드 매수누적 작업 코드리뷰에서
// 발견 — Log/Implementation/2026-09-04-VIP펀드매수누적반영.md "남은 것" 참고) —
// State/Holdings 파일 하나에 여러 잡이 서로 다른 필드를 쓴다(예: update-holdings-
// prices.mjs는 curPrice·evalAmount만, update-holdings-from-executions.mjs는
// qty·invest·avgPrice만). 배치로 미리 읽어둔 stale content를 그대로 patch해서 쓰면,
// 그 사이 다른 잡이 이 파일의 다른 필드를 바꿔놨어도 이 쓰기가 그 변경을 조용히
// 되돌려버린다 — 락을 잡은 채로 파일을 다시 읽어(진짜 최신 내용) 그 위에 patch만
// 얹어야 안전하다. writeStateFile과 달리 "이미 존재하는 파일"만 대상 — 새 파일
// 생성은 patch할 대상이 없으므로 호출부가 writeStateFile로 직접 처리할 것.
//
// ⚠️ 이 함수를 거치는 모든 호출자가 락을 존중해야 완전히 안전하다 — 아직 이
// 코드베이스의 모든 State/Holdings 쓰기가 이 함수로 전환되진 않았다(전환 현황은
// 위 문서 참고, 순차적으로 확산 중).
//
// ⚠️ ENOENT는 던지지 않고 false 반환(2026-09-04 코드리뷰 MEDIUM 지적으로 정정) —
// 호출부(예: update-holdings-prices.mjs)는 보통 배치로 파일 목록을 먼저 훑은 뒤
// 시세 조회 같은 느린 API 호출을 거쳐 한참 뒤에야 이 함수를 부른다. 그 사이(수십 초
// ~수 분) 다른 잡이 그 보유를 전량청산해 파일 자체를 지워버렸을 수 있다 — 이걸
// 그냥 throw하면 이 함수를 감싸는 모든 호출부가 안 죽게 방어해야 하는데, 실제로는
// 하나도 안 돼 있었다(전 종목 배치 처리 중 하나가 지워졌다고 나머지 전부 처리
// 실패로 끝나는 건 과한 반응). "이 파일은 이제 patch 대상이 아니다"는 정상적인
// 흐름이지 예외 상황이 아니므로 false로 알리고, 호출부가 스킵으로 처리한다.
export async function patchFrontmatterFileSafely(filePath, patch, lockOpts = {}) {
  return withLock(filePath, () => {
    let freshContent;
    try {
      freshContent = readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    writeAtomic(filePath, updateFrontmatter(freshContent, patch));
    return true;
  }, lockOpts);
}
