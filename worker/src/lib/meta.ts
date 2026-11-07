// Computed by the Worker at intake (contract decision 2) and stored in meta.json.
import type { BundleCriterion, BundleRow, CriteriaChange, Criterion, MetaCriterion, VerdictEvent } from '../types';

export function criteriaDiff(prev: Criterion[] | null | undefined, next: Criterion[]): CriteriaChange[] {
  if (!prev) return [];
  const out: CriteriaChange[] = [];
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const nextById = new Map(next.map((c) => [c.id, c]));
  for (const c of next) {
    const p = prevById.get(c.id);
    if (!p) out.push({ id: c.id, change: 'added', to: c.text });
    else if (norm(p.text) !== norm(c.text) || p.kind !== c.kind) {
      out.push({ id: c.id, change: 'edited', from: describe(p), to: describe(c) });
    }
  }
  for (const p of prev) {
    if (!nextById.has(p.id)) out.push({ id: p.id, change: 'removed', from: p.text });
  }
  return out;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function describe(c: Criterion): string {
  return `${c.text} {kind: ${c.kind}}`;
}

export interface Previous {
  sha: string;
  bundle_id: string;
  verdict: VerdictEvent['verdict'] | null;
  seq: number | null;
}

/**
 * `previous` is the newest bundle of the most recent *earlier* SHA that has a
 * verdict, else the newest earlier bundle, else null. "Earlier" means
 * received before this bundle; bundles for the same SHA don't count.
 */
export function previousFor(
  bundles: BundleRow[],
  verdicts: VerdictEvent[],
  sha: string,
  receivedAt: string,
): Previous | null {
  const earlier = bundles
    .filter((b) => b.sha !== sha && b.received_at < receivedAt)
    .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
  if (!earlier.length) return null;

  // Group by SHA in order of newest bundle.
  const seenSha = new Set<string>();
  const shas: string[] = [];
  for (const b of earlier) {
    if (!seenSha.has(b.sha)) {
      seenSha.add(b.sha);
      shas.push(b.sha);
    }
  }
  for (const s of shas) {
    let eff: VerdictEvent | null = null;
    for (const v of verdicts) if (v.sha === s && (!eff || v.seq > eff.seq)) eff = v;
    if (eff) {
      const newest = earlier.find((b) => b.sha === s)!;
      return { sha: s, bundle_id: newest.bundle_id, verdict: eff.verdict, seq: eff.seq };
    }
  }
  const newest = earlier[0]!;
  return { sha: newest.sha, bundle_id: newest.bundle_id, verdict: null, seq: null };
}

export interface RubricRule {
  rule: string;
  scope: string[] | null; // null = every area
  rationale: string;
  source: string | null;
}

/**
 * Rubric format (`.dub/rubric.md` on the base branch):
 *
 *   ## The rule, one line
 *   Scope: email, invoices
 *   Source: https://…   (optional)
 *   Free text rationale.
 *
 * No `Scope:` line means the rule applies to every area. Matching is
 * case-insensitive on area names; `*` matches everything.
 */
export function parseRubric(markdown: string): RubricRule[] {
  const rules: RubricRule[] = [];
  let cur: RubricRule | null = null;
  const rationale: string[] = [];
  const flush = () => {
    if (cur) {
      cur.rationale = rationale.join('\n').trim();
      rules.push(cur);
    }
    rationale.length = 0;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      flush();
      cur = { rule: h[1]!.trim(), scope: null, rationale: '', source: null };
      continue;
    }
    if (!cur) continue;
    const scope = /^\s*(?:\*\*)?scope(?:\*\*)?\s*:\s*(.*)$/i.exec(line);
    if (scope) {
      const areas = scope[1]!
        .split(',')
        .map((s) => s.trim().replace(/^`|`$/g, ''))
        .filter(Boolean);
      cur.scope = areas.length && !areas.includes('*') ? areas : null;
      continue;
    }
    const src = /^\s*(?:\*\*)?source(?:\*\*)?\s*:\s*(.*)$/i.exec(line);
    if (src) {
      cur.source = src[1]!.trim() || null;
      continue;
    }
    rationale.push(line);
  }
  flush();
  return rules;
}

export function rubricHits(markdown: string, areas: string[] | undefined | null): string[] {
  const wanted = new Set((areas ?? []).map((a) => a.toLowerCase()));
  const hits: string[] = [];
  for (const r of parseRubric(markdown)) {
    if (r.scope === null) {
      hits.push(r.rule);
      continue;
    }
    if (r.scope.some((s) => wanted.has(s.toLowerCase()))) hits.push(r.rule);
  }
  return hits;
}

/**
 * Artifact and spec comparison against the previous bundle, kept as separate
 * facts from the criterion-text diff. `null` where the previous bundle has
 * nothing at that id/path to compare with.
 */
export function artifactDiff(prev: BundleCriterion[] | null | undefined, next: BundleCriterion[]): MetaCriterion[] {
  const prevById = new Map((prev ?? []).map((c) => [c.id, c]));
  return next.map((c) => {
    const p = prevById.get(c.id);
    const prevHashes = new Map((p?.evidence ?? []).map((e) => [e.path, e.hash ?? null]));
    const evidence = (c.evidence ?? []).map((e) => {
      if (!p || !prevHashes.has(e.path)) return { path: e.path, artifact_changed: null };
      const before = prevHashes.get(e.path) ?? null;
      const after = e.hash ?? null;
      return { path: e.path, artifact_changed: before === null || after === null ? null : before !== after };
    });
    let spec_changed: boolean | null = null;
    if (p && p.spec?.files && c.spec?.files) spec_changed = fingerprint(p.spec.files) !== fingerprint(c.spec.files);
    return { id: c.id, spec_changed, evidence };
  });
}

function fingerprint(files: { path: string; sha256: string }[]): string {
  return files
    .map((f) => `${f.path}:${f.sha256}`)
    .sort()
    .join('\n');
}
