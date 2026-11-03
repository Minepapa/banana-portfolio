// 같은 내용이면 쓰지 않기(2026-11-03, 데이터 체계 개선 ⑤).
// 볼트는 LiveSync로 폰에 실시간 복제된다. 내용이 그대로인데 시각 칸(updatedAt·lastRun 등)만 바꿔 10분마다 덮어쓰면
// 하루 수천 번 복제가 일어나 폰 쪽 충돌·되살아남(10-28 사고)의 위험이 커진다. 이 모듈은 "비교 키가 같고, 마지막으로 쓴 지
// 정한 시간이 안 지났으면 쓰지 않는다"는 판단과 원자적 쓰기를 한곳에 모은다.
//
// 불변식:
// - 건너뛰는 것은 "앞 파일이 있고, 읽히고, 비교 키가 같고, (시각 함수를 줬다면) 그 시각이 유효하고 아직 새로 고칠 때가 아닐 때"뿐이다.
//   하나라도 모르면(파일 없음·깨짐·시각 없음·미래 시각) 쓴다 — 건너뛰기는 언제나 안전한 쪽(쓰기)으로 기운다.
// - 쓰기는 같은 폴더의 점 임시 파일에 다 쓴 뒤 이름을 바꾼다(LiveSync는 점 파일을 옮기지 않는다). 실패하면 임시 파일을 지우고
//   다시 던진다 — 원본은 그대로다(state-writer.mjs writeAtomic과 같은 방식).
// - 테스트(NODE_TEST_CONTEXT) 중에는 실제 볼트 아래에 쓰지 않는다(10-31 데일리 덮어쓰기 사고).
// - 락은 잡지 않는다. 여러 잡이 같은 파일을 쓰면 호출부가 state-writer.mjs withLock으로 감싼다.
//
// ⚠️ 이 모듈은 vault-paths를 import하지 않는다(vault-frontmatter·state-writer도 그걸 import하므로 같이 금지).
// 테스트가 정적 import해도 실제 볼트 경로를 잡지 않게 하고, data-freshness.mjs(같은 원칙)도 쓸 수 있게 하려는 것이다.
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// vault-paths.mjs DEFAULT_VAULT_ROOT와 같은 값이어야 한다(write-if-changed.test.js가 대조한다).
// VAULT_PATH 환경변수와 무관하게 "실제 볼트"를 가리킨다 — 테스트가 VAULT_PATH를 임시 폴더로 바꿔도 이 경로는 막는다.
export const REAL_VAULT_ROOT = join(homedir(), 'Pantheon', 'Mouseion');

// 아직 없는 파일도 비교할 수 있게, 존재하는 가장 가까운 조상의 실경로에 나머지를 붙인다(옛 볼트 심볼릭 링크 대비).
function realpathOfNearest(path) {
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  try { return join(realpathSync(current), ...rest); } catch { return resolve(path); }
}

export function isInsideDir(root, file) {
  const rel = relative(realpathOfNearest(root), realpathOfNearest(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// 테스트 중 실볼트(REAL_VAULT_ROOT)와 호출부가 더 넘긴 루트 아래 쓰기를 막는다. 운영에서는 아무 일도 안 한다.
export function assertNotRealVaultInTest(file, extraRoots = []) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  for (const root of [REAL_VAULT_ROOT, ...extraRoots]) {
    if (root && isInsideDir(root, file)) throw new Error('테스트에서 실볼트 경로 쓰기 금지');
  }
}

export function writeFileAtomic(file, content) {
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = openSync(temp, 'wx');
  let closed = false;
  try {
    writeFileSync(fd, content, 'utf8');
    closeSync(fd);
    closed = true;
    renameSync(temp, file);
  } catch (error) {
    if (!closed) { try { closeSync(fd); } catch { /* 이미 닫힘 */ } }
    try { unlinkSync(temp); } catch { /* 없음 — 원래 오류를 가리지 않는다 */ }
    throw error;
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// 머리말에서 keys 줄을 뺀 전체 텍스트(본문 포함). 머리말 값은 한 줄이다(vault-frontmatter.mjs 불변식 — 중첩 객체 저장 불가),
// 그래서 줄 단위로 빼도 된다. 머리말이 없으면 그대로 돌려준다.
export function frontmatterWithout(text, keys) {
  const match = FRONTMATTER_RE.exec(text ?? '');
  if (!match) return text ?? '';
  const kept = match[1].split('\n').filter((line) => {
    const idx = line.indexOf(':');
    return idx <= 0 || !keys.includes(line.slice(0, idx).trim());
  });
  return `---\n${kept.join('\n')}\n---${text.slice(match[0].length)}`;
}

// 머리말 시각 칸(ISO 문자열)을 ms로. 없거나 못 읽으면 null.
export function frontmatterTime(text, key) {
  const match = FRONTMATTER_RE.exec(text ?? '');
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0 || line.slice(0, idx).trim() !== key) continue;
    let raw = line.slice(idx + 1).trim();
    if (raw.startsWith('"')) { try { raw = JSON.parse(raw); } catch { return null; } }
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function kstDateLabel(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

/**
 * 같은 내용이면 쓰지 않는다. 썼으면 true, 건너뛰었으면 false.
 * options:
 *   compareKey(text) → 비교용 문자열. 기본은 내용 전체(바이트가 같아야 건너뜀).
 *   writtenAt(text) → 앞 파일을 마지막으로 쓴 시각(ms|null). 주면 아래 두 조건으로 "같아도 다시 쓰기"를 정한다.
 *   refreshMs: 마지막으로 쓴 지 이만큼 지나면 내용이 같아도 다시 쓴다(시각 칸 새로 고침). 기본 Infinity.
 *   sameKstDay: true면 마지막으로 쓴 날(KST)이 오늘이 아니면 다시 쓴다 — "그날 갱신이 있었나"를 보는 감시가 오탐하지 않게.
 *   now: 지금(ms). guardRoots: 테스트 중 쓰기를 막을 루트를 더한다(실볼트는 항상 막는다).
 *   previous: 호출부가 이미 읽은 지금 파일 내용(락 안에서 읽은 것 등). 주면 다시 읽지 않는다. null이면 파일이 없는 것으로 본다.
 */
export function writeIfChanged(file, content, { compareKey = (text) => text, writtenAt = null, refreshMs = Infinity,
  sameKstDay = false, now = Date.now(), guardRoots = [], previous } = {}) {
  assertNotRealVaultInTest(file, guardRoots);
  if (previous === undefined) {
    previous = null;
    try { previous = readFileSync(file, 'utf8'); } catch { /* 없거나 못 읽으면 새로 쓴다 */ }
  }
  if (previous !== null && skipWrite(previous, content, { compareKey, writtenAt, refreshMs, sameKstDay, now })) return false;
  writeFileAtomic(file, content);
  return true;
}

function skipWrite(previous, content, { compareKey, writtenAt, refreshMs, sameKstDay, now }) {
  let same;
  try { same = compareKey(previous) === compareKey(content); } catch { return false; }
  if (!same) return false;
  if (!writtenAt) return true;
  let at;
  try { at = writtenAt(previous); } catch { return false; }
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  if (age < 0 || age >= refreshMs) return false; // 미래 시각(시계 어긋남)도 다시 쓴다
  if (sameKstDay && kstDateLabel(at) !== kstDateLabel(now)) return false;
  return true;
}
