// Independent oracle for the fingerprint scanner's code mask (fingerprint.rs,
// test s8): for each file listed in argv[2], one per line, prints the UTF-8
// byte ranges TypeScript's parser reads as comments, string content or
// template text. A file with parse errors gets no ranges, so any byte the
// walk masks in it fails the test.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const scriptKind = (path: string): ts.ScriptKind => {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
};

const notCode = (path: string): { parsed: boolean; ranges: [number, number][] } => {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  if ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) {
    return { parsed: false, ranges: [] };
  }
  const ranges: [number, number][] = [];
  const comment = (pos: number, end: number): void => {
    ranges.push([pos, end]);
  };
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(file);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    // Comments before a token's first line break are the previous token's trailing ones.
    ts.forEachTrailingCommentRange(text, node.pos, comment);
    ts.forEachLeadingCommentRange(text, node.pos, comment);
    const start = node.getStart(file);
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateTail:
        ranges.push([start + 1, node.end - 1]);
        break;
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
        ranges.push([start + 1, node.end - 2]);
        break;
    }
  };
  visit(file);
  const byteAt: number[] = [];
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    byteAt.push(bytes);
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00) bytes += 4;
    else if (unit < 0xdc00 || unit >= 0xe000) bytes += 3;
  }
  byteAt.push(bytes);
  return { parsed: true, ranges: ranges.map(([pos, end]) => [byteAt[pos], byteAt[end]]) };
};

const paths = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
process.stdout.write(JSON.stringify(paths.map(notCode)));
