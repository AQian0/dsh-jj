/**
 * Vite+ toolchain configuration.
 *
 * `vite-plus` supplies the local formatter (Oxfmt), linter (Oxlint), and test
 * runner (Vitest + v8 coverage), so the `fmt`, `lint`, and `test` blocks below
 * are the single source of truth. Run them through `vp fmt` / `vp lint` /
 * `vp check` / `vp test` (or `vp run ...`); package builds stay on `tsc`.
 *
 * @module vite.config
 */
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    // The repository has always been formatted at ~120 columns, single quotes,
    // semicolons. Oxfmt reads .editorconfig for indentation and line endings.
    printWidth: 120,
    singleQuote: true,
  },
  lint: {
    // Oxlint's native default set (unicorn/oxc/typescript) plus ESM import checks.
    plugins: ['unicorn', 'typescript', 'oxc', 'import'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `panel-client.ts` is compiled by tsconfig.client.json as a classic browser script
      // and exercised via node:vm in build.test.ts; `changes-types.ts` is type-only.
      exclude: ['src/panel-client.ts', 'src/changes-types.ts'],
      reporter: ['text', 'html'],
    },
  },
});
