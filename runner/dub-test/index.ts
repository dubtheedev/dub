// @dub/test: Playwright's `test` and `expect`, plus the SHA guard that makes
// every page load check the preview is still the commit being packed.
//
// The runner sets DUB_SHA to the head SHA. The host app sends `x-dub-sha` on
// every response (contract §6). A document response whose header is present
// and differs means a deploy landed mid-capture: the fixture throws
// DubPreviewMoved, the reporter marks the whole run `preview_moved`, and the
// CLI turns every status into `error` while keeping the artifacts.
import { test as base, expect } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

export class DubPreviewMoved extends Error {
  constructor(public readonly expected: string, public readonly actual: string, url: string) {
    super(`${url} served ${actual.slice(0, 7)} but this bundle is ${expected.slice(0, 7)}`);
    this.name = 'DubPreviewMoved';
  }
}

export interface Criterion { id: string; kind: 'visual' | 'behaviour' | 'check' | 'judgment' }

/** The criteria the CLI passed in, for specs that want to know their kind. */
export function criteria(): Criterion[] {
  try {
    return JSON.parse(process.env.DUB_CRITERIA ?? '[]');
  } catch {
    return [];
  }
}

function guard(page: Page, expected: string, onMoved: (e: DubPreviewMoved) => void) {
  page.on('response', (r: Response) => {
    const req = r.request();
    if (req.resourceType() !== 'document') return;
    const got = r.headers()['x-dub-sha'];
    if (got && got !== expected) onMoved(new DubPreviewMoved(expected, got, r.url()));
  });
}

export const test = base.extend<{ dubShaGuard: void }>({
  dubShaGuard: [
    async ({ page }, use, testInfo) => {
      const expected = process.env.DUB_SHA ?? '';
      let moved: DubPreviewMoved | undefined;
      if (expected) guard(page, expected, (e) => { moved ??= e; });
      // A spec that only uses `request` never opens the page, but Playwright
      // still records its context: one blank white frame. Say so, and the
      // reporter leaves that video out of the evidence.
      let navigated = false;
      page.on('framenavigated', (f) => { if (f === page.mainFrame() && f.url() !== 'about:blank') navigated = true; });
      await use();
      if (!navigated) testInfo.annotations.push({ type: 'dub:no_page', description: 'the spec never opened a page' });
      if (moved) {
        testInfo.annotations.push({ type: 'dub:preview_moved', description: moved.message });
        throw moved;
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from '@playwright/test';
