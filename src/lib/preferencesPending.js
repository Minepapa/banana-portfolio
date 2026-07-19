// 성향관찰 '대기' 필터 — PreferenceTab.jsx·TodayTab.jsx에 중복돼 있던 로직을 추출(동작 불변).
// 판테온탭 Apollo 카드도 이 함수를 재사용해 3번째 중복을 만들지 않는다.
export function pendingPreferences(list) {
  return (list || []).filter(p => p.status === '관찰' || p.status === '승격후보');
}
