/* Behaviour suite runner.
 *
 *   npm run test:e2e                 build if needed, run every case
 *   npm run test:e2e -- --only B-07  run one case (or a prefix group)
 *   npm run test:e2e -- --report     also write docs/acceptance/report.md
 *
 * Cases live in tests/e2e/cases/*.mjs, one file per behaviour area, each exporting
 * `cases: [{ id, name, run(t, ctx) }]`. The id is the line in the acceptance checklist
 * the case proves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, createReporter, launch, openApp, serveDist } from './harness.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const wantReport = args.includes('--report');

if (!fs.existsSync(path.join(ROOT, 'dist/index.html')) || args.includes('--build')) {
  console.log('› building…');
  const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const caseDir = path.join(ROOT, 'tests/e2e/cases');
const files = fs.readdirSync(caseDir).filter((f) => f.endsWith('.mjs')).sort();
const all = [];
for (const f of files) {
  const mod = await import(path.join(caseDir, f));
  for (const c of mod.cases) all.push({ ...c, file: f });
}
const selected = only ? all.filter((c) => c.id.startsWith(only)) : all;

const { server, port } = await serveDist();
const browser = await launch();
browser.__base = `http://127.0.0.1:${port}`;
const t = createReporter();

console.log(`› ${selected.length} behaviour cases\n`);
let lastFile = '';
for (const c of selected) {
  if (c.file !== lastFile) {
    lastFile = c.file;
    console.log(`  ${c.file.replace(/\.mjs$/, '')}`);
  }
  t.start(c);
  const pages = [];
  const ctx = {
    browser,
    async open(opts) {
      const page = await openApp(browser, opts);
      pages.push(page);
      return page;
    },
  };
  try {
    await c.run(t, ctx);
  } catch (err) {
    t.fail(err);
  }
  for (const p of pages) await p.close().catch(() => {});
  const r = t.results[t.results.length - 1];
  console.log(`   ${r.ok ? '✓' : '✗'} ${c.id}  ${c.name}`);
  for (const ch of r.checks) if (!ch.ok) console.log(`       ✗ ${ch.name}  ${ch.detail}`);
  if (r.error) console.log(`       ! ${r.error}`);
}

await browser.close();
server.close();

const failed = t.results.filter((r) => !r.ok);
const checks = t.results.reduce((n, r) => n + r.checks.length, 0);
console.log(`\n› ${t.results.length - failed.length}/${t.results.length} cases, ${checks} assertions, ${failed.length} failed`);

if (wantReport) {
  const lines = [
    '# Behaviour Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| ID | Behaviour | Result | Assertions |',
    '| --- | --- | --- | --- |',
    ...t.results.map((r) => `| ${r.id} | ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.checks.length} |`),
    '',
    `Total: ${t.results.length - failed.length}/${t.results.length} passed, ${checks} assertions.`,
    '',
    'Manual acceptance items are the ones listed as manual checks in [behavior-checklist.md](./behavior-checklist.md).',
    '',
  ];
  fs.mkdirSync(path.join(ROOT, 'docs/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/acceptance/report.md'), lines.join('\n'));
  console.log('› docs/acceptance/report.md written');
}

process.exit(failed.length ? 1 : 0);
