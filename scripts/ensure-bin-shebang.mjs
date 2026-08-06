import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mainJsPath = path.join(process.cwd(), 'dist', 'main.js');
const mainJsBody = readFileSync(mainJsPath, 'utf8');
const shebang = '#!/usr/bin/env node\n';
if (!mainJsBody.startsWith('#!')) {
  writeFileSync(mainJsPath, shebang + mainJsBody, 'utf8');
}
