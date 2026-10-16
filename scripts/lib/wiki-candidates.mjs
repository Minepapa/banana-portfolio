/** Report 계획의 잠정 Wiki 후보만 계산한다. plans가 정본이므로 이 결과는 언제든 재구성할 수 있다. */
import { VAULT_REL } from './vault-paths.mjs';
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const normalizeWikiName = (name) => String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko');
const similarName = (name) => normalizeWikiName(name).replace(/[\s\p{P}\p{S}]/gu, '');
function closeName(left, right) {
  const a = [...similarName(left)];
  const b = [...similarName(right)];
  if (a.length < 2 || b.length < 2 || Math.abs(a.length - b.length) > 1) return false;
  if (a.join('') === b.join('')) return true;
  let i = 0;
  let j = 0;
  let differences = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    differences += 1;
    if (differences > 1) return false;
    if (a.length >= b.length) i += 1;
    if (a.length <= b.length) j += 1;
  }
  return differences + (a.length - i) + (b.length - j) <= 1;
}
const pageName = (page) => page.split('/').at(-1);
const validDate = (value) => {
  const date = typeof value === 'string' ? value : '';
  return DATE_RE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
};

export function sourceMeta(content, observedAt, parseFrontmatter) {
  const fields = parseFrontmatter(content);
  const origin = String(fields.origin ?? '').trim();
  const occurred = validDate(fields.occurred);
  const created = validDate(fields.created);
  const ownerDirect = /^(오너|owner)$/i.test(String(fields.author ?? '').trim())
    || fields.owner === true || /^(오너|owner)$/i.test(String(fields.owner ?? '').trim());
  // type: inbox는 입력 경로의 종류가 아니다. 출처가 명시된 경우만 관문의 근거로 센다.
  const kind = /^(?:통화|대화|회의|conversation|call|chat)(?:$|[\s:])/i.test(origin) ? 'conversation'
    : /^(?:media:|미디어(?:$|[\s:])|사진(?:$|[\s:])|영상(?:$|[\s:])|녹음(?:$|[\s:])|audio(?:$|[\s:])|video(?:$|[\s:]))/i.test(origin) ? 'media'
      : /^(?:문헌|웹클리퍼|웹 클리퍼|기사|책|literature|web clipper|webclipper|article|book)(?:$|[\s:])/i.test(origin) ? 'literature'
        : /^(?:텔레그램(?: 📜)?|telegram|옵시디언|obsidian)$/i.test(origin) ? 'note' : 'unknown';
  return { occurredAt: occurred ?? created, dateBasis: occurred ? 'occurred' : created ? 'created' : 'unknown',
    observedAt, kind, ownerDirect };
}

function matchesCatalog(page, catalog) {
  const folder = page.slice(0, page.lastIndexOf('/'));
  const name = pageName(page);
  const exact = [];
  const similar = [];
  const crossFolder = [];
  for (const entry of catalog) {
    const names = [pageName(entry.path), ...(entry.aliases ?? [])];
    const sameFolder = entry.path.slice(0, entry.path.lastIndexOf('/')) === folder;
    const sameName = names.some((alias) => normalizeWikiName(alias) === normalizeWikiName(name));
    if (entry.path === page || (sameFolder && sameName)) exact.push(entry.path);
    else if (!sameFolder && sameName) crossFolder.push(entry.path);
    else if (names.some((alias) => closeName(alias, name))) similar.push(entry.path);
  }
  return { exact: [...new Set(exact)].sort(), similar: [...new Set(similar)].sort(),
    crossFolder: [...new Set(crossFolder)].sort() };
}

function immediateExceptions(candidate) {
  const context = candidate.reasons.join(' ');
  const title = pageName(candidate.page);
  const hints = [];
  if (candidate.page.startsWith(`${VAULT_REL.people}/`) && /가족|배우자|자녀|부모|형제/.test(context)) hints.push('family');
  if (candidate.page.startsWith(`${VAULT_REL.wikiObjects}/`) && /보유 계좌|증권 계좌/.test(context)) hints.push('account');
  if (candidate.page.startsWith(`${VAULT_REL.knowledgeTopics}/AssetClass/`)
    || (candidate.page.startsWith(`${VAULT_REL.knowledgeTopics}/`)
      && /^(주식|채권|현금|금|부동산|배당주|리츠)$/.test(title))) hints.push('asset-class-possible');
  if (/진행 중 프로젝트/.test(context)) hints.push('active-project');
  if (/오너.*요청|직접.*요청|생성.*요청/.test(context)) hints.push('owner-request-possible');
  return hints;
}

function similarNameKeys(name) {
  const compact = similarName(name);
  const chars = [...compact];
  return new Set([compact, ...chars.map((_, index) => chars.filter((__, offset) => offset !== index).join(''))]);
}

export function buildWikiCandidates(plans, catalog = []) {
  const candidates = new Map();
  for (const plan of plans) for (const item of plan.items ?? []) {
    if (item.status !== '계획함' || !item.source || !item.hash) continue;
    for (const wiki of item.judgment?.wiki ?? []) {
      if (wiki.action !== 'candidate') continue;
      const page = wiki.page.replace(/\.md$/, '');
      const name = pageName(page);
      const key = `${page.slice(0, page.lastIndexOf('/'))}/${normalizeWikiName(name)}`;
      let candidate = candidates.get(key);
      if (!candidate) {
        candidate = { key, page, titleAliases: [], reasons: [], sources: [], sourceStatus: 'provisional',
          review: 'clio-pending' };
        candidates.set(key, candidate);
      }
      if (!candidate.titleAliases.includes(name)) candidate.titleAliases.push(name);
      if (!candidate.reasons.includes(wiki.reason)) candidate.reasons.push(wiki.reason);
      const meta = item.sourceMeta ?? {};
      if (!candidate.sources.some((source) => source.path === item.source && source.hash === item.hash)) {
        candidate.sources.push({ path: item.source, hash: item.hash, kind: meta.kind ?? 'unknown',
          occurredAt: validDate(meta.occurredAt), dateBasis: meta.dateBasis ?? 'unknown',
          observedAt: validDate(meta.observedAt) ?? validDate(plan.date), ownerDirect: meta.ownerDirect === true });
      }
    }
  }
  const result = [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key, 'ko'));
  const similarBuckets = new Map();
  for (const candidate of result) {
    for (const key of similarNameKeys(pageName(candidate.page))) {
      if (!similarBuckets.has(key)) similarBuckets.set(key, []);
      similarBuckets.get(key).push(candidate);
    }
  }
  for (const candidate of result) {
    candidate.titleAliases.sort((a, b) => a.localeCompare(b, 'ko'));
    candidate.reasons.sort((a, b) => a.localeCompare(b, 'ko'));
    candidate.sources.sort((a, b) => a.path.localeCompare(b.path, 'ko') || a.hash.localeCompare(b.hash));
    // 같은 입력 노트가 편집되어 해시가 달라져도 기간·종류 관문의 근거는 한 번만 센다.
    const latestByNote = new Map();
    for (const source of candidate.sources) {
      const previous = latestByNote.get(source.path);
      if (!previous || (source.observedAt ?? '') > (previous.observedAt ?? '')
        || ((source.observedAt ?? '') === (previous.observedAt ?? '') && source.hash > previous.hash)) {
        latestByNote.set(source.path, source);
      }
    }
    const evidence = [...latestByNote.values()];
    const dates = [...new Set(evidence.map((source) => source.occurredAt).filter(Boolean))].sort();
    const kinds = new Set(evidence.map((source) => source.kind).filter((kind) => kind !== 'unknown'));
    const spanDays = dates.length > 1 ? (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / DAY_MS : 0;
    candidate.dates = { firstMention: dates[0] ?? null, lastMention: dates.at(-1) ?? null,
      observed: [...new Set(candidate.sources.map((source) => source.observedAt).filter(Boolean))].sort() };
    candidate.counts = { notes: evidence.length, kinds: kinds.size, ownerDirect: evidence.filter((source) => source.ownerDirect).length,
      spanDays };
    candidate.gates = { threeNotes: evidence.length >= 3, fourteenDays: dates.length >= 2 && spanDays >= 14,
      kindsOrOwner: kinds.size >= 2 || candidate.counts.ownerDirect >= 1 };
    const match = matchesCatalog(candidate.page, catalog);
    const neighbors = new Set();
    for (const key of similarNameKeys(pageName(candidate.page))) {
      for (const other of similarBuckets.get(key) ?? []) neighbors.add(other);
    }
    const sibling = [...neighbors].filter((other) => other !== candidate
      && closeName(pageName(other.page), pageName(candidate.page)));
    const personNeedsIdentityReview = candidate.page.startsWith(`${VAULT_REL.people}/`)
      && evidence.length > 1;
    candidate.immediateExceptionReview = 'clio-pending';
    candidate.immediateExceptions = immediateExceptions(candidate);
    candidate.conflicts = [...new Set([...match.similar, ...match.crossFolder, ...sibling.map((other) => other.page),
      ...(personNeedsIdentityReview ? ['identity-review'] : [])])].sort();
    candidate.existingPages = match.exact;
    candidate.status = match.exact.length > 1 || candidate.conflicts.length ? 'hold'
      : match.exact.length === 1 ? 'existing'
        : Object.values(candidate.gates).every(Boolean) ? 'ready' : 'collecting';
  }
  return { version: 1, candidates: result };
}
