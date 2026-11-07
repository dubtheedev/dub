import { describe, expect, it } from 'vitest';
import { artifactDiff, criteriaDiff, parseRubric, previousFor, rubricHits } from '../src/lib/meta';
import type { BundleCriterion, Criterion, VerdictEvent } from '../src/types';

const c = (id: string, text: string, kind: Criterion['kind'] = 'visual'): Criterion => ({ id, text, kind });

describe('criteriaDiff', () => {
  it('is empty with no previous bundle', () => {
    expect(criteriaDiff(null, [c('ac-1', 'x')])).toEqual([]);
  });
  it('flags added, removed and edited by id', () => {
    const prev = [c('ac-1', 'Badge shows'), c('ac-2', 'Email renders'), c('ac-3', 'No double send', 'behaviour')];
    const next = [c('ac-1', 'Badge  shows '), c('ac-2', 'Email renders with amount'), c('ac-4', 'Tone', 'judgment')];
    const d = criteriaDiff(prev, next);
    expect(d).toEqual([
      { id: 'ac-2', change: 'edited', from: 'Email renders {kind: visual}', to: 'Email renders with amount {kind: visual}' },
      { id: 'ac-4', change: 'added', to: 'Tone' },
      { id: 'ac-3', change: 'removed', from: 'No double send' },
    ]);
  });
  it('treats a kind change as an edit', () => {
    expect(criteriaDiff([c('a', 't', 'visual')], [c('a', 't', 'judgment')])[0]?.change).toBe('edited');
  });
});

describe('previousFor', () => {
  const bundles = [
    { bundle_id: 'B1', sha: 's1', received_at: '2026-01-01T00:00:00Z' },
    { bundle_id: 'B2', sha: 's2', received_at: '2026-01-02T00:00:00Z' },
    { bundle_id: 'B2b', sha: 's2', received_at: '2026-01-02T01:00:00Z' },
    { bundle_id: 'B3', sha: 's3', received_at: '2026-01-03T00:00:00Z' },
  ];
  const v = (seq: number, sha: string, verdict: VerdictEvent['verdict']): VerdictEvent => ({ seq, sha, bundle_id: 'x', reviewer: 'r', verdict, used: [], because: [], at: '' });
  it('is null for the first bundle', () => {
    expect(previousFor([], [], 's1', '2026-01-01T00:00:00Z')).toBeNull();
  });
  it('prefers the most recent earlier SHA with a verdict, using its newest bundle', () => {
    const p = previousFor(bundles, [v(1, 's1', 'revise'), v(2, 's2', 'revise'), v(3, 's2', 'dub')], 's4', '2026-01-04T00:00:00Z');
    expect(p).toEqual({ sha: 's2', bundle_id: 'B2b', verdict: 'dub', seq: 3 });
  });
  it('falls back to the newest earlier bundle without a verdict', () => {
    expect(previousFor(bundles, [], 's4', '2026-01-04T00:00:00Z')).toEqual({ sha: 's3', bundle_id: 'B3', verdict: null, seq: null });
  });
  it('ignores bundles for the same SHA', () => {
    expect(previousFor(bundles, [v(1, 's1', 'dub')], 's3', '2026-01-03T00:00:00Z')).toEqual({ sha: 's1', bundle_id: 'B1', verdict: 'dub', seq: 1 });
  });
});

const RUBRIC = `# Rubric

Some intro.

## Plain tone, no exclamation marks
Scope: email, broadcasts
Source: https://example.com/style
Customers found "!" pushy.

## Every list has an empty state
Scope: *
Rationale here.

## Dates are shown in the reader's timezone
Nothing scoped here.
`;

describe('rubric', () => {
  it('parses headings, scope, source and rationale', () => {
    const rules = parseRubric(RUBRIC);
    expect(rules.map((r) => r.rule)).toEqual(['Plain tone, no exclamation marks', 'Every list has an empty state', "Dates are shown in the reader's timezone"]);
    expect(rules[0]).toMatchObject({ scope: ['email', 'broadcasts'], source: 'https://example.com/style', rationale: 'Customers found "!" pushy.' });
    expect(rules[1]!.scope).toBeNull();
    expect(rules[2]!.scope).toBeNull();
  });
  it('matches hits by area, case-insensitively, and unscoped rules always', () => {
    expect(rubricHits(RUBRIC, ['Email'])).toEqual(['Plain tone, no exclamation marks', 'Every list has an empty state', "Dates are shown in the reader's timezone"]);
    expect(rubricHits(RUBRIC, ['invoices'])).toEqual(['Every list has an empty state', "Dates are shown in the reader's timezone"]);
    expect(rubricHits(RUBRIC, undefined)).toHaveLength(2);
  });
});

describe('artifactDiff', () => {
  const bc = (id: string, ev: { path: string; hash?: string }[], files?: { path: string; sha256: string }[]): BundleCriterion => ({
    id,
    kind: 'visual',
    status: 'pass',
    evidence: ev.map((e) => ({ type: 'image', ...e })),
    spec: files ? { files } : undefined,
  });
  it('is all null without a previous bundle', () => {
    expect(artifactDiff(null, [bc('ac-1', [{ path: 'a.png', hash: 'h1' }], [{ path: 's.ts', sha256: 'x' }])])).toEqual([
      { id: 'ac-1', spec_changed: null, evidence: [{ path: 'a.png', artifact_changed: null }] },
    ]);
  });
  it('compares hashes per path and spec file fingerprints per criterion', () => {
    const prev = [bc('ac-1', [{ path: 'a.png', hash: 'h1' }, { path: 'b.png', hash: 'h2' }], [{ path: 's.ts', sha256: 'x' }, { path: 'h.ts', sha256: 'y' }]), bc('ac-2', [{ path: 'c.png', hash: 'h3' }])];
    const next = [
      bc('ac-1', [{ path: 'a.png', hash: 'h1' }, { path: 'b.png', hash: 'h2b' }, { path: 'n.png', hash: 'h9' }], [{ path: 'h.ts', sha256: 'y' }, { path: 's.ts', sha256: 'x' }]),
      bc('ac-2', [{ path: 'c.png' }], [{ path: 's2.ts', sha256: 'z' }]),
      bc('ac-3', [{ path: 'd.png', hash: 'h4' }]),
    ];
    expect(artifactDiff(prev, next)).toEqual([
      { id: 'ac-1', spec_changed: false, evidence: [{ path: 'a.png', artifact_changed: false }, { path: 'b.png', artifact_changed: true }, { path: 'n.png', artifact_changed: null }] },
      { id: 'ac-2', spec_changed: null, evidence: [{ path: 'c.png', artifact_changed: null }] },
      { id: 'ac-3', spec_changed: null, evidence: [{ path: 'd.png', artifact_changed: null }] },
    ]);
  });
});
