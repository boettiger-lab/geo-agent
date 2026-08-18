import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            // app/vendor/mcp-sdk.js is a pre-bundled third-party artifact (#343),
            // not code we write or test. CI passes --coverage.include='app/**',
            // which would otherwise report it as a 218 kB file at 0% and drag the
            // project total down. Spread the defaults so excluding it doesn't drop
            // vitest's built-in exclusions (node_modules, test files, configs).
            exclude: [...coverageConfigDefaults.exclude, 'app/vendor/**'],
        },
    },
});
