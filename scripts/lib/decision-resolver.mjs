import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL, VAULT_ROOT } from './vault-paths.mjs';

// 제목과 날짜는 교체 때 바뀐다. 활성 결정의 안정적인 식별자는 decisionKey다.
export function resolveDecision(decisionKey, { vaultRoot = VAULT_ROOT } = {}) {
  const decisionDir = join(vaultRoot, VAULT_REL.decisionsCanonical);
  const matches = [];
  let entries;
  try {
    entries = readdirSync(decisionDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`결정 문서 폴더가 없습니다: ${decisionDir}`, { cause: error });
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(decisionDir, entry.name);
    const content = readFileSync(path, 'utf8');
    const frontmatter = parseFrontmatter(content);
    // 기존 평면 파서는 YAML 홑따옴표 문자열을 그대로 돌려준다. 결정 문서의
    // targetAllocation JSON은 홑따옴표로 감싸져 있어 이 필드만 벗긴다.
    if (typeof frontmatter.targetAllocation === 'string' &&
        frontmatter.targetAllocation.startsWith("'") && frontmatter.targetAllocation.endsWith("'")) {
      frontmatter.targetAllocation = frontmatter.targetAllocation.slice(1, -1).replace(/''/g, "'");
    }
    if (frontmatter.decisionKey !== decisionKey || frontmatter.status !== '결정됨') continue;
    const header = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (!header) throw new Error(`결정 문서 머리말을 해석할 수 없습니다: ${path}`);
    const body = content.slice(header[0].length).trim();
    if (!body) throw new Error(`결정 문서 본문이 비어 있습니다: ${path}`);
    matches.push({ path, frontmatter, body });
  }
  if (matches.length !== 1) {
    throw new Error(`decisionKey '${decisionKey}'의 결정됨 문서가 ${matches.length}개입니다 (정확히 1개 필요): ${decisionDir}`);
  }
  return matches[0];
}
