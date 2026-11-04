// LiveSync(Self-hosted LiveSync 1.0.42)가 올리지 않는 볼트 경로 판정 — livesync-watch가 "볼트가 바뀌었는데 서버 번호가
// 그대로"를 볼 때, 플러그인이 애초에 안 올리는 파일의 변경을 세지 않기 위해 쓴다(2026-11-04 오너 승인: 고빈도 기계
// 데이터를 폰 동기화에서 뺌 → syncIgnoreRegEx에 95_Etna 일부 규칙).
//
// 운영 절차(리뷰 MEDIUM-2):
//   - 규칙은 Mac Obsidian의 LiveSync 설정 화면에서 넣는다. 그러면 플러그인과 data.json이 같은 값을 갖는다.
//   - data.json을 손으로 직접 고쳤다면 Obsidian을 바로 다시 켠다. 플러그인은 켤 때 읽은 설정을 쓰므로, 다시 켜기 전까지는
//     이 잡(파일을 읽음)과 플러그인(메모리 값)의 규칙이 달라 멈춤을 놓치거나 잘못 판정할 수 있다.
//   - 플러그인을 올리면(manifest.json version이 1.0.42가 아니면) 아래 해석이 그대로인지 main.js를 다시 확인한다.
//     잡은 판정을 바꾸지 않고 상태 파일·로그에 표시만 한다.
//
// 플러그인 구현(main.js getFileRegExp·parseCustomRegExpList·CustomRegExp·isTargetFile)과 같게 맞춘다:
//   - 규칙 문자열에서 줄바꿈과 공백을 모두 지운 뒤 `|[]|`로 나누고 빈 항목은 버린다.
//   - 항목이 `!!`로 시작하면 뒤집은 규칙(맞지 않을 때 참)이다.
//   - handleFilenameCaseSensitive가 참이 아니면(없음 포함) `i` 플래그를 붙인다. g 플래그는 없다(test가 상태를 안 남김).
//   - 볼트 기준 상대 경로(구분자 `/`, 앞에 `/` 없음, 예: `95_Etna/Jobs/a.json`)에 대해 검사한다. Obsidian 경로는
//     NFC로 정규화돼 있으므로 부르는 쪽이 NFC로 맞춰 넘긴다(macOS 파일 이름은 NFD일 수 있다).
//   - syncOnlyRegEx가 비어 있지 않으면 어느 하나에도 맞지 않는 파일은 올리지 않는다. 그다음 syncIgnoreRegEx 중
//     하나라도 맞으면 올리지 않는다.
//
// 불변식(무인 재시작 잡의 판정 근거라 보수적으로):
//   - data.json에서 syncIgnoreRegEx·syncOnlyRegEx·handleFilenameCaseSensitive 세 키만 꺼내고 나머지(특히 자격증명)는
//     돌려주지도, 보관하지도, 로그에 남기지도 않는다. 로그에는 규칙 항목과 오류 종류만 쓴다.
//   - status: ok(읽음) · missing(파일 없음 = 규칙 없음) · read-fail · parse-fail · bad-type. ok가 아니면 filter는
//     null(= 제외 없음, 예전처럼 모든 경로를 센다). read-fail·parse-fail·bad-type이면 잡은 멈춤이어도 재시작하지 않는다.
//   - 규칙 키 값이 null·undefined면 ''(규칙 없음)로 보고, 그 뒤 문자열이 아니면 bad-type이다.
//   - 잘못된 정규식 항목은 그 항목만 버리고(invalidRules로 센다) 로그를 남긴다. 플러그인은 getFileRegExp에서 모든
//     항목을 한꺼번에 만들다 예외를 내므로, 실제로는 isTargetFile이 매번 실패해 파일 처리가 전부 멈출 수 있다 —
//     Obsidian을 다시 켜도 고쳐지지 않는 설정 오류다. 판정은 제외를 덜 하는 쪽(변경을 더 세는 쪽)으로 틀리게 한다.
//   - syncOnlyRegEx 항목이 모두 잘못됐으면 "제한 없음"으로 본다(모든 경로를 센다).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LIVESYNC_DATA_REL = '.obsidian/plugins/obsidian-livesync/data.json';
// 아래 해석을 main.js에서 직접 확인한 플러그인 판.
export const VERIFIED_PLUGIN_VERSION = '1.0.42';
const DELIMITER = '|[]|';

function compileList(source, flags, key, log) {
  const rules = [];
  let invalid = 0;
  for (const item of source.replace(/\n| /g, '').split(DELIMITER).filter(Boolean)) {
    const negate = item.startsWith('!!');
    try {
      rules.push({ negate, regexp: new RegExp(negate ? item.slice(2) : item, flags) });
    } catch (e) {
      invalid += 1;
      log(`LiveSync ${key} 항목이 잘못된 정규식이라 무시함: ${item} (${e.message}) — 플러그인은 이 때문에 파일 처리가 전부 실패할 수 있다. 재시작으로 고쳐지지 않는 설정 오류`);
    }
  }
  return { rules, invalid };
}

const testRule = (rule, relPath) => (rule.negate ? !rule.regexp.test(relPath) : rule.regexp.test(relPath));

// 순수함수 — data.json 내용(문자열) → { filter, status, invalidRules }. ok가 아니면 filter는 null(모든 경로를 센다).
export function parseLiveSyncFilter(text, log = () => {}) {
  let settings;
  // 오류 메시지는 남기지 않는다 — V8 JSON 오류에는 원문 조각(자격증명일 수 있음)이 들어간다.
  try { settings = JSON.parse(text); } catch {
    log('LiveSync 설정 JSON 파싱 실패 — 모든 경로를 셈');
    return { filter: null, status: 'parse-fail', invalidRules: 0 };
  }
  if (!settings || typeof settings !== 'object') {
    log('LiveSync 설정이 객체가 아님 — 모든 경로를 셈');
    return { filter: null, status: 'bad-type', invalidRules: 0 };
  }
  const ignoreSrc = settings.syncIgnoreRegEx ?? '';
  const onlySrc = settings.syncOnlyRegEx ?? '';
  const flags = settings.handleFilenameCaseSensitive ? '' : 'i';
  settings = null; // 나머지 키는 들고 있지 않는다
  if (typeof ignoreSrc !== 'string' || typeof onlySrc !== 'string') {
    log('LiveSync 규칙 값이 문자열이 아님 — 모든 경로를 셈');
    return { filter: null, status: 'bad-type', invalidRules: 0 };
  }
  const ignore = compileList(ignoreSrc, flags, 'syncIgnoreRegEx', log);
  const only = compileList(onlySrc, flags, 'syncOnlyRegEx', log);
  return { filter: { ignore: ignore.rules, only: only.rules }, status: 'ok', invalidRules: ignore.invalid + only.invalid };
}

// 순수함수 — 볼트 기준 상대 경로(`/` 구분, NFC)를 LiveSync가 올리는지. filter가 null이면 항상 true.
export function isLiveSyncTarget(relPath, filter) {
  if (!filter) return true;
  if (filter.only.length > 0 && !filter.only.some((r) => testRule(r, relPath))) return false;
  return !filter.ignore.some((r) => testRule(r, relPath));
}

// 플러그인 판(manifest.json version). 못 읽으면 null.
function readPluginVersion(root) {
  try {
    const version = JSON.parse(readFileSync(join(root, dirname(LIVESYNC_DATA_REL), 'manifest.json'), 'utf8'))?.version;
    return typeof version === 'string' ? version.slice(0, 40) : null;
  } catch { return null; }
}

// 볼트 루트의 LiveSync 설정을 읽는다 → { filter, status, invalidRules, pluginVersion, versionOk }.
// 판이 확인한 것과 달라도 표시만 하고 판정은 바꾸지 않는다(리뷰 LOW-4).
export function readLiveSyncFilter(root, log = () => {}) {
  const pluginVersion = readPluginVersion(root);
  const versionOk = pluginVersion === VERIFIED_PLUGIN_VERSION;
  let parsed;
  try {
    parsed = parseLiveSyncFilter(readFileSync(join(root, LIVESYNC_DATA_REL), 'utf8'), log);
  } catch (e) {
    const status = e.code === 'ENOENT' ? 'missing' : 'read-fail';
    log(`LiveSync 설정 ${status === 'missing' ? '없음(규칙 없음)' : '읽기 실패'} — 모든 경로를 셈 (${e.code ?? 'unknown'})`);
    parsed = { filter: null, status, invalidRules: 0 };
  }
  if (parsed.status !== 'missing' && !versionOk) {
    log(`LiveSync 플러그인 판 ${pluginVersion ?? '모름'} — 규칙 해석은 ${VERIFIED_PLUGIN_VERSION}에서 확인함(판정은 그대로)`);
  }
  return { ...parsed, pluginVersion, versionOk };
}
