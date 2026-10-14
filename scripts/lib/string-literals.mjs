// JS 소스에서 문자열 리터럴(따옴표·템플릿)만 뽑는다. 주석은 건너뛴다.
// 담당 이름 리터럴 검사(agent-name-literals.test.js)가 쓴다. 정규식 리터럴은 앞 토큰으로 어림해 건너뛴다
// (나눗셈 뒤 /는 식별자·숫자·닫는 괄호 뒤에만 온다). 어림이 틀려 오탐이 나면 허용 목록에 넣는다.
export function extractStringLiterals(source) {
  const literals = [];
  let i = 0;
  let line = 1;
  const templateDepth = [];
  let prev = '';
  const push = (text, startLine) => literals.push({ text, line: startLine });
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') { line += 1; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '}' && templateDepth.length && templateDepth.at(-1) === 0) {
      templateDepth.pop();
      i = readTemplate(i + 1);
      prev = '`';
      continue;
    }
    if (templateDepth.length) {
      if (ch === '{') templateDepth[templateDepth.length - 1] += 1;
      if (ch === '}') templateDepth[templateDepth.length - 1] -= 1;
    }
    if (ch === '/' && (!/[\w$)\]"'`]/.test(prev) || /\b(?:return|typeof|case|in|of)\s*$/.test(source.slice(Math.max(0, i - 12), i)))) {
      // 정규식 리터럴 — 문자 클래스 안의 /는 끝이 아니다.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      i = j + 1;
      while (/[a-z]/.test(source[i] ?? '')) i += 1;
      prev = '/';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
        text += source[j];
        j += 1;
      }
      push(text, startLine);
      i = j + 1;
      prev = '"';
      continue;
    }
    if (ch === '`') { i = readTemplate(i + 1); prev = '`'; continue; }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return literals;

  // 템플릿 본문을 읽고 ${ 를 만나면 표현식 모드로 돌아간다(중첩 깊이 추적).
  function readTemplate(start) {
    const startLine = line;
    let j = start;
    let text = '';
    while (j < source.length) {
      const c = source[j];
      if (c === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
      if (c === '`') { push(text, startLine); return j + 1; }
      if (c === '$' && source[j + 1] === '{') {
        push(text, startLine);
        templateDepth.push(0);
        return j + 2;
      }
      if (c === '\n') line += 1;
      text += c;
      j += 1;
    }
    push(text, startLine);
    return j;
  }
}
