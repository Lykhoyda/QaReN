import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const OUT = resolve(__dirname, '../src/content/docs/changelog.md');

const CHANGELOG_SOURCES = [
  ['Plugin', resolve(ROOT, 'packages/qaren-plugin/CHANGELOG.md')],
  ['Core', resolve(ROOT, 'packages/qaren-core/CHANGELOG.md')],
];

function packageChangelogSection(label: string, filePath: string): string {
  const body = readFileSync(filePath, 'utf8')
    .trim()
    .replace(/^# .+\n+/, '')
    .replace(/^### /gm, '#### ')
    .replace(/^## /gm, '### ');
  return `## ${label}\n\n${body}`;
}

const changelog = CHANGELOG_SOURCES.map(([label, filePath]) =>
  packageChangelogSection(label, filePath),
).join('\n\n');

writeFileSync(
  OUT,
  `---
title: "Changelog"
description: "Release history for QaReN"
---

${changelog}`,
);
console.log('generate-changelog: wrote changelog.md');
