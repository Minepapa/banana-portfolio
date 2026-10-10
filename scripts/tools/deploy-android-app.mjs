#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DRIVE_BACKUP_SCOPES, getAccessToken } from '../lib/google-oauth.mjs';
import { deleteBackup, findOrCreateFolder, listFiles, uploadBackup } from '../lib/vault-offsite-backup.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';

const exec = promisify(execFile);
const DEFAULT_PROJECT = join(homedir(), 'Pantheon', 'Repos', 'Kakao-Notification');
const JAVA_HOME = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const APP_PROPERTIES = { pantheon: 'android-apps' };
const FOLDER_NAME = 'Pantheon 앱';
const APK_MIME = 'application/vnd.android.package-archive';
const APK_NAME = /^kakao-notification-\d{8}-\d{4}-[0-9a-f]+\.apk$/;
export const SENDER_AGENT = 'zeus';

function options(argv) {
  const result = { project: DEFAULT_PROJECT, dryRun: false, noSend: false, requireClean: false };
  for (const arg of argv) {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-send') result.noSend = true;
    else if (arg === '--require-clean') result.requireClean = true;
    else if (arg.startsWith('--project=') && arg.length > '--project='.length) result.project = arg.slice('--project='.length);
    else throw new Error('사용법: deploy-android-app.mjs [--project=경로] [--require-clean] [--dry-run] [--no-send]');
  }
  return result;
}

function buildName(now, commit) {
  const kst = new Date(now + 9 * 3600_000).toISOString();
  return `kakao-notification-${kst.slice(0, 10).replaceAll('-', '')}-${kst.slice(11, 16).replace(':', '')}-${commit}.apk`;
}

function outputTail(error) {
  return [error.stdout, error.stderr].filter(Boolean).join('\n').trim().split(/\r?\n/).slice(-30).join('\n');
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const io = { exec, readFile, getAccessToken, findOrCreateFolder, uploadBackup, listFiles,
    deleteBackup, sendAgentMessage, now: () => Date.now(), log: console.log, warn: console.warn, ...dependencies };
  const { project, dryRun, noSend, requireClean } = options(argv);
  const gitOptions = { cwd: project, maxBuffer: 10 * 1024 * 1024 };
  const { stdout: status } = await io.exec('git', ['status', '--porcelain'], gitOptions);
  if (status.trim()) {
    if (requireClean) throw new Error('대상 저장소에 커밋되지 않은 변경이 있습니다');
    io.warn('경고: 대상 저장소에 커밋되지 않은 변경이 있습니다');
  }
  const { stdout: hashOutput } = await io.exec('git', ['rev-parse', '--short', 'HEAD'], gitOptions);
  const commit = hashOutput.trim();
  if (!/^[0-9a-f]+$/.test(commit)) throw new Error('커밋 해시 오류');

  try {
    await io.exec('gradle', [':app:assembleDebug'], {
      cwd: project, env: { ...process.env, JAVA_HOME }, maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const tail = outputTail(error);
    throw new Error(`Android 빌드 실패${tail ? `\n${tail}` : ''}`);
  }

  const builtAt = io.now();
  const name = buildName(builtAt, commit);
  const blob = await io.readFile(join(project, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
  if (dryRun) { io.log(`dry-run: ${name} (${blob.length} bytes)`); return; }

  const token = await io.getAccessToken({ requiredScopes: DRIVE_BACKUP_SCOPES });
  const folder = await io.findOrCreateFolder({ token, appProperties: APP_PROPERTIES, folderName: FOLDER_NAME });
  const uploaded = await io.uploadBackup({ token, folderId: folder.id, name, blob,
    appProperties: APP_PROPERTIES, mimeType: APK_MIME, namePattern: APK_NAME });
  if (!uploaded.id || Number(uploaded.size) !== blob.length) throw new Error('업로드 후 원격 파일 크기 불일치');

  const files = (await io.listFiles({ token, folderId: folder.id, appProperties: APP_PROPERTIES }))
    .filter((file) => file.appProperties?.pantheon === APP_PROPERTIES.pantheon && APK_NAME.test(file.name));
  const current = { ...uploaded, name, parents: [folder.id], appProperties: APP_PROPERTIES };
  const candidates = [...files.filter((file) => file.id !== uploaded.id), current]
    .sort((a, b) => b.name.localeCompare(a.name) || (a.id === uploaded.id ? -1 : b.id === uploaded.id ? 1 : 0));
  for (const file of candidates.slice(5)) {
    await io.deleteBackup({ token, folderId: folder.id, file, appProperties: APP_PROPERTIES, namePattern: APK_NAME });
  }

  if (!noSend) {
    const builtKst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(builtAt));
    const body = [
      '• 앱: Kakao-Notification',
      `• 빌드 시각: ${builtKst} KST`,
      `• 커밋: ${commit}`,
      `• 크기: ${blob.length} bytes`,
      `• 설치 링크: https://drive.google.com/file/d/${encodeURIComponent(uploaded.id)}/view`,
      '• 첫 설치: 휴대폰에서 알 수 없는 앱 설치를 허용하세요.',
    ].join('\n');
    await io.sendAgentMessage({ agent: SENDER_AGENT, kind: '정보', topic: '앱 배포', body });
  }
  io.log(`앱 배포 완료: ${name} (${blob.length} bytes)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
