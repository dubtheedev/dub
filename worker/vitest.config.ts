import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// A throwaway RSA key for the App JWT in tests; never used anywhere real.
const TEST_APP_KEY = readFileSync(new URL('./test/test-app-key.pem', import.meta.url), 'utf8');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY: TEST_APP_KEY,
          GITHUB_WEBHOOK_SECRET: 'whsec-test',
          GITHUB_OAUTH_CLIENT_ID: 'Iv1.test',
          GITHUB_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
          SESSION_SECRET: 'session-secret-test-session-secret-test',
          PUBLIC_URL: 'https://dub.test',
          ALLOWED_ORIGINS: 'https://dub.test',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
