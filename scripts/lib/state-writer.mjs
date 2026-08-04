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
  writeFileSync, renameSync, unlinkSync, closeSync, openSync, statSync,
} from 'node:fs';

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
