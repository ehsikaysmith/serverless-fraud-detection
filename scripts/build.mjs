// Bundles each function in functions/<name>/index.ts into build/<name>/index.mjs for Lambda (Node.js 22).
// The AWS SDK is bundled too, so the deployed code uses exactly the versions in package-lock.json.
import { build } from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';

rmSync('build', { recursive: true, force: true });
const functions = existsSync('functions')
  ? readdirSync('functions', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
for (const fn of functions) {
  await build({
    entryPoints: [`functions/${fn}/index.ts`],
    outfile: `build/${fn}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: true,
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    logLevel: 'info',
  });
}
console.log(`Built ${functions.length} function(s) into build/`);
