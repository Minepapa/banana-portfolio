// 안드로이드 알림 수집 앱의 spendingInbox 원문을 읽고, Vault 기록이 확인된 문서만 지운다.
// db를 주입받아 실제 Firestore 없이도 수집 잡을 검증할 수 있다.
export async function readSpendingInbox(db) {
  const snapshot = await db.collection('spendingInbox').get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ts: String(data.ts ?? ''),
      source: String(data.source ?? ''),
      packageName: String(data.packageName ?? ''),
      appLabel: String(data.appLabel ?? ''),
      sender: String(data.sender ?? ''),
      body: String(data.body ?? ''),
      postedAt: data.postedAt ?? null,
    };
  });
}

// 하루 수십 건 규모이므로 kakao-inbox와 같이 순차 삭제한다.
export async function deleteSpendingInboxDocs(db, ids) {
  for (const id of ids || []) {
    await db.collection('spendingInbox').doc(id).delete();
  }
}
