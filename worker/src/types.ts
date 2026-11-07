// Shared shapes. The bundle format is `docs/contract.md` → `dub.json`.

export type Verdict = 'dub' | 'revise' | 'reject';
export type CriterionKind = 'visual' | 'behaviour' | 'check' | 'judgment';
export type CriterionStatus = 'pass' | 'fail' | 'error' | 'none';

export interface Criterion {
  id: string;
  kind: CriterionKind;
  text: string;
}

export interface Evidence {
  type: 'image' | 'video' | 'trace' | 'text' | string;
  path: string;
  hash?: string;
  role?: 'supporting';
  artifact_changed?: boolean;
}

export interface BundleCriterion {
  id: string;
  kind: CriterionKind;
  status: CriterionStatus;
  error?: string;
  assertions?: string[];
  spec?: {
    source?: string;
    files?: { path: string; sha256: string }[];
    external_imports?: string[];
    changed?: boolean;
  };
  evidence?: Evidence[];
}

export interface Bundle {
  version: number;
  bundle_id: string;
  repo: string; // owner/name
  pr: number;
  sha: string;
  runner?: string;
  preview?: { url: string; preview_sha?: string | null; moved?: boolean };
  brief: {
    path: string;
    text: string;
    criteria: Criterion[];
    first_seen_sha?: string | null;
    before_implementation?: 'true' | 'false' | 'unknown' | boolean;
  };
  author?: { kind: string; agent?: string; session?: string };
  notes?: { did?: string[]; didnt?: string[]; unsure?: string[] };
  criteria: BundleCriterion[];
  diff?: { files?: number; additions?: number; deletions?: number; areas?: string[] };
}

export interface CriteriaChange {
  id: string;
  change: 'added' | 'removed' | 'edited';
  from?: string;
  to?: string;
}

/** Artifact and spec comparison against `previous`, per criterion. `null` = nothing to compare with. */
export interface MetaCriterion {
  id: string;
  spec_changed: boolean | null;
  evidence: { path: string; artifact_changed: boolean | null }[];
}

export interface Meta {
  bundle_id: string;
  sha: string;
  received_at: string;
  head_at_intake: boolean;
  previous: { sha: string; bundle_id: string; verdict: Verdict | null; seq: number | null } | null;
  criteria_diff: CriteriaChange[];
  criteria: MetaCriterion[];
  rubric: { base_sha: string | null; hits: string[] };
}

export interface VerdictEvent {
  seq: number;
  sha: string;
  bundle_id: string;
  reviewer: string;
  verdict: Verdict;
  reason?: string;
  note?: string;
  used: string[];
  because: string[];
  at: string;
  /** Set when the review was posted by the App on the reviewer's behalf. */
  on_behalf?: boolean;
  idempotency_key?: string | null;
}

// `pending_status` is the App-credentialed pending write on a new head (seq 0).
export type Effect = 'review' | 'status' | 'close' | 'sticky' | 'pending_status';
export type DeliveryState = 'pending' | 'done' | 'superseded' | 'failed';

export interface Delivery {
  seq: number;
  effect: Effect;
  state: DeliveryState;
  attempts: number;
  next_at: number | null;
  first_at: number;
  gh_id: number | null;
  last_error: string | null;
}

export interface BundleRow {
  bundle_id: string;
  sha: string;
  received_at: string;
  /** sha256 hex of the uploaded dub.json bytes; null for rows made before reserve existed. */
  digest?: string | null;
  complete?: boolean;
}

export interface PRState {
  owner: string;
  repo: string;
  number: number;
  head_sha: string | null;
  author: string | null;
  open: boolean;
  reopen_seq: number;
  closed_at: string | null;
}

export interface Env {
  PR: DurableObjectNamespace;
  BUNDLES: R2Bucket;
  GITHUB_OIDC_AUDIENCE: string;
  ALLOWED_ORIGINS: string;
  PUBLIC_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}
