/**
 * Vite+ toolchain configuration.
 *
 * This package ships no Vite application: `vite-plus` supplies the local
 * formatter (Oxfmt) and linter (Oxlint), so the `fmt` and `lint` blocks below
 * are the single source of truth for code style and lint rules. Run them
 * through the package scripts (`pnpm run format` / `pnpm run lint` /
 * `pnpm run check`); tests and the build stay on `node --test` and `tsc`.
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
});
