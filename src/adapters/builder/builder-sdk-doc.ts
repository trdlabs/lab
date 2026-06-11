// src/adapters/builder/builder-sdk-doc.ts
/** Static RAG fixture (placeholder for Builder SDK 021 docs; real RAG arrives in SP-5). */
export const BUILDER_SDK_DOC = [
  'Builder SDK (overlay modules):',
  '- Export a const named `overlay` with { appliesTo, rules } from the entry file.',
  '- rules: array of { when, action, params } where action is an allowed overlay action.',
  '- No imports, no network, no filesystem, no process access. Pure data + logic only.',
  '- The module is research-only and never places live orders.',
].join('\n');
