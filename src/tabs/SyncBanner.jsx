// 동기화/저장 피드백 토스트(하단 고정). App.jsx에서 분리 (동작 불변).
// 메시지 내용(실패·없음·올바르게)으로 성공/실패 색상 결정. 메시지 없으면 렌더 안 함.
export default function SyncBanner({ message, baseFont }) {
  if (!message) return null;
  const isErr = message.includes('실패') || message.includes('없음') || message.includes('올바르게');
  return (
    <div style={{
      position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)",
      zIndex: 2000, maxWidth: "90%",
      padding: "12px 20px", borderRadius: 0,
      background: isErr ? "#FBE3E4" : "#DDF3E4",
      border: `1px solid ${isErr ? "#141414" : "#159E52"}`,
      color: isErr ? "#E5484D" : "#159E52",
      fontSize: 13, fontWeight: 600, fontFamily: baseFont,
      boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <span>{isErr ? "⚠️" : "✓"}</span>
      <span>{message}</span>
    </div>
  );
}
