import ts from 'typescript';

// Check C's edit vocabulary: a declared edit list replayed on the base program
// text must give the current program text exactly.
export interface Removal {
  name: string;
  // The comment above the declaration documents code that stays.
  keepComment?: boolean;
}

export interface EditList {
  removals: Removal[];
  replacements: Array<{ from: string; to: string; count: number }>;
  insertion: { after: string; text: string };
}

const TOKEN = /@@QAREN_[A-Z0-9_]+@@/g;

function declarationStatement(source: ts.SourceFile, name: string): ts.Statement {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1)
    throw new Error(`${name}: expected one declaration, found ${found.length}`);
  const node = found[0]!;
  if (ts.isFunctionDeclaration(node)) return node;
  const statement = node.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
    throw new Error(`${name}: not a single-declaration variable statement`);
  }
  return statement;
}

// The source text of named declarations, for running a base implementation.
export function declarationSource(text: string, names: string[]): string {
  const parsed = ts.createSourceFile(
    'program.js',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return names.map((name) => declarationStatement(parsed, name).getText(parsed)).join('\n');
}

// Removes whole lines: the declaration, its leading // comment unless kept,
// and one blank line directly above.
export function removeDeclarations(text: string, removals: Removal[]): string {
  const parsed = ts.createSourceFile(
    'program.js',
    text.replace(TOKEN, (token) => '0'.padEnd(token.length)),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const lines = text.split('\n');
  const removed = new Set<number>();
  for (const { name, keepComment } of removals) {
    const statement = declarationStatement(parsed, name);
    const start = parsed.getLineAndCharacterOfPosition(statement.getStart(parsed));
    const end = parsed.getLineAndCharacterOfPosition(statement.end);
    if (lines[start.line]!.slice(0, start.character).trim() !== '') {
      throw new Error(`${name}: declaration does not start its line`);
    }
    if (lines[end.line]!.slice(end.character).trim() !== '') {
      throw new Error(`${name}: declaration does not end its line`);
    }
    let first = start.line;
    if (!keepComment) while (lines[first - 1]?.trim().startsWith('//')) first--;
    if (lines[first - 1]?.trim() === '') first--;
    for (let line = first; line <= end.line; line++) {
      if (removed.has(line)) throw new Error(`${name}: overlaps another removal`);
      removed.add(line);
    }
  }
  return lines.filter((_, line) => !removed.has(line)).join('\n');
}

export function applyEdits(text: string, edits: EditList): string {
  let result = removeDeclarations(text, edits.removals);
  for (const { from, to, count } of edits.replacements) {
    const found = result.split(from).length - 1;
    if (found !== count) throw new Error(`${from}: expected ${count} occurrences, found ${found}`);
    result = result.split(from).join(to);
  }
  const { after, text: inserted } = edits.insertion;
  if (result.split(after).length !== 2) throw new Error(`Insertion anchor is not unique: ${after}`);
  return result.replace(after, () => after + inserted);
}
