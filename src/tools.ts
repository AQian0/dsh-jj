/**
 * The `jj_*` model tools (design contract §7) — public barrel.
 *
 * The implementation is split by responsibility:
 * - `tool-schemas.ts`: shared output schemas and pure result views;
 * - `tool-shared.ts`: context types, refusal text, hand-off next steps, workspace ownership;
 * - `tool-definitions.ts`: the 17 `defineTool` definitions;
 * - `tool-entry.ts`: `registerJjTools` and the `jj-tools` plugin entry.
 *
 * The exported names below are unchanged for `src/index.ts`, the other entries,
 * tests, and embedders.
 *
 * @module dsh-jj/tools
 */
export { Config } from './config.ts';
export type { JjToolsHost, JjToolService } from './tool-shared.ts';
export { jjRefusalText } from './tool-shared.ts';
export { jjToolDefinitions } from './tool-definitions.ts';
export { apply, inject, name, registerJjTools } from './tool-entry.ts';
