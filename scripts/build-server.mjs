import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'dist-server');

const commonOptions = {
  absWorkingDir: projectRoot,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
};

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

await Promise.all([
  build({
    ...commonOptions,
    entryPoints: ['server/index.ts'],
    outfile: path.join(outDir, 'index.mjs'),
  }),
  build({
    ...commonOptions,
    entryPoints: ['server/scripts/migrate.ts'],
    outfile: path.join(outDir, 'migrate.mjs'),
  }),
]);

await fs.cp(
  path.join(projectRoot, 'server/db/migrations'),
  path.join(outDir, 'migrations'),
  { recursive: true },
);
