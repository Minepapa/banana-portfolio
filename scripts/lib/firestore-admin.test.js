import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFirestoreAdmin } from './firestore-admin.mjs';

test('getFirestoreAdmin: 키 파일이 없으면 즉시 명확한 에러(Firestore 호출 없이)', () => {
  assert.throws(() => getFirestoreAdmin('/no/such/firebase-adminsdk-key.json'), /키 파일이 없습니다/);
});
