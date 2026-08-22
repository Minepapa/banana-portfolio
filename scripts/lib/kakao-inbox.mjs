// Firestore kakaoInbox 컬렉션 — 안드로이드 Kakao-Notification 앱이 카카오톡 알림
// 원문을 직접 쓰는 곳. 2026-08-22 — 구글시트 "알람" 탭 릴레이(ADR 0005)를 대체
// (ADR 0014). 이 모듈은 db(firebase-admin Firestore 인스턴스)를 주입받는 얇은
// I/O 래퍼 — 순수 파싱(notification-parsers.mjs)과 분리해 호출부가 스텁 db로
// 테스트할 수 있게 한다.
//
// 문서 모양: { ts: "YYYY-MM-DD HH:mm:ss"(KST, 안드로이드 앱이 채움), sender, body,
// createdAt(Firestore serverTimestamp) }. 파서(notification-parsers.mjs)는 ts·body
// 두 필드만 쓴다 — "알람" 시트 A(시간)·D(내용) 두 열만 쓰던 것과 동일 범위.
//
// ⚠️ 구글시트와의 차이(정리 정책) — 시트는 처리된 행을 정리 안 해도 비용이 없어서
// (ADR 0005 "구현 시 결정"으로 미룸) parse-notifications-to-vault.mjs가 지금까지
// 안 지웠다. Firestore는 읽기(get)가 문서 수만큼 과금되므로, 정리를 안 하면 이
// 잡이 돌 때마다 이미 처리한 문서까지 매번 다시 읽어 비용이 무한히 늘어난다 —
// 그래서 호출부(parse-notifications-to-vault.mjs)가 **실제로 처리한**(Vault에
// 기록했거나, 이미 기록돼 중복스킵했거나, 퀀트계좌라 의도적으로 제외한) 문서만
// 골라 deleteKakaoInboxDocs로 지운다. Vault Facts/Ledger 쪽 dedup(파일명 기준)은
// 그대로 살아있으니 혹시 삭제 전에 중복 도착해도 안전하다.
// ⚠️ 코드리뷰 지적(2026-08-22, 커밋 전) — 처음엔 훑은 문서를 결과와 무관하게 전부
// 지웠는데, 그러면 "어느 파서도 못 알아본 알림"이 Vault에 흔적 없이 원문째로 영구
// 삭제되는 데이터 유실 회귀였다(시트 시절엔 없던 문제, "출처 추적성이 가용성보다
// 우선" 원칙과 충돌). 미인식·빈 본문 문서는 지우지 않고 컬렉션에 남겨 재확인 가능하게
// 한다 — 안드로이드 필터 규칙을 이미 거친 소량이라 방치 비용도 작다.
export async function readKakaoInbox(db) {
  const snap = await db.collection('kakaoInbox').get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    ts: String(doc.data().ts ?? ''),
    body: String(doc.data().body ?? ''),
  }));
}

// ids: readKakaoInbox()가 반환한 문서 id 배열. 개인 규모(하루 수십 건) 전제로 배치
// 없이 순차 삭제 — Firestore batch 500건 한도를 걱정할 볼륨이 아니다.
export async function deleteKakaoInboxDocs(db, ids) {
  for (const id of ids || []) {
    await db.collection('kakaoInbox').doc(id).delete();
  }
}
