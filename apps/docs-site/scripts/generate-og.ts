import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/og-image.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#0c1015"/>
  <g fill="none" stroke="#252e37" stroke-width="1">
    ${Array.from({ length: 22 }, (_, i) => `<line x1="${i * 56}" y1="0" x2="${i * 56}" y2="630"/>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 56}" x2="1200" y2="${i * 56}"/>`).join('')}
  </g>
  <rect width="1200" height="630" fill="url(#fade)"/>
  <defs>
    <radialGradient id="fade" cx="0.5" cy="0.4" r="0.9">
      <stop offset="0" stop-color="#0c1015" stop-opacity="0"/>
      <stop offset="1" stop-color="#0c1015" stop-opacity="0.92"/>
    </radialGradient>
  </defs>
  <text x="80" y="200" font-family="Menlo, monospace" font-size="30" fill="#38bdf8">QaReN</text>
  <text x="80" y="290" font-family="Helvetica, Arial, sans-serif" font-size="58" font-weight="700" fill="#e8edf2">A QA engineer for</text>
  <text x="80" y="360" font-family="Helvetica, Arial, sans-serif" font-size="58" font-weight="700" fill="#38bdf8">your coding agent.</text>
  <text x="80" y="440" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#8e99a4">For Claude Code and Codex: tries your React Native change on an iOS simulator.</text>
  <text x="80" y="540" font-family="Menlo, monospace" font-size="22" fill="#4ade80">✓ PASS · report.md · ledger.json · block saved</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out}`);
