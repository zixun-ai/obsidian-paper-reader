import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const result = await build({ entryPoints: ['tests/e2e/harness.ts'], bundle: true, format: 'esm', write: false,
  alias: { obsidian: './tests/obsidian-stub.ts' },
  define: { __PDF_WORKER_SOURCE__: JSON.stringify(readFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'utf8')) }
});
const assets = new Map([
  ['/harness.html', ['text/html', readFileSync('tests/e2e/harness.html')]],
  ['/harness.js', ['text/javascript', result.outputFiles[0].contents]],
  ['/main.js', ['text/javascript', readFileSync('main.js')]],
  ['/styles.css', ['text/css', readFileSync('styles.css')]],
  ['/paper.pdf', ['application/pdf', readFileSync(process.argv[2] || 'tests/fixtures/paper.pdf')]],
]);
// Deliberately serves no worker file: the published three-file install must suffice.
const server = createServer((req, res) => {
  const asset = assets.get(req.url);
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', asset[0]); res.end(asset[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['tests/e2e/accept.cjs'], { stdio: 'inherit',
  env: { ...process.env, PR_TEST_URL: `http://127.0.0.1:${server.address().port}/harness.html` } });
child.on('exit', code => { server.close(); process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error); server.close(); process.exitCode = 1; });
