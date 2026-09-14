// Knowledge/Meta/므네모시네-파일배선도.md 파서 — 순수함수. 오너 지시(2026-09-14):
// "파일배선도를 만든 이유가 하나를 고치면 뭘 같이 고쳐야 하는지 알려주려는 건데,
// 그걸 실제로 활용해서 지금 수정 중인 노트가 뭐랑 연관 있는지 알려줄 수 없나" —
// 이 문서는 지금까지 "사람이 열어서 읽고 기억해서 챙기는" 용도로만 쓰였다. 이 파서로
// 클러스터별 정본·종속파일 목록을 기계가 읽을 수 있게 뽑아내면, Write/Edit 훅이
// "방금 건드린 파일이 어느 클러스터에 속하는지" 그 자리에서 알려줄 수 있다(아래
// scripts/hooks/wiring-map-guard.mjs가 이 파서를 사용).
//
// 파싱 전략: 완전한 마크다운 파서가 아니라, 이 문서의 실제 관례(## 클러스터 N —
// 제목, **정본**: 줄, 종속 파일|무엇을 담는가|가드 3열 표)에 맞춘 라이트 파서다.
// 백틱(`)으로 감싼 토큰 중 경로처럼 보이는 것만(슬래시 포함, 또는 확장자 있는
// 단일 파일명) 골라내고, `{a,b,c}` 중괄호 전개(cluster 1·3·6의 brace-expansion
// 표기)를 실제 경로 여러 개로 펼친다.

// "{a,b,c}" 부분을 재귀적으로 전개 — 중첩 중괄호는 이 프로젝트 문서에 없어 1단계만 지원.
export function expandBraces(pathStr) {
  const m = pathStr.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!m) return [pathStr];
  const [, prefix, alts, suffix] = m;
  return alts.split(',').flatMap((alt) => expandBraces(`${prefix}${alt.trim()}${suffix}`));
}

// 백틱 토큰이 "경로처럼" 보이는지 — 슬래시 포함(scripts/lib/x.mjs) 또는 점 확장자
// 있는 단일 파일명(CLAUDE.md). TARGET_ALLOCATION·EXPECTED_INTERVALS_MS 같은 코드
// 상수/식별자 표기(슬래시도 점도 없음)는 제외 — 파일배선도.md 자체가 정본 설명에
// "정본: `path`의 `CONSTANT_NAME`(설명)"처럼 경로와 식별자를 같은 줄에 섞어 쓴다.
function looksLikePath(token) {
  return token.includes('/') || /^[\w.-]+\.\w+$/.test(token);
}

function extractPathTokens(text) {
  const tokens = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    if (looksLikePath(raw)) tokens.push(...expandBraces(raw));
  }
  return tokens;
}

// content 전체를 "## 클러스터 N — 제목" 경계로 잘라 클러스터 배열로 반환.
// 각 클러스터: { name, sourcePaths, entries: [{ path, guard, row }] }.
// guard: '테스트' | '수동' | null(정본 자기 자신, 가드 개념 자체가 없음).
export function parseWiringMapClusters(content) {
  const clusterRe = /^## (클러스터 \S+[^\n]*)$/gm;
  const matches = [...content.matchAll(clusterRe)];
  const clusters = [];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const block = content.slice(start, end);

    const sourceMatch = block.match(/\*\*정본\*\*:([^\n]*(?:\n(?!\|)[^\n]*)*)/);
    const sourcePaths = sourceMatch ? extractPathTokens(sourceMatch[1]) : [];

    const entries = [];
    for (const line of block.split('\n')) {
      if (!line.trim().startsWith('|') || /^\|\s*[-:]+\s*\|/.test(line)) continue; // 구분선(|---|) 스킵
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 2) continue;
      const firstCell = cells[0];
      if (firstCell === '종속 파일') continue; // 헤더 행
      const paths = extractPathTokens(firstCell);
      if (!paths.length) continue;
      const guardCell = cells[cells.length - 1];
      const guard = guardCell.includes('테스트') ? '테스트' : guardCell.includes('수동') ? '수동' : null;
      for (const path of paths) entries.push({ path, guard, row: firstCell });
    }
    clusters.push({ name, sourcePaths, entries });
  }
  return clusters;
}

// clusterPath(문서에 적힌 경로, "State/Allocation/*.md" 같은 와일드카드 가능)가
// relPath(실제 건드린 파일의 상대경로)와 같은 대상을 가리키는지.
export function pathMatches(clusterPath, relPath) {
  if (clusterPath.includes('*')) {
    const prefix = clusterPath.slice(0, clusterPath.indexOf('*'));
    return relPath.startsWith(prefix);
  }
  const strip = (p) => p.replace(/\.md$/, '');
  return strip(clusterPath) === strip(relPath);
}

// relPath 하나가 어느 클러스터(들)에 속하는지 — 정본 경로든 종속 경로든 매칭되면
// 포함. 반환: [{ name, isSource, others: [{path, guard, row}] }] — others는 relPath
// 자신을 뺀 "같이 확인해야 할 나머지"만.
export function findRelatedClusters(clusters, relPath) {
  const results = [];
  for (const cluster of clusters) {
    const isSource = cluster.sourcePaths.some((p) => pathMatches(p, relPath));
    const matchedEntry = cluster.entries.find((e) => pathMatches(e.path, relPath));
    if (!isSource && !matchedEntry) continue;
    const others = cluster.entries.filter((e) => !pathMatches(e.path, relPath));
    results.push({ name: cluster.name, isSource, others });
  }
  return results;
}
