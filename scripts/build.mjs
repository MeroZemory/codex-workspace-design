import { build } from 'esbuild';
import fs from 'node:fs/promises';
await fs.mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/renderer/app.js'], bundle: true, outfile: 'dist/app.js', platform: 'browser', target: 'chrome140', format: 'iife', minify: false, sourcemap: true });
await fs.copyFile('src/renderer/index.html', 'dist/index.html');
