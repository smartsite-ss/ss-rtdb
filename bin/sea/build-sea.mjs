// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com

/**
 * Build a single-file Windows executable (`rtdb-server.exe`) with Node's SEA
 * (single executable application) support.
 *
 * Pipeline:
 *   1. esbuild bundles `packages/server/src/main.ts` (and its relative imports of the other
 *      packages' TypeScript sources) into one CommonJS file - no third-party runtime deps.
 *   2. `server.ts` resolves the bundled web console through `import.meta.url`, which does not
 *      exist inside a SEA snapshot. The reference is rewritten at bundle time and satisfied by a
 *      banner that computes `<exe dir>/admin/dist`, so the console stays an external directory.
 *   3. `node --experimental-sea-config` produces the blob, `postject` injects it into a copy of
 *      `node.exe`, and the web console build is copied next to the executable.
 *
 * Output layout (release/sea/):
 *   rtdb-server.exe          single executable (Node runtime + engine + HTTP server)
 *   admin/dist/              web console served at /admin/
 *   rtdb-data/               created on first run (data root; override with RTDB_DATA_DIR)
 *
 * Run through `bin\build-sea.bat`, which checks the toolchain and builds the admin console first.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const srcDir = join(root, 'src');
const outDir = join(root, 'release', 'sea');
const buildDir = join(outDir, '.build');
const toolsDir = join(root, 'bin', '.sea-tools');

/** Node.js fuse sentinel required by postject. */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (message) => console.log(`[INFO] ${message}`);
const fail = (message) => {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  fail(`Node.js ${process.versions.node} is too old; this script requires Node.js 24 or newer.`);
}
if (!existsSync(join(srcDir, 'packages', 'server', 'src', 'main.ts'))) {
  fail('src/packages/server/src/main.ts not found - run this script from the repository.');
}

// ---------------------------------------------------------------- esbuild (from the workspace)
const requireFromSrc = createRequire(join(srcDir, 'package.json'));
let esbuild;
try {
  esbuild = requireFromSrc('esbuild');
} catch {
  fail('esbuild was not found in src/node_modules. Run `npm install` inside src/ first.');
}

// ---------------------------------------------------------------- postject (build-only helper)
const postjectCli = join(toolsDir, 'node_modules', 'postject', 'dist', 'cli.js');
if (!existsSync(postjectCli)) {
  step('installing postject into bin/.sea-tools (build-only, not tracked by git) ...');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(
    join(toolsDir, 'package.json'),
    `${JSON.stringify({ name: 'ss-rtdb-sea-tools', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
  // Prefer the npm CLI entry next to the running node.exe (no shell, no deprecation warning);
  // fall back to the `npm` shim for Volta / nvm / Corepack installations.
  const npmArgs = ['install', '--no-audit', '--no-fund', '--no-save', 'postject'];
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: toolsDir, stdio: 'inherit' });
  } else {
    // `shell: true` is required on Windows: Node >= 20 refuses to spawn `.cmd` shims directly.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
      cwd: toolsDir,
      stdio: 'inherit',
      shell: true,
    });
  }
  if (!existsSync(postjectCli)) fail('postject installation failed.');
}

// ---------------------------------------------------------------- bundle
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

/**
 * `<exe dir>/admin/dist` is what `new URL('../../admin/dist/', selfUrl)` resolves to when the
 * synthetic module URL points at `<exe dir>/server/src/server.ts`.
 */
const selfUrlExpression =
  'require("node:url").pathToFileURL(require("node:path").join(' +
  'require("node:path").dirname(process.execPath), "server", "src", "server.ts")).href';

const rewriteSelfUrl = {
  name: 'rewrite-import-meta-url',
  setup(build) {
    build.onLoad({ filter: /server\.ts$/ }, (args) => {
      const text = readFileSync(args.path, 'utf8');
      if (!text.includes('import.meta.url')) return undefined;
      return {
        contents: text.split('import.meta.url').join('globalThis.__SS_RTDB_SELF_URL__'),
        loader: 'ts',
      };
    });
  },
};

const bundlePath = join(buildDir, 'server.cjs');
step('bundling the server (esbuild, CommonJS, node builtins external) ...');
await esbuild.build({
  entryPoints: [join(srcDir, 'packages', 'server', 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: bundlePath,
  external: ['node:*'],
  logLevel: 'warning',
  banner: { js: `globalThis.__SS_RTDB_SELF_URL__ = ${selfUrlExpression};` },
  plugins: [rewriteSelfUrl],
});

// ---------------------------------------------------------------- SEA blob
writeFileSync(
  join(buildDir, 'sea-config.json'),
  `${JSON.stringify({
    main: 'server.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  }, null, 2)}\n`,
);

const blobPath = join(buildDir, 'sea-prep.blob');
step('generating the SEA blob ...');
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: buildDir,
  stdio: 'inherit',
});
if (!existsSync(blobPath)) fail('the SEA blob was not generated.');

// ---------------------------------------------------------------- inject
const exePath = join(outDir, 'rtdb-server.exe');
step('injecting the blob into a copy of node.exe (postject) ...');
copyFileSync(process.execPath, exePath);
execFileSync(process.execPath, [
  postjectCli,
  exePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  SEA_FUSE,
], { stdio: 'inherit' });

// ---------------------------------------------------------------- external assets
const adminDist = join(srcDir, 'packages', 'admin', 'dist');
if (existsSync(adminDist)) {
  const adminTarget = join(outDir, 'admin', 'dist');
  rmSync(join(outDir, 'admin'), { recursive: true, force: true });
  cpSync(adminDist, adminTarget, { recursive: true });
  step(`web console copied to ${relative(root, adminTarget).replaceAll('\\', '/')}`);
} else {
  console.warn('[WARN] packages/admin/dist is missing - build it with `npm run build --workspace @ss/rtdb-admin`.');
  console.warn('[WARN] the executable will still run, but /admin/ returns 404.');
}

// ---------------------------------------------------------------- summary
const sizeMb = (statSync(exePath).size / (1024 * 1024)).toFixed(1);
console.log('');
console.log(`[OK] single executable ready: ${relative(root, exePath).replaceAll('\\', '/')} (${sizeMb} MB)`);
console.log('[OK]   run      : rtdb-server.exe');
console.log('[OK]   data dir : .\\rtdb-data (next to the executable; override with RTDB_DATA_DIR)');
console.log('[OK]   console  : http://127.0.0.1:6180/admin/');
console.log('[OK]   notes    : the data directory and admin/ stay external by design;');
console.log('[OK]              build intermediates are kept in release/sea/.build for troubleshooting.');
