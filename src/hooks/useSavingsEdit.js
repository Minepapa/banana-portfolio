// 저축금(월별잔고!C) 직접 편집 워크플로 훅. usePortfolioEdits에서 분리 (동작 불변).
// 롱프레스 발화 시 beginSavingsEdit → 이번 달 행 값 로드 → 절대값 set 저장. 보유종목 편집의
// 델타 가산과 달리 여기선 절대값을 직접 쓴다. monthlyRowRef·setBalanceSyncMsg는 App이 소유·주입.
// 타이밍·제스처는 useLongPress가 소유(DashboardTab에서 연결).
import { useState } from "react";
import { parseNum } from '../lib/textFormat.js';

export function useSavingsEdit({ sheets, monthlyRowRef, setBalanceSyncMsg }) {
  const [showSavingsEdit, setShowSavingsEdit] = useState(false);
  const [savingsEditValue, setSavingsEditValue] = useState('');

  const beginSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
      return;
    }
    try {
      // UNFORMATTED: 표시형식(콤마 등)과 무관하게 원본 숫자를 읽는다.
      const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`, 'UNFORMATTED_VALUE');
      setSavingsEditValue(String(parseNum(rows[0]?.[0]) || ''));
    } catch {
      // 읽기 실패 시 편집창을 빈값으로 열면 저장 시 실값을 0으로 덮어쓸 수 있다 — 진입 차단.
      setBalanceSyncMsg('저축금 조회 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setShowSavingsEdit(true);
  };

  const saveSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      setShowSavingsEdit(false);
      return;
    }
    try {
      // parseNum: "1,234,000" 같은 콤마 입력도 안전(parseFloat는 콤마에서 끊겨 1이 됨).
      await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [parseNum(savingsEditValue)]);
      setBalanceSyncMsg('저축금 저장됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('저축금 저장 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
    setShowSavingsEdit(false);
  };

  return {
    showSavingsEdit, setShowSavingsEdit,
    savingsEditValue, setSavingsEditValue,
    beginSavingsEdit, saveSavingsEdit,
  };
}
