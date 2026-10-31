// Vault State 파일 동시쓰기 방지 — 락파일(원자적 생성) + 원자적 교체(임시파일 쓰기 후
// rename). 여러 잡(가격폴링·카카오파싱·투자실행협의체 체결반영 등)이 같은 State 파일
// (예: 보유종목 현재수량)을 거의 동시에 갱신하려 들 수 있다 — 이 모듈 하나로 통일해
// 잡마다 락 처리를 다르게 짜서 생기는 사각을 없앤다
// (docs/ARCHITECTURE-V2.md "동시성·시크릿 보관" 절, 구현계획서 Phase 1).
//
// 락 획득 실패 시 짧게 재시도 후 포기한다(무한 대기 금지) — 죽은 프로세스가 락을 들고
// 있으면 그 자리에서 시스템 전체가 멈추면 안 되므로, 오래된 락(staleLockMs 초과)은
// 소유 프로세스가 죽은 경우에만 정리한다. 살아 있는 프로세스의 장시간 쓰기는 보존한다.

import {
  writeFileSync, renameSync, unlinkSync, closeSync, openSync, statSync, readFileSync, existsSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { updateFrontmatter } from './vault-frontmatter.mjs';

const DEFAULT_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_MS = 10_000;

// 락 파일은 같은 폴더의 점 파일 `.{파일명}.lock`이다(2026-10-31). 볼트 안 State 파일의 락이 점 파일이 아니면
// LiveSync가 잠깐 생긴 락까지 폰으로 옮기고 볼트 lint에도 걸린다 — 점 파일은 둘 다 건너뛴다.
// 이미 점으로 시작하는 파일(`.nh-order-….lock` 등)은 예전 이름 그대로 쓴다(이미 숨김이고, 이름을 바꿀 이유가 없다).
export function lockFilePath(filePath) {
  const name = basename(filePath);
  return name.startsWith('.') ? `${filePath}.lock` : join(dirname(filePath), `.${name}.lock`);
}

// 전환 기간: 옛 코드를 이미 메모리에 올린 프로세스는 예전 이름 `{파일}.lock`을 잡는다. 새 이름을 잡기 전과 잡은 뒤
// 예전 이름도 확인해 겹칠 창을 줄인다 — 완전히 막지는 못한다(잡은 뒤 확인을 지난 다음 옛 코드가 예전 이름을 잡을 수
// 있다). 완전한 배제는 배포 직후 이 모듈을 쓰는 상시 프로세스를 모두 다시 띄운 뒤부터다. 그 뒤에는 예전 이름이
// 생기지 않으므로 이 확인은 늘 비어 있다(제거 조건·대상은 Requests `2026-10-31 락 파일 예전 이름 확인 제거`).
export function legacyLockFilePath(filePath) {
  return `${filePath}.lock`;
}

// 다른 코드가 '이 파일을 누가 쓰고 있나'를 볼 때 쓰는 두 이름(새·예전). 둘 중 하나라도 있으면 쓰는 중이다.
export function lockFilesFor(filePath) {
  const current = lockFilePath(filePath);
  const legacy = legacyLockFilePath(filePath);
  return current === legacy ? [current] : [current, legacy];
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH'; // 권한이 없어 확인 못 해도 살아 있는 것으로 취급
  }
}

// 락 파일이 오래됐고 소유 프로세스가 죽었으면 지운다(살아 있으면 그대로). 그 사이 바뀌었으면 손대지 않는다.
function reapIfDead(lp, staleLockMs) {
  try {
    const stat = statSync(lp);
    if (Date.now() - stat.mtimeMs > staleLockMs) {
      const owner = readFileSync(lp, 'utf8');
      const pid = Number(owner.split(':', 1)[0]);
      if (!processIsAlive(pid)) {
        const current = statSync(lp);
        if (current.ino === stat.ino && readFileSync(lp, 'utf8') === owner) unlinkSync(lp);
      }
    }
  } catch {
    // 그 사이 다른 프로세스가 이미 정리·해제했으면 무시 — 다음 재시도에서 다시 판단
  }
}

function legacyLockHeld(filePath, staleLockMs) {
  const legacy = legacyLockFilePath(filePath);
  if (legacy === lockFilePath(filePath) || !existsSync(legacy)) return false;
  reapIfDead(legacy, staleLockMs);
  return existsSync(legacy);
}

// O_EXCL(wx)로 생성한 락에 소유자 토큰을 남긴다. 시간이 오래됐다는 이유만으로 살아
// 있는 쓰기의 락을 회수하지 않는다(긴 fsync 중 두 쓰기가 겹치는 사고 방지).
function tryAcquireLock(filePath, staleLockMs) {
  const lp = lockFilePath(filePath);
  if (legacyLockHeld(filePath, staleLockMs)) return null; // 옛 코드가 쥐고 있음 — 다음 재시도에서 다시 본다
  let owner;
  try {
    const fd = openSync(lp, 'wx', 0o600);
    owner = `${process.pid}:${randomUUID()}`;
    try {
      writeFileSync(fd, owner);
    } catch (error) {
      try { unlinkSync(lp); } catch { /* 다른 오류를 가리지 않음 */ }
      throw error;
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    reapIfDead(lp, staleLockMs);
    return null;
  }
  // 새 이름을 잡은 사이 옛 코드가 예전 이름을 잡았으면 내 것을 풀고 물러난다(겹칠 창을 줄인다).
  if (legacyLockHeld(filePath, staleLockMs)) {
    releaseLock(filePath, owner);
    return null;
  }
  return owner;
}

function releaseLock(filePath, owner) {
  try {
    const lp = lockFilePath(filePath);
    if (readFileSync(lp, 'utf8') === owner) unlinkSync(lp);
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
    const owner = tryAcquireLock(filePath, staleLockMs);
    if (owner) {
      try {
        return await fn();
      } finally {
        releaseLock(filePath, owner);
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
