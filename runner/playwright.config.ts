import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

// Both paths are fixed inside the image; the env overrides exist so the
// harness can be exercised outside Docker.
const OUT = process.env.DUB_OUT ?? '/out';
const TEST_DIR = process.env.DUB_TEST_DIR ?? '/work/.dub/evidence';

// One worker: specs share the preview's resettable state (contract: "Playwright
// runs with one worker"). No retries: a flake is evidence too.
export default defineConfig({
  testDir: TEST_DIR,
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  outputDir: join(OUT, 'raw'),
  reporter: [['list'], ['./reporter.ts']],
  use: {
    baseURL: process.env.DUB_PREVIEW_URL,
    trace: 'on',
    video: 'on',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
