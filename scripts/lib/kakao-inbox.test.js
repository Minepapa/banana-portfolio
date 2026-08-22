import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readKakaoInbox, deleteKakaoInboxDocs } from './kakao-inbox.mjs';

// firebase-admin Firestore를 흉내내는 최소 스텁 — .collection(name).get()/.doc(id).delete().
function fakeDb(docs) {
  const deleted = [];
  return {
    deleted,
    collection(name) {
      assert.equal(name, 'kakaoInbox');
      return {
        async get() {
          return { docs: docs.map((d) => ({ id: d.id, data: () => d })) };
        },
        doc(id) {
          return { async delete() { deleted.push(id); } };
        },
      };
    },
  };
}

test('readKakaoInbox: 문서를 {id, ts, body}로 변환', async () => {
  const db = fakeDb([
    { id: 'a1', ts: '2026-08-22 09:00:00', body: '체결통보...', sender: 'NH투자증권' },
    { id: 'a2', ts: '2026-08-22 09:05:00', body: '배당금 입금...' },
  ]);
  const rows = await readKakaoInbox(db);
  assert.deepEqual(rows, [
    { id: 'a1', ts: '2026-08-22 09:00:00', body: '체결통보...' },
    { id: 'a2', ts: '2026-08-22 09:05:00', body: '배당금 입금...' },
  ]);
});

test('readKakaoInbox: ts·body 결측은 빈 문자열로(추정 없이 정직하게)', async () => {
  const db = fakeDb([{ id: 'a1' }]);
  const rows = await readKakaoInbox(db);
  assert.deepEqual(rows, [{ id: 'a1', ts: '', body: '' }]);
});

test('deleteKakaoInboxDocs: 넘긴 id 전부 삭제 호출', async () => {
  const db = fakeDb([]);
  await deleteKakaoInboxDocs(db, ['a1', 'a2', 'a3']);
  assert.deepEqual(db.deleted, ['a1', 'a2', 'a3']);
});

test('deleteKakaoInboxDocs: 빈 배열/undefined는 안전하게 아무 것도 안 함', async () => {
  const db = fakeDb([]);
  await deleteKakaoInboxDocs(db, []);
  await deleteKakaoInboxDocs(db, undefined);
  assert.deepEqual(db.deleted, []);
});
