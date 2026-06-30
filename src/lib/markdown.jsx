// 도움말(USER-GUIDE.md)용 경량 마크다운 렌더러. App.jsx에서 추출 (동작 불변).
// 가이드에서 실제 쓰는 문법만 처리(헤더·표·리스트·인용·hr·볼드/이탤릭/코드/링크).
import { stripEmoji, breakUnits } from './textFormat.js';

function mdInline(text) {
  text = stripEmoji(text);
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++} style={{ color: '#141414', fontWeight: 700 }}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k++} style={{ color: '#6B675C', fontStyle: 'italic' }}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={k++} style={{ background: '#EAE6DA', color: '#141414', padding: '1px 5px', borderRadius: 0, fontSize: '0.92em', fontFamily: 'ui-monospace, Menlo, monospace' }}>{m[3]}</code>);
    else out.push(<a key={k++} href={m[5]} style={{ color: '#141414', textDecoration: 'none' }}>{m[4]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const blocks = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    // hr
    if (/^---+$/.test(line.trim())) { blocks.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid #141414', margin: '22px 0' }} />); i++; continue; }
    // 헤더
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const content = mdInline(h[2]);
      if (h[1].length === 1) blocks.push(<h1 key={key++} style={{ fontSize: 18, fontWeight: 800, color: '#141414', margin: '4px 0 14px' }}>{content}</h1>);
      else if (h[1].length === 2) blocks.push(<h2 key={key++} style={{ fontSize: 15, fontWeight: 700, color: '#141414', margin: '24px 0 10px' }}>{content}</h2>);
      else blocks.push(<h3 key={key++} style={{ fontSize: 13, fontWeight: 700, color: '#141414', margin: '18px 0 8px' }}>{content}</h3>);
      i++; continue;
    }
    // 인용
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(<blockquote key={key++} style={{ borderLeft: '3px solid #141414', background: '#EAE6DA', padding: '8px 12px', margin: '12px 0', color: '#6B675C', fontSize: 12, lineHeight: 1.6, borderRadius: 0 }}>{quote.map((q, qi) => <div key={qi}>{mdInline(q)}</div>)}</blockquote>);
      continue;
    }
    // 표
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      blocks.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '12px 0' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
            <thead><tr>{header.map((c, ci) => <th key={ci} style={{ textAlign: 'left', padding: '7px 9px', background: '#EAE6DA', color: '#6B675C', borderBottom: '1px solid #141414', fontWeight: 700, whiteSpace: 'nowrap' }}>{mdInline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ padding: '7px 9px', color: '#141414', borderBottom: '1px solid #141414', verticalAlign: 'top', lineHeight: 1.5 }}>{breakUnits(c).map((ln, li) => <div key={li}>{mdInline(ln)}</div>)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    // 순서 없는 리스트
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const indent = lines[i].match(/^(\s*)/)[1].length;
        items.push({ indent, text: lines[i].replace(/^\s*[-*]\s+/, '') });
        i++;
      }
      blocks.push(<ul key={key++} style={{ margin: '8px 0', paddingLeft: 18, color: '#141414', fontSize: 12, lineHeight: 1.7 }}>{items.map((it, ii) => <li key={ii} style={{ marginLeft: it.indent >= 2 ? 16 : 0 }}>{mdInline(it.text)}</li>)}</ul>);
      continue;
    }
    // 순서 있는 리스트
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(<ol key={key++} style={{ margin: '8px 0', paddingLeft: 22, color: '#141414', fontSize: 12, lineHeight: 1.7 }}>{items.map((it, ii) => <li key={ii}>{mdInline(it)}</li>)}</ol>);
      continue;
    }
    // 문단
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|>\s?|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]) && !lines[i].trim().startsWith('|')) {
      para.push(lines[i]); i++;
    }
    blocks.push(<p key={key++} style={{ margin: '8px 0', color: '#141414', fontSize: 12, lineHeight: 1.7 }}>{para.map((pl, pi) => <span key={pi}>{pi > 0 && <br />}{mdInline(pl)}</span>)}</p>);
  }
  return blocks;
}
