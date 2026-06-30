// 도움말 탭: USER-GUIDE.md 렌더. App.jsx에서 추출 (동작 불변).
import guideRaw from "../../docs/USER-GUIDE.md?raw";
import { renderMarkdown } from '../lib/markdown.jsx';
import { SectionTitle } from '../lib/primitives.jsx';

const guideBody = String(guideRaw).replace(/\r\n/g, '\n').replace(/^[\s\S]*?\n---\n/, '');

export default function HelpTab({ baseFont }) {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', fontFamily: baseFont, textAlign: 'left' }}>
      <SectionTitle sub="각 탭을 언제·어떻게 쓰나">실전 사용 가이드</SectionTitle>
      {renderMarkdown(guideBody)}
    </div>
  );
}
