#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { getAccessToken, CALENDAR_WRITE_SCOPES } from '../lib/google-oauth.mjs';
import { deleteOwnEvent } from '../lib/google-calendar.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !/^--id=.+$/.test(argv[0])) throw new Error('--id=<일정 ID> 필요');
  await deleteOwnEvent(argv[0].slice(5), { token: await getAccessToken({ requiredScopes: CALENDAR_WRITE_SCOPES }) });
  console.log('삭제함');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
