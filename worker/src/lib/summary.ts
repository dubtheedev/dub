// The reviewer-facing summary of a PR: what changed, the key changes, and a
// plan for trying it in the preview. Written by Claude from the PR's diff,
// not by the agent that wrote the PR, so it describes the change rather than
// grading it. Stored next to the bundle as `summary.json`.
import Anthropic from '@anthropic-ai/sdk';
import type { PRFile } from './github';
import type { Summary } from '../types';

export const SUMMARY_MODEL = 'claude-opus-5-5';
/** Patches beyond this many characters are dropped, biggest files first. */
const MAX_PATCH_CHARS = 160_000;

export interface SummaryInput {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  brief: string;
  files: PRFile[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['what_changed', 'key_changes', 'test_plan', 'worth_a_look'],
  properties: {
    what_changed: {
      type: 'string',
      description: 'Two to five plain sentences describing what the change does and how, from the point of view of someone deciding whether to accept it. Markdown allowed. No judgement of quality.',
    },
    key_changes: {
      type: 'array',
      description: 'The handful of changes that matter, biggest first. Leave out renames, formatting and lockfiles unless they are the point.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'files'],
        properties: {
          title: { type: 'string', description: 'Under ten words.' },
          detail: { type: 'string', description: 'One or two sentences. Markdown allowed.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths from the diff.' },
        },
      },
    },
    test_plan: {
      type: 'array',
      description: 'Steps a human can take in the running preview to see the change work, in order. Only things the preview can show; skip steps that need a database outage or a deploy.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'expect', 'path'],
        properties: {
          step: { type: 'string', description: 'What to do, as an instruction.' },
          expect: { type: 'string', description: 'What they should see if the change works.' },
          path: { type: 'string', description: 'The path in the app where the step starts, like /settings, or an empty string when it is not a page.' },
        },
      },
    },
    worth_a_look: {
      type: 'array',
      description: 'Things the preview cannot show that a reviewer should check in the code or think about: migrations, config, edge cases, anything the brief promised that the diff does not visibly do. Empty if none.',
      items: { type: 'string' },
    },
  },
} as const;

const SYSTEM = `You write the summary a human reads before deciding whether to accept a pull request that a coding agent wrote. The reader is a product owner, not necessarily the code's author. Describe the change; do not grade it, praise it, or say it "ensures" anything. Plain words, short sentences, no marketing tone. Where the agent's brief and the diff disagree, say so under worth_a_look. Paths in test_plan are paths in the running app, not file paths.`;

export function buildPrompt(input: SummaryInput): { text: string; truncated: boolean; patch_chars: number } {
  const files = [...input.files];
  let budget = MAX_PATCH_CHARS;
  let truncated = false;
  // Spend the budget on small files first so a huge generated file does not
  // crowd out the ones a reader cares about.
  const byPatch = files
    .map((f, idx) => ({ idx, len: f.patch?.length ?? 0 }))
    .sort((a, b) => a.len - b.len);
  const keep = new Set<number>();
  for (const { idx, len } of byPatch) {
    if (len <= budget) {
      keep.add(idx);
      budget -= len;
    } else truncated = true;
  }
  let patch_chars = 0;
  const diff = files
    .map((f, idx) => {
      const head = `### ${f.filename} (${f.status}, +${f.additions} −${f.deletions})${f.previous_filename ? ` from ${f.previous_filename}` : ''}`;
      if (!f.patch) return `${head}\n(no patch: binary or too large)`;
      if (!keep.has(idx)) return `${head}\n(patch omitted to fit)`;
      patch_chars += f.patch.length;
      return `${head}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    })
    .join('\n\n');
  const text = `Repository: ${input.owner}/${input.repo}\nPull request #${input.number}: ${input.title}\n\n## PR description\n${input.body?.trim() || '(none)'}\n\n## The agent's brief\n${input.brief.trim() || '(none)'}\n\n## Diff (${files.length} files)\n${diff}`;
  return { text, truncated, patch_chars };
}

export interface GenerateOptions {
  apiKey: string;
  fetch?: typeof fetch;
  model?: string;
}

export async function generateSummary(input: SummaryInput, opts: GenerateOptions): Promise<Summary> {
  const model = opts.model ?? SUMMARY_MODEL;
  const client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch ?? ((...a) => globalThis.fetch(...a)), timeout: 5 * 60_000, maxRetries: 2 });
  const prompt = buildPrompt(input);
  const generated_at = new Date().toISOString();
  const base: Summary = {
    status: 'error',
    model,
    generated_at,
    input: { files: input.files.length, patch_chars: prompt.patch_chars, truncated: prompt.truncated },
  };
  const res = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: 'user', content: prompt.text }],
  });
  if (res.stop_reason === 'refusal') return { ...base, error: `the model declined to summarise this diff${res.stop_details?.explanation ? ': ' + res.stop_details.explanation : ''}` };
  if (res.stop_reason === 'max_tokens') return { ...base, error: 'the summary ran past its length limit' };
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...base, error: 'the model did not return valid JSON' };
  }
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    ...base,
    status: 'done',
    model: res.model || model,
    what_changed: typeof parsed.what_changed === 'string' ? parsed.what_changed : '',
    key_changes: Array.isArray(parsed.key_changes)
      ? parsed.key_changes.map((k: Record<string, unknown>) => ({ title: String(k.title ?? ''), detail: String(k.detail ?? ''), files: strs(k.files) }))
      : [],
    test_plan: Array.isArray(parsed.test_plan)
      ? parsed.test_plan.map((t: Record<string, unknown>) => ({ step: String(t.step ?? ''), expect: String(t.expect ?? ''), path: normalisePath(t.path) }))
      : [],
    worth_a_look: strs(parsed.worth_a_look),
  };
}

function normalisePath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  if (!t || !t.startsWith('/') || t.startsWith('//')) return null;
  return t;
}
