// Writes /out/results.json in the shape docs/contract.md § "Runner interface"
// describes, and copies every attachment under /out/<criterion id>/.
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const OUT = process.env.DUB_OUT ?? '/out';

interface Attachment { name: string; path: string; contentType: string }
interface Entry {
  id: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  error?: string;
  steps: string[];
  attachments: Attachment[];
}

function stepTitles(steps: TestStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    // test.step titles verbatim; top-level pw:api calls (goto, click, expect)
    // as Playwright names them. Hooks and fixtures are noise.
    if (s.category === 'test.step') {
      out.push(s.title);
    } else if (s.category === 'pw:api' || s.category === 'expect') {
      out.push(s.title);
    }
  }
  return out;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export default class DubReporter implements Reporter {
  private entries = new Map<string, Entry>();
  private previewMoved = false;

  onTestEnd(test: TestCase, result: TestResult) {
    const id = test.title;
    const dir = join(OUT, sanitize(id));
    mkdirSync(dir, { recursive: true });
    const attachments: Attachment[] = [];
    const used = new Set<string>();
    for (const a of result.attachments) {
      if (!a.path) continue;
      let name = sanitize(a.name) + (extname(a.path) || '');
      if (a.name === 'screenshot' || a.name === 'video' || a.name === 'trace') {
        name = a.name + extname(a.path);
      }
      let candidate = name;
      let n = 1;
      while (used.has(candidate)) candidate = `${basename(name, extname(name))}-${n++}${extname(name)}`;
      used.add(candidate);
      try {
        copyFileSync(a.path, join(dir, candidate));
        attachments.push({ name: a.name, path: `${sanitize(id)}/${candidate}`, contentType: a.contentType });
      } catch {
        // A missing file (video still finalising) is not worth failing the run.
      }
    }
    const errs = result.errors.map((e) => e.message ?? String(e)).filter(Boolean);
    const moved = errs.some((m) => m.includes('DubPreviewMoved')) ||
      result.annotations?.some((a) => a.type === 'dub:preview_moved');
    if (moved) this.previewMoved = true;
    // Only the first result per id counts; retries are off anyway.
    if (!this.entries.has(id)) {
      this.entries.set(id, {
        id,
        status: result.status,
        error: errs.length ? stripAnsi(errs.join('\n\n')) : undefined,
        steps: stepTitles(result.steps),
        attachments,
      });
    }
  }

  onEnd(_result: FullResult) {
    mkdirSync(OUT, { recursive: true });
    const tests = [...this.entries.values()];
    writeFileSync(join(OUT, 'results.json'), JSON.stringify({ preview_moved: this.previewMoved, tests }, null, 2));
  }

  printsToStdio() {
    return false;
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
