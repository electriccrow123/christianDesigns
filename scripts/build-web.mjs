// Bundles the game into a single self-contained HTML page for the hosted web version.
// Usage: node scripts/build-web.mjs  ->  dist/tradetrainer.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// module name -> source file (the web build swaps in the Robinhood data provider)
const modules = [
  ['engine', 'public/js/engine.js'],
  ['coach', 'public/js/coach.js'],
  ['charts', 'public/js/charts.js'],
  ['data', 'web/data-robinhood.js'],
  ['app', 'public/js/app.js'],
];

function wrap(name, src) {
  const exportsList = [];
  const body = src
    .replace(/^import \* as (\w+) from '\.\/(\w+)(?:-\w+)?\.js';$/gm, (_, alias, mod) => `const ${alias} = __${mod};`)
    .replace(/^import \{([^}]+)\} from '\.\/(\w+)\.js';$/gm, (_, names, mod) => `const {${names}} = __${mod};`)
    .replace(/^export (async function|function|const|let) (\w+)/gm, (_, kind, id) => {
      exportsList.push(id);
      return `${kind} ${id}`;
    });
  if (/^\s*(import|export)\b/m.test(body)) throw new Error(`Unbundled import/export left in ${name}`);
  return `const __${name} = (() => {\n${body}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

const js = modules.map(([name, file]) => wrap(name, read(file))).join('\n');
const css = read('public/css/styles.css');
const html = read('public/index.html');
const bodyHtml = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[^>]*src="js\/app\.js"[^>]*><\/script>/, '')
  .trim();

const page = `<title>TradeTrainer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
${css}
/* hosted page: one committed dark trading-desk look */
:root { color-scheme: dark; }
body { background: var(--bg); color: var(--text); }
</style>
${bodyHtml}
<script>
${js}
</script>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/tradetrainer.html'), page);
console.log(`dist/tradetrainer.html  ${(page.length / 1024).toFixed(1)} KB`);
