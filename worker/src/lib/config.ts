// `.dub/config.yml` and `.dub/areas.yml`, read from the base branch.
//
// A tiny YAML subset: `key: value`, `key: [a, b]`, and
//   key:
//     - a
//     - b
// Enough for the two files; anything fancier belongs in a real parser.

export interface DubConfig {
  reviewers: string[];
  base: string;
  preview_origin_allowlist: string[];
  /** A Reject closes the PR (spec). `close_on_reject: false` turns that off per repo. */
  close_on_reject: boolean;
  /** When set, only OIDC tokens minted by this workflow file may upload bundles. */
  publish_workflow: string | null;
  /** Lets a reviewer accept their own PR. Off by default; on for dogfooding. */
  allow_self_review: boolean;
}

export type Areas = Record<string, string[]>;

export function parseSimpleYaml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (val === '') {
      out[key] = [];
      listKey = key;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      out[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      listKey = null;
    } else {
      out[key] = unquote(val);
      listKey = null;
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export function parseConfig(text: string | null | undefined): DubConfig {
  const y = text ? parseSimpleYaml(text) : {};
  const list = (v: string | string[] | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const bool = (v: string | string[] | undefined, dflt: boolean): boolean =>
    typeof v === 'string' ? !['false', 'no', 'off', '0'].includes(v.toLowerCase()) : dflt;
  return {
    reviewers: list(y.reviewers).map((r) => r.replace(/^@/, '').toLowerCase()),
    base: typeof y.base === 'string' && y.base ? y.base : 'main',
    preview_origin_allowlist: list(y.preview_origin_allowlist),
    close_on_reject: bool(y.close_on_reject, true),
    publish_workflow: typeof y.publish_workflow === 'string' && y.publish_workflow ? y.publish_workflow.replace(/^\.github\/workflows\//, '') : null,
    allow_self_review: bool(y.allow_self_review, false),
  };
}

export function parseAreas(text: string | null | undefined): Areas {
  if (!text) return {};
  const y = parseSimpleYaml(text);
  const out: Areas = {};
  for (const [k, v] of Object.entries(y)) out[k] = Array.isArray(v) ? v : [v];
  return out;
}
