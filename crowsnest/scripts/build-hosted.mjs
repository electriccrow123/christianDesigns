// Bundles Crow's Nest into one self-contained page for claude.ai.
// Usage: node scripts/build-hosted.mjs  ->  dist/crowsnest.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Dependency order: each module only imports from modules above it.
const FILES = [
  'core/util.js',
  'core/market-clock.js',
  'core/indicators.js',
  'core/patterns.js',
  'core/regime.js',
  'core/options.js',
  'core/modes.js',
  'core/risk.js',
  'core/planner.js',
  'core/paper.js',
  'core/agents.js',
  'core/academy.js',
  'core/desk.js',
  'adapters/robinhood-map.js',
  'adapters/hosted.js',
  'adapters/local.js',
  'web/charts.js',
  'web/app.js',
];

const modName = (path) => '__' + basename(path, '.js').replace(/[^A-Za-z0-9]/g, '_');

function wrap(file) {
  const exportsList = [];
  let body = read(file)
    // import { a, b as c } from './x.js'  ->  const { a, b: c } = __x;
    .replace(/^import\s*\{([^}]+)\}\s*from\s*'([^']+)';$/gm, (_, names, from) => `const {${names.replace(/\s+as\s+/g, ': ')}} = ${modName(from)};`)
    // import * as x from './x.js'
    .replace(/^import\s*\*\s*as\s+(\w+)\s+from\s*'([^']+)';$/gm, (_, alias, from) => `const ${alias} = ${modName(from)};`)
    // export function / const / class
    .replace(/^export (async function|function|const|let|class) (\w+)/gm, (_, kind, id) => {
      exportsList.push(id);
      return `${kind} ${id}`;
    })
    // export { a, b };
    .replace(/^export\s*\{([^}]+)\};?$/gm, (_, names) => {
      exportsList.push(...names.split(',').map((n) => n.trim()).filter(Boolean));
      return '';
    });
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`Unbundled import/export left in ${file}`);
  return `const ${modName(file)} = (() => {\n${body}\nreturn { ${[...new Set(exportsList)].join(', ')} };\n})();\n`;
}

const js = FILES.map(wrap).join('\n');
const css = read('web/styles.css');
const html = read('web/index.html');
const bodyHtml = html.slice(html.indexOf('<!--BODY-->') + 11, html.indexOf('<!--/BODY-->')).trim();
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];

const page = `<title>Crow's Nest</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
${fonts}
<style>
${css}
</style>
${bodyHtml}
<script>
(() => {
${js}
})();
</script>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/crowsnest.html'), page);
console.log(`dist/crowsnest.html  ${(page.length / 1024).toFixed(1)} KB`);
