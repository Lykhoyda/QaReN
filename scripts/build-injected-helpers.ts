import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoot = 'packages/qaren-core/src/';
const bundlePath = join(repositoryRoot, sourceRoot, 'injected-helpers.bundle.ts');
const programPath = join(repositoryRoot, sourceRoot, 'runtime/legacy.program.txt');

// The typed fragment stands alone on this line; `var __rt;` precedes it and
// one alias line per runtime export follows it.
export const RUNTIME_MARKER = '@@QAREN_RUNTIME@@';
const RUNTIME_DECLARATION = '  var __rt;';
const ALIAS_LINE = /^  var ([A-Za-z_$][\w$]*) = __rt\.([A-Za-z_$][\w$]*);$/;

// These are interpolation sites, not replacements of evaluated numbers.
export const INTERPOLATIONS = [
  { token: '@@QAREN_HELPERS_VERSION@@', expression: 'HELPERS_VERSION', count: 1 },
  {
    token: '@@QAREN_MAX_CONTENT_CHARS@@',
    expression: 'TYPOGRAPHY_TEXT_LIMITS.maxContentChars',
    count: 1,
  },
  {
    token: '@@QAREN_MAX_TOTAL_CHARS@@',
    expression: 'TYPOGRAPHY_TEXT_LIMITS.maxTotalChars',
    count: 1,
  },
  { token: '@@QAREN_MAX_HOSTS@@', expression: 'PRIVATE_INPUT_LIMITS.maxHosts', count: 3 },
] as const;

// es2015, unminified, settings from tsconfig.runtime.json, so no strict directive.
export function buildRuntimeFragment(): string {
  const { outputFiles } = buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: [sourceRoot + 'runtime/index.ts'],
    tsconfig: 'packages/qaren-core/tsconfig.runtime.json',
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2015',
    minify: false,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  return outputFiles[0]!.text
    .trimEnd()
    .split('\n')
    .map((line) => (line ? '  ' + line : line))
    .join('\n');
}

const BUNDLER_HELPER = /^__(?!rt$)/;

// Check F: the fragment is one plain ES2015 script statement.
export function assertFragmentSyntax(fragment: string): void {
  try {
    new vm.Script(fragment);
  } catch (error) {
    throw new Error(`Runtime fragment does not parse: ${(error as Error).message}`);
  }
  if (/@@QAREN_[A-Z0-9_]+@@/.test(fragment)) throw new Error('Runtime fragment holds a token');
  const source = ts.createSourceFile(
    'fragment.js',
    fragment,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.statements.length !== 1 || !ts.isExpressionStatement(source.statements[0]!)) {
    throw new Error('Runtime fragment must be one expression statement');
  }
  const refuse = (what: string): never => {
    throw new Error(`Runtime fragment uses ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) refuse('a class');
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      refuse('a module declaration');
    }
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) refuse('await or yield');
    if (ts.isFunctionLike(node)) {
      if ((node as ts.FunctionLikeDeclarationBase).asteriskToken) refuse('a generator');
      if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async)
        refuse('async');
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) refuse('import()');
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') refuse('require');
    }
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)) {
      refuse(`a directive "${node.expression.text}"`);
    }
    if (ts.isIdentifier(node) && BUNDLER_HELPER.test(node.text))
      refuse(`bundler helper ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function declarationCounts(program: string): Map<string, number> {
  const parsed = ts.createSourceFile(
    'program.js',
    program
      .split(RUNTIME_MARKER)
      .join('')
      .replace(/@@QAREN_[A-Z0-9_]+@@/g, '0'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      counts.set(node.name.text, (counts.get(node.name.text) ?? 0) + 1);
    }
    // A write outside the declaration would reach legacy callers but not the typed modules.
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      counts.set(node.left.text, (counts.get(node.left.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return counts;
}

// The alias block must bind exactly the fragment's exports, and no other
// declaration of an alias name may remain in the program text.
export function assertRuntimeAliases(program: string, fragment: string): string[] {
  const lines = program.split('\n');
  const at = lines.indexOf(RUNTIME_MARKER);
  if (program.split(RUNTIME_MARKER).length !== 2 || at < 0) {
    throw new Error(`${RUNTIME_MARKER}: expected one marker on its own line`);
  }
  if (lines[at - 1] !== RUNTIME_DECLARATION) {
    throw new Error(`${RUNTIME_MARKER}: must follow "${RUNTIME_DECLARATION.trim()}"`);
  }
  const aliases: string[] = [];
  for (let index = at + 1; index < lines.length; index++) {
    const alias = ALIAS_LINE.exec(lines[index]!);
    if (!alias) break;
    if (alias[1] !== alias[2]) throw new Error(`Alias ${alias[1]} binds __rt.${alias[2]}`);
    aliases.push(alias[1]!);
  }
  if (aliases.length === 0) throw new Error(`${RUNTIME_MARKER}: no alias block follows the marker`);
  const context: { __rt?: object } = {};
  vm.runInNewContext(fragment, context, { timeout: 1000 });
  const exported = context.__rt ? Object.keys(context.__rt) : [];
  for (const name of aliases) {
    if (!exported.includes(name))
      throw new Error(`Alias ${name} is missing from the runtime fragment`);
  }
  for (const name of exported) {
    if (!aliases.includes(name)) throw new Error(`Runtime export ${name} has no alias`);
  }
  const counts = declarationCounts(program);
  for (const name of [...aliases, '__rt']) {
    if (counts.get(name) !== 1)
      throw new Error(`${name} is still declared or assigned in the program text`);
  }
  return aliases;
}

export function generateBundle(program: string, fragment: string): string {
  assertFragmentSyntax(fragment);
  assertRuntimeAliases(program, fragment);
  program = program.replace(RUNTIME_MARKER, () => fragment);
  const tokens = new Map<string, string>(
    INTERPOLATIONS.map(({ token, expression, count }) => {
      const actual = program.split(token).length - 1;
      if (actual !== count) throw new Error(`${token}: expected ${count} sites, found ${actual}`);
      return [token, expression];
    }),
  );
  const escape = (text: string): string =>
    text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  let template = '';
  let offset = 0;
  for (const match of program.matchAll(/@@QAREN_[A-Z0-9_]+@@/g)) {
    const expression = tokens.get(match[0]);
    if (!expression) throw new Error(`Unknown interpolation token: ${match[0]}`);
    template += escape(program.slice(offset, match.index)) + '${' + expression + '}';
    offset = match.index + match[0].length;
  }
  template += escape(program.slice(offset));
  return (
    '// Generated by scripts/build-injected-helpers.ts; do not edit.\n' +
    "import { HELPERS_VERSION } from './runtime/version.js';\n" +
    "import { PRIVATE_INPUT_LIMITS } from './qa/private-input-limits.js';\n" +
    "import { TYPOGRAPHY_TEXT_LIMITS } from './qa/host-typography.js';\n\n" +
    'export const INJECTED_HELPERS = `' +
    template +
    '`;\n'
  );
}

export interface EvaluatedHelpers {
  version: number;
  program: string;
}

// Every transitive import comes from the same source snapshot. There is no
// fallback to dist or the working tree when a historical module is missing.
export function evaluateHelpers(
  revision?: string,
  root: string = repositoryRoot,
): EvaluatedHelpers {
  const cache = new Map<string, Record<string, unknown>>();
  function load(file: string): Record<string, unknown> {
    if (!file.startsWith(sourceRoot) || !file.endsWith('.ts')) {
      throw new Error(`Helper import outside core TypeScript sources: ${file}`);
    }
    const cached = cache.get(file);
    if (cached) return cached;
    const source = revision
      ? execFileSync('git', ['show', `${revision}:${file}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : readFileSync(join(root, file), 'utf8');
    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    cache.set(file, exports);
    vm.runInNewContext(
      output,
      {
        exports,
        require(specifier: string) {
          if (!specifier.startsWith('.')) {
            throw new Error(`Nonrelative helper import: ${specifier}`);
          }
          return load(posix.join(posix.dirname(file), specifier.replace(/\.js$/, '.ts')));
        },
      },
      { filename: file, timeout: 5000 },
    );
    return exports;
  }
  const exports = load(sourceRoot + 'injected-helpers.ts');
  if (
    typeof exports.INJECTED_HELPERS !== 'string' ||
    typeof exports.HELPERS_VERSION !== 'number' ||
    !Number.isSafeInteger(exports.HELPERS_VERSION)
  ) {
    throw new Error('Helper snapshot must export a program string and integer HELPERS_VERSION');
  }
  return { program: exports.INJECTED_HELPERS, version: exports.HELPERS_VERSION };
}

export function assertVersionGate(base: EvaluatedHelpers, current: EvaluatedHelpers): void {
  if (base.program === current.program) {
    if (base.version !== current.version) {
      throw new Error('Identical helper bytes require the same HELPERS_VERSION');
    }
  } else if (current.version <= base.version) {
    throw new Error('Changed helper bytes require a higher HELPERS_VERSION');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let check = false;
  let baseRef: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') check = true;
    else if (args[index] === '--base-ref' && args[index + 1]) baseRef = args[++index];
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  const fragment = buildRuntimeFragment();
  const generated = generateBundle(readFileSync(programPath, 'utf8'), fragment);
  console.log(`Runtime fragment: ${Buffer.byteLength(fragment)} bytes (check F)`);
  if (check) {
    if (readFileSync(bundlePath, 'utf8') !== generated) {
      throw new Error('Stale injected helper bundle; run node scripts/build-injected-helpers.ts');
    }
    console.log('Injected helper bundle is current (check B)');
  } else {
    writeFileSync(bundlePath, generated);
  }
  if (baseRef) {
    // Resolve the ref once so all source reads are bound to one immutable commit.
    const revision = execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    assertVersionGate(evaluateHelpers(revision), evaluateHelpers());
    console.log(`Helper version gate passed against ${revision} (check K)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
