// 테미스 판정 원장(2026-10-31 오너 승인) — 테미스가 내린 통과·보류·거부 판정을 한 줄씩 남기는 append-only 원장.
// 헌장(볼트 90_Delphi/Agents/themis §5)의 "판정 기록"을 기계가 읽을 수 있는 정본으로 둔다. 올림푸스 테미스 방·분기 판정
// 리뷰가 읽는다.
// - 쓰는 길은 scripts/tools/themis-verdict-cli.mjs append 하나다. 제우스가 테미스 하위 에이전트 판정을 받으면 기록한다.
// - 볼트 쓰기는 락을 잡고 파일 전체를 다시 쓴다: 같은 폴더의 점 파일에 쓰고 fsync한 뒤 rename — LiveSync에는
//   완성된 내용으로 한 번만 바뀐 것으로 보인다(쓰다 만 파일이 폰으로 가지 않는다).
// - 기존 줄이 하나라도 깨져 있으면 쓰지 않는다. 고칠 때까지 판정이 조용히 사라지거나 덮이지 않게.
// - 금고 경로·자격증명·계좌번호 같은 민감값은 가리지 않고 거부한다(가린 판정은 근거로 쓸 수 없다). 호출부가 바꿔 쓴다.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AGENT_IDS } from './agent-registry.mjs';
import { withLock } from './state-writer.mjs';
import { VAULT_REL, vaultAbs } from './vault-paths.mjs';

export const THEMIS_VERDICTS_PATH = vaultAbs(VAULT_REL.themisVerdicts);
export const VERDICT_SCHEMA_VERSION = 1;
export const VERDICTS = Object.freeze(['통과', '보류', '거부']);
// 헌장 §5 책임 항목과 같은 갈래. 맞는 것이 없으면 '기타'.
export const VERDICT_KINDS = Object.freeze(['주문 제안', '미디어 삭제', '결정 문서', '돌파 사후', '기타']);
const REQUESTERS = new Set([...AGENT_IDS, 'owner']);
const LIMITS = Object.freeze({ subject: 200, reasons: 600, refs: 8, ref: 200 });
const INPUT_FIELDS = new Set(['subject', 'requestedBy', 'verdict', 'kind', 'reasons', 'refs', 'recordedBy', 'at']);
// 근거로 남길 수 있는 참조: 볼트 상대 경로(최상위 10·20·30·40·50·60·80·90·95_ 폴더, 상위 이동 없음) 또는 커밋(저장소@해시·해시).
const VAULT_REF = /^(?:10|20|30|40|50|60|80|90|95)_[^/]+(?:\/[^/]+)*$/u;
// 커밋 참조: a-f 글자가 하나 이상 있는 해시만(숫자만 있는 계좌·전화가 해시로 통과하지 않게).
// 전체 해시(13~40자)는 '저장소@해시' 꼴로만 받는다 — 16진수 API 키(32·40자)가 맨 해시로 들어오지 않게. 맨 해시는 짧은 것(7~12자)만.
const COMMIT_REF = /^(?:([A-Za-z0-9._-]{1,60})@(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}|(?=[0-9a-f]*[a-f])[0-9a-f]{7,12})$/;
// 금고: 숫자 접두 폴더와 금고 이름 낱말 모두. 이름은 조각으로 이어 만든다(명령·코드 검색에 금고 이름을 그대로 쓰지 않는 관례).
const SECRET_VAULT = [/(?:^|[^\p{L}\p{N}])9{2}_[\p{L}\p{N}]/u, new RegExp(['A', 'dyton'].join(''), 'i'), /아디톤/];
const ID_RE = /^TV-\d{8}-[0-9a-f]{8}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 민감값 검사 — 가리지 않고 거부한다. 경고 원장 가림 규칙(warning-event-journal redactWarningDetail)과 같은 갈래다.
// 긴 숫자 검사 전에 판정 근거에 흔한 것을 먼저 지운다: 판정 아이디(TV-…), 날짜(2026-10-31·20261031, 월·일 범위 확인,
// 앞뒤가 숫자·대시가 아닐 때만 — 3333-01-1234567 같은 계좌 앞부분을 날짜로 오인하지 않게), 시각, a-f가 섞인 커밋 해시.
// 그다음 숫자를 공백·대시·별표로 이어 붙여 8자리 이상이면 거부한다(010 1234 5678, 205-01-59***9 등).
// 원칙: 근거 요약에는 금액·주문번호를 쓰지 않는다(쓰면 콤마로 끊거나 빼고 다시 기록) — 민감값 쪽으로 보수적.
// 이름=값 꼴 자격증명은 원문에서 본다(값이 해시처럼 생겨도 지우기 전에 잡는다). 'token:'처럼 이름 뒤에 : 또는 =만 와도
// 값 모양과 상관없이 거부한다(보수적, 제우스 판단 2026-10-31). 긴 키(32자+)만 해시를 지운 뒤 본다.
const CREDENTIAL = [
  /Bearer\s+\S+/i,
  /["']?(?:app[_-]?key|app[_-]?secret(?:key)?|access[_-]?token|token|password|passwd|secret)["']?\s*[:=]/i,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/,
];
const LONG_KEY = /\b[A-Za-z0-9]{32,}\b/;
const SAFE_NUMBER_SHAPES = [
  /\bTV-\d{8}-(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/g, // 원장 아이디 꼬리는 늘 a-f를 하나 이상 품게 만든다(아래 buildVerdictRecord)
  /(?<![\d-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g,
  /(?<![\d-])(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?![\d-])/g,
  /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g,
  // 자유 문장에서는 짧은 커밋 해시(7~12자)만 지운다 — 32·40자 16진수(API 키)는 남겨 긴 키 검사에 걸리게.
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/g,
];
const JOINED_NUMBER = /\d(?:[\s*-]+\d|\d)*/g;
// 다른 무인 잡(zeus-headline 출력 검증)도 같은 민감값 기준을 쓴다 — 기준을 한곳에 둔다.
export function assertNoSensitive(field, text) {
  if (SECRET_VAULT.some((pattern) => pattern.test(text))) throw new Error(`${field}: 금고 경로·이름은 넣을 수 없다`);
  if (CREDENTIAL.some((pattern) => pattern.test(text))) throw new Error(`${field}: 자격증명으로 보이는 값은 넣을 수 없다`);
  const withoutSafe = SAFE_NUMBER_SHAPES.reduce((value, pattern) => value.replace(pattern, ' '), text);
  if (LONG_KEY.test(withoutSafe)) throw new Error(`${field}: 자격증명으로 보이는 값은 넣을 수 없다`);
  const longest = Math.max(0, ...(withoutSafe.match(JOINED_NUMBER) ?? []).map((run) => run.replace(/\D/g, '').length));
  if (longest >= 8) {
    throw new Error(`${field}: 계좌·전화·금액·주문번호 같은 8자리 이상 숫자는 넣을 수 없다(근거 요약에는 금액·주문번호를 쓰지 않는다 — 빼거나 콤마로 끊어 다시 기록, 종목코드 여럿은 콤마로 구분)`);
  }
}

function textField(input, field, { required = true } = {}) {
  const text = oneLine(input[field]);
  if (!text) {
    if (required) throw new Error(`${field}가 비어 있다`);
    return '';
  }
  if (text.length > LIMITS[field]) throw new Error(`${field}는 ${LIMITS[field]}자 이하`);
  assertNoSensitive(field, text);
  return text;
}

function refsField(input) {
  if (input.refs == null) return [];
  if (!Array.isArray(input.refs)) throw new Error('refs는 문자열 배열');
  if (input.refs.length > LIMITS.refs) throw new Error(`refs는 ${LIMITS.refs}개 이하`);
  return input.refs.map((value) => {
    const ref = oneLine(value).replace(/\.md$/, '');
    if (!ref || ref.length > LIMITS.ref) throw new Error('refs 항목 길이 오류');
    const vault = VAULT_REF.test(ref) && !ref.split('/').some((part) => part === '..' || part === '.');
    if (vault) { assertNoSensitive('refs', ref); return ref; }
    const commit = COMMIT_REF.exec(ref);
    if (commit) { if (commit[1]) assertNoSensitive('refs', commit[1]); return ref; } // 해시는 형식으로 확인, 저장소 이름만 민감값 검사
    throw new Error('refs 항목은 볼트 상대 경로나 커밋 해시만');
  });
}

// 아이디 꼬리 8자: 늘 a-f를 하나 이상 품게 한다 — 근거 문장 속 아이디를 지울 때 숫자만 있는 번호와 헷갈리지 않게.
function idTail(uuid) {
  const tail = uuid().replace(/-/g, '').slice(0, 8).toLowerCase();
  return /[a-f]/.test(tail) ? tail : `a${tail.slice(1)}`;
}

// 순수 함수: 입력 → 저장할 한 줄 객체. 모르는 필드는 거부한다(오타로 근거가 빠지지 않게).
export function buildVerdictRecord(input, { now = new Date(), uuid = randomUUID } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('판정은 객체여야 한다');
  const unknown = Object.keys(input).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length) throw new Error(`모르는 필드: ${unknown.join(', ')}`);
  if (!VERDICTS.includes(input.verdict)) throw new Error(`verdict는 ${VERDICTS.join('·')} 중 하나`);
  if (!REQUESTERS.has(input.requestedBy)) throw new Error('requestedBy는 담당 id(zeus·hermes·…) 또는 owner');
  const recordedBy = input.recordedBy ?? 'zeus';
  if (!AGENT_IDS.includes(recordedBy)) throw new Error('recordedBy는 담당 id');
  const kind = input.kind ?? '기타';
  if (!VERDICT_KINDS.includes(kind)) throw new Error(`kind는 ${VERDICT_KINDS.join('·')} 중 하나`);
  // at은 시간대가 있는 ISO 문자열만(날짜만·숫자는 해석이 갈린다). 미래(5분 넘게)·1년보다 먼 과거는 거부.
  if (input.at !== undefined && (typeof input.at !== 'string' || !ISO_WITH_ZONE.test(input.at))) throw new Error('at은 시간대가 있는 ISO 시각(예: 2026-10-31T15:40:00+09:00)');
  const at = input.at === undefined ? now : new Date(input.at);
  if (!Number.isFinite(at.getTime())) throw new Error('at은 시간대가 있는 ISO 시각');
  // 없는 날짜(2026-02-30)는 Date가 다음 달로 넘겨 버린다 — 적힌 시각의 날짜·시각 부분이 그대로인지 확인한다.
  if (input.at !== undefined) {
    const offset = /([+-])(\d{2}):(\d{2})$/.exec(input.at);
    const shift = offset ? (offset[1] === '+' ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000 : 0;
    if (new Date(at.getTime() + shift).toISOString().slice(0, 16) !== input.at.slice(0, 16)) throw new Error('at에 없는 날짜·시각이 있다');
  }
  if (at.getTime() > now.getTime() + 5 * 60_000 || at.getTime() < now.getTime() - 365 * 86_400_000) throw new Error('at은 지금부터 1년 이내 과거여야 한다');
  const day = new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, ''); // 아이디 날짜는 KST
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    id: `TV-${day}-${idTail(uuid)}`,
    at: at.toISOString(),
    kind,
    subject: textField(input, 'subject'),
    requestedBy: input.requestedBy,
    verdict: input.verdict,
    reasons: textField(input, 'reasons'),
    refs: refsField(input),
    recordedBy,
  };
}

// 원장 읽기. 깨진 줄이 있으면 몇째 줄인지와 함께 던진다(내용은 메시지에 싣지 않는다).
export function parseVerdictLines(text) {
  // 줄 번호는 파일의 실제 줄 번호(빈 줄 포함)로 알린다.
  return String(text ?? '').split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`판정 원장 ${index + 1}째 줄을 읽을 수 없다`); }
    if (record?.schemaVersion !== VERDICT_SCHEMA_VERSION || !ID_RE.test(record.id) || !VERDICTS.includes(record.verdict)) {
      throw new Error(`판정 원장 ${index + 1}째 줄 형식 불일치`);
    }
    return [record];
  });
}

export function readVerdicts(path = THEMIS_VERDICTS_PATH) {
  return existsSync(path) ? parseVerdictLines(readFileSync(path, 'utf8')) : [];
}

// 같은 폴더 점 파일 → fsync → rename → 폴더 fsync. 실패하면 임시 파일만 지우고 원본은 그대로 둔다.
// 권한은 기존 파일 것을 이어받는다(처음이면 볼트 파일과 같은 0644).
function replaceFile(path, content) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* 이미 닫힘 */ }
    try { unlinkSync(tmp); } catch { /* 없음 */ }
    throw error;
  }
  try { const dirFd = openSync(dirname(path), 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* 폴더 fsync를 지원하지 않는 파일시스템 */ }
}

// 판정 한 건을 덧붙인다(락 안에서 읽고·검사하고·전체를 다시 쓴다). 반환: 저장한 줄 객체.
export async function appendVerdict(input, { path = THEMIS_VERDICTS_PATH, now = new Date(), uuid = randomUUID, lockOptions = {} } = {}) {
  const record = buildVerdictRecord(input, { now, uuid });
  mkdirSync(dirname(path), { recursive: true });
  await withLock(path, () => {
    const existingText = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const existing = parseVerdictLines(existingText); // 깨진 줄이 있으면 여기서 멈춘다
    if (existing.some((item) => item.id === record.id)) throw new Error('판정 아이디가 겹친다(다시 시도)');
    // 기존 내용은 글자 그대로 두고 끝에 한 줄만 붙인다(다시 직렬화하지 않는다).
    const prefix = existingText && !existingText.endsWith('\n') ? `${existingText}\n` : existingText;
    replaceFile(path, `${prefix}${JSON.stringify(record)}\n`);
  }, lockOptions);
  return record;
}
