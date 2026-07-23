// `pnpm env:docs` — генерирует ENV.md из env-схемы (env-catalog item 4).
// ENV.md — производный артефакт: руками не редактируется; тест
// src/config/env-schema.test.ts падает, если файл разошёлся со схемой.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderEnvMd } from '../src/config/env-schema.ts';

const target = fileURLToPath(new URL('../ENV.md', import.meta.url));
writeFileSync(target, renderEnvMd());
console.error(`[env:docs] ENV.md перегенерирован из src/config/env-schema.ts`);
