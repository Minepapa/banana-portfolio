import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('PVB1');
const PREFIX_LENGTH = 4 + 12 + 16;
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const APP_PROPERTY = { pantheon: 'vault-backup' };
const FOLDER_NAME = 'Pantheon Vault Backups';
const FILE_MIME = 'application/octet-stream';
const NAME = /^pantheon-vault-(\d{4}-\d{2}-\d{2})\.bundle\.enc$/;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('백업 키는 32바이트여야 함');
}
export function encryptBuffer(buf, key) {
  checkKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}
export function decryptBuffer(blob, key) {
  checkKey(key);
  if (!Buffer.isBuffer(blob) || blob.length < PREFIX_LENGTH || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('백업 형식 오류');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}

export function planRetention(files, today) {
  if (!validDate(today)) throw new Error('today 날짜 오류');
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  // 오늘을 1일째로 세어 14개 달력일을 전부 보존한다.
  const recentCutoff = new Date(todayMs - 13 * 86400_000).toISOString().slice(0, 10);
  const monthlyCutoff = new Date(todayMs);
  const dayOfMonth = monthlyCutoff.getUTCDate();
  monthlyCutoff.setUTCDate(1);
  monthlyCutoff.setUTCFullYear(monthlyCutoff.getUTCFullYear() - 1);
  const lastDay = new Date(monthlyCutoff);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  monthlyCutoff.setUTCDate(Math.min(dayOfMonth, lastDay.getUTCDate()));
  const cutoff = monthlyCutoff.toISOString().slice(0, 10);
  const candidates = files.map((file) => {
    const name = typeof file === 'string' ? file : file.name;
    const date = NAME.exec(name)?.[1];
    return date && validDate(date) ? { file, date } : null;
  }).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
  const months = new Set();
  const keep = [];
  const remove = [];
  for (const { file, date } of candidates) {
    if (date >= recentCutoff || date > today) { keep.push(file); continue; }
    const month = date.slice(0, 7);
    if (date >= cutoff && !months.has(month) && months.size < 12) { months.add(month); keep.push(file); }
    else remove.push(file);
  }
  return { keep, delete: remove };
}

async function request(url, { token, fetchImpl = fetch, method = 'GET', headers = {}, body, timeout = 15000 }) {
  const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Google Drive 요청 실패 (HTTP ${response.status})`);
  return response;
}
export async function listFiles({ token, fetchImpl = fetch, folderId, appProperties = APP_PROPERTY } = {}) {
  const files = [];
  let pageToken;
  const seen = new Set();
  do {
    const url = new URL(DRIVE);
    const property = appProperties.pantheon;
    if (!property || typeof property !== 'string') throw new Error('Drive 앱 속성 오류');
    const escapedProperty = property.replaceAll("'", "\\'");
    url.searchParams.set('q', folderId ? `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false` : `appProperties has { key='pantheon' and value='${escapedProperty}' } and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,size,parents,appProperties,mimeType)');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await (await request(url, { token, fetchImpl })).json();
    if (!Array.isArray(data.files)) throw new Error('Google Drive 목록 형식 오류');
    files.push(...data.files);
    pageToken = data.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error('Google Drive pageToken 반복');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return files;
}
export async function findOrCreateFolder({ token, fetchImpl = fetch, appProperties = APP_PROPERTY, folderName = FOLDER_NAME } = {}) {
  const folders = await listFiles({ token, fetchImpl, appProperties });
  const existing = folders.find((file) => file.appProperties?.pantheon === appProperties.pantheon && file.mimeType === 'application/vnd.google-apps.folder');
  if (existing) return existing;
  const response = await request(`${DRIVE}?fields=id,name,appProperties,mimeType`, {
    token, fetchImpl, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', appProperties }),
  });
  return response.json();
}
export async function uploadBackup({ token, fetchImpl = fetch, folderId, name, blob, appProperties = APP_PROPERTY, mimeType = FILE_MIME, namePattern = NAME } = {}) {
  if (!folderId || !namePattern.test(name) || !Buffer.isBuffer(blob)) throw new Error('업로드 인자 오류');
  const boundary = `vault-${randomBytes(12).toString('hex')}`;
  const metadata = { name, parents: [folderId], appProperties };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    blob, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request(`${UPLOAD}&fields=id,name,size,parents,appProperties`, {
    token, fetchImpl, method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body, timeout: 300000,
  });
  return response.json();
}
export async function downloadBackup({ token, fetchImpl = fetch, id } = {}) {
  const response = await request(`${DRIVE}/${encodeURIComponent(id)}?alt=media`, { token, fetchImpl, timeout: 300000 });
  return Buffer.from(await response.arrayBuffer());
}
export async function deleteBackup({ token, fetchImpl = fetch, folderId, file, appProperties = APP_PROPERTY, namePattern = NAME } = {}) {
  if (!folderId || !file?.id || !file.parents?.includes(folderId) || file.appProperties?.pantheon !== appProperties.pantheon || !namePattern.test(file.name)) throw new Error('앱 백업 파일만 삭제 가능');
  await request(`${DRIVE}/${encodeURIComponent(file.id)}`, {
    token, fetchImpl, method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
