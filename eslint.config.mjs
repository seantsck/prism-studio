import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    ".local-storage/**",
    // upstream-derived code, kept byte-close to the pinned commit; see src/vendor/artcraft-scene-engine/UPSTREAM.md
    "src/vendor/**",
  ]),
]);
