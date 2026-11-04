// LiveSync(Self-hosted LiveSync 1.0.42)가 올리지 않는 볼트 경로 판정 — livesync-watch가 "볼트가 바뀌었는데 서버 번호가
// 그대로"를 볼 때, 플러그인이 애초에 안 올리는 파일의 변경을 세지 않기 위해 쓴다(2026-11-04 오너 승인: 고빈도 기계
// 데이터를 폰 동기화에서 뺌 → syncIgnoreRegEx에 95_Etna 일부 규칙).
//
// 플러그인 구현(main.js getFileRegExp·parseCustomRegExpList·CustomRegExp·isTargetFile)과 같게 맞춘다:
//   - 규칙 문자열에서 줄바꿈과 공백을 모두 지운 뒤 `|[]|`로 나누고 빈 항목은 버린다.
//   - 항목이 `!!`로 시작하면 뒤집은 규칙(맞지 않을 때 참)이다.
//   - handleFilenameCaseSensitive가 참이 아니면(없음 포함) `i` 플래그를 붙인다. g 플래그는 없다(test가 상태를 안 남김).
//   - 볼트 기준 상대 경로(구분자 `/`, 앞에 `/` 없음, 예: `95_Etna/Jobs/a.json`)에 대해 검사한다.
//   - syncOnlyRegEx가 비어 있지 않으면 어느 하나에도 맞지 않는 파일은 올리지 않는다. 그다음 syncIgnoreRegEx 중
//     하나라도 맞으면 올리지 않는다.
//
// 불변식(무인 재시작 잡의 판정 근거라 보수적으로):
//   - data.json에서 syncIgnoreRegEx·syncOnlyRegEx·handleFilenameCaseSensitive 세 키만 꺼내고 나머지(특히 자격증명)는
//     돌려주지도, 보관하지도, 로그에 남기지도 않는다. 로그에는 규칙 항목과 오류 종류만 쓴다.
//   - 파일 읽기 실패·JSON 파싱 실패·키 형식 이상이면 null(= 제외 없음, 예전처럼 모든 경로를 센다).
//   - 잘못된 정규식 항목은 그 항목만 버리고 로그를 남긴다. 플러그인은 이때 예외를 내므로 실제로는 그 규칙이
//     먹지 않는다 — 제외를 덜 하는 쪽(변경을 더 세는 쪽)으로 틀리게 한다.
//   - syncOnlyRegEx 항목이 모두 잘못됐으면 "제한 없음"으로 본다(모든 경로를 센다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVESYNC_DATA_REL = '.obsidian/plugins/obsidian-livesync/data.json';
const DELIMITER = '|[]|';

function compileList(source, flags, key, log) {
  const out = [];
  for (const item of source.replace(/\n| /g, '').split(DELIMITER).filter(Boolean)) {
    const negate = item.startsWith('!!');
    try {
      out.push({ negate, regexp: new RegExp(negate ? item.slice(2) : item, flags) });
    } catch (e) {
      log(`LiveSync ${key} 항목이 잘못된 정규식이라 무시함: ${item} (${e.message})`);
    }
  }
  return out;
}

const testRule = (rule, relPath) => (rule.negate ? !rule.regexp.test(relPath) : rule.regexp.test(relPath));

// 순수함수 — data.json 내용(문자열) → 판정용 필터. 못 쓰면 null(모든 경로를 센다).
export function parseLiveSyncFilter(text, log = () => {}) {
  let settings;
  // 오류 메시지는 남기지 않는다 — V8 JSON 오류에는 원문 조각(자격증명일 수 있음)이 들어간다.
  try { settings = JSON.parse(text); } catch { log('LiveSync 설정 JSON 파싱 실패 — 모든 경로를 셈'); return null; }
  if (!settings || typeof settings !== 'object') { log('LiveSync 설정이 객체가 아님 — 모든 경로를 셈'); return null; }
  const { syncIgnoreRegEx: ignoreSrc = '', syncOnlyRegEx: onlySrc = '', handleFilenameCaseSensitive } = settings;
  settings = null; // 나머지 키는 들고 있지 않는다
  if (typeof ignoreSrc !== 'string' || typeof onlySrc !== 'string') { log('LiveSync 규칙 값이 문자열이 아님 — 모든 경로를 셈'); return null; }
  const flags = handleFilenameCaseSensitive ? '' : 'i';
  return { ignore: compileList(ignoreSrc, flags, 'syncIgnoreRegEx', log), only: compileList(onlySrc, flags, 'syncOnlyRegEx', log) };
}

// 순수함수 — 볼트 기준 상대 경로(`/` 구분)를 LiveSync가 올리는지. filter가 null이면 항상 true.
export function isLiveSyncTarget(relPath, filter) {
  if (!filter) return true;
  if (filter.only.length > 0 && !filter.only.some((r) => testRule(r, relPath))) return false;
  return !filter.ignore.some((r) => testRule(r, relPath));
}

// 볼트 루트의 LiveSync 설정을 읽는다. 읽기 실패는 null(모든 경로를 센다).
export function readLiveSyncFilter(root, log = () => {}) {
  let text;
  try { text = readFileSync(join(root, LIVESYNC_DATA_REL), 'utf8'); } catch (e) {
    log(`LiveSync 설정 읽기 실패 — 모든 경로를 셈 (${e.code ?? 'unknown'})`);
    return null;
  }
  return parseLiveSyncFilter(text, log);
}
