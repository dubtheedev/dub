// The review page. One PR, one bundle: what changed (written from the diff,
// not by the agent), how to try it, the preview in a side drawer, and the
// verdict. The agent's own checks are kept, but demoted to a panel: they say
// the PR does what the agent meant, not that it is right.
import type { Bundle, Meta, Summary, VerdictEvent, Delivery } from '../types';
import { BECAUSE_OPTIONS, USED_OPTIONS, VERDICT_LABEL } from '../lib/verdicts';
import { esc, jsonForScript } from './html';
import { inline, renderMarkdown } from './markdown';

export interface ReviewPageData {
  owner: string;
  repo: string;
  number: number;
  viewer: string;
  can_review: boolean;
  /** Why the controls are hidden, shown in the footer; null when they are not. */
  cannot_review_because: string | null;
  head_sha: string | null;
  bundle: Bundle;
  meta: Meta;
  /** null when the Worker has no Anthropic key; a pending/error/done record otherwise, or undefined when nothing has started. */
  summary: Summary | null | undefined;
  bundle_base: string; // URL prefix for bundle files
  verdicts: VerdictEvent[];
  failed_deliveries: Pick<Delivery, 'effect' | 'last_error'>[];
  newer_bundle_exists: boolean;
  all_bundles_for_sha: number;
}

const CSS = `
:root { --bg:#fff; --fg:#111; --muted:#666; --line:#ddd; --card:#fafafa; --ok:#1a7f37; --bad:#b42318; --warn:#9a6700; --info:#0b63c5; --accent:#2d5bff; --drawer: 46vw; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#9a9a9a; --line:#333; --card:#1a1a1a; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --info:#58a6ff; --accent:#6b8cff; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin:0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--fg); display:flex; flex-direction:column; }
a { color: var(--info); }
code, pre { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--card); border:1px solid var(--line); padding:10px; overflow:auto; max-height: 420px; border-radius: 6px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
header { padding: 12px 20px; border-bottom: 1px solid var(--line); display:flex; flex-wrap:wrap; gap: 8px 16px; align-items: center; }
header h1 { font-size: 17px; margin:0; flex: 1 1 320px; }
header .actions { display:flex; gap: 8px; align-items:center; margin-left:auto; }
.meta { font-size: 13px; color: var(--muted); display:flex; gap: 14px; flex-wrap: wrap; padding: 6px 20px 0; }
.banners { padding: 0 20px; }
.banner { margin: 10px 0; padding: 8px 12px; border-left: 4px solid var(--warn); background: var(--card); }
.banner.bad { border-color: var(--bad); }
.banner.info { border-color: var(--info); }
.shell { flex: 1; display:flex; min-height: 0; }
main { flex: 1; min-width: 0; overflow: auto; padding: 8px 20px 120px; }
.cols { display:grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 28px; max-width: 1280px; }
@media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }
section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 22px 0 8px; }
section h2:first-child { margin-top: 12px; }
.prose p { margin: 0 0 10px; }
.prose h3, .prose h4, .prose h5 { margin: 14px 0 6px; font-size: 15px; }
.prose ul, .prose ol { margin: 6px 0 10px; padding-left: 22px; }
.prose blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.card { border:1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: var(--card); }
.card h3 { margin: 0 0 6px; font-size: 15px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.changes li { margin: 0 0 8px; }
.changes .files { display:block; color: var(--muted); font-size: 12px; }
.plan { list-style: none; padding: 0; margin: 0; counter-reset: step; }
.plan li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); align-items: start; }
.plan li:last-child { border-bottom: 0; }
.plan input { margin: 4px 0 0; width: 16px; height: 16px; }
.plan .expect { color: var(--muted); }
.plan .open { font-size: 13px; margin-left: 8px; white-space: nowrap; }
.plan li.done .step { text-decoration: line-through; color: var(--muted); }
.kind { font-size: 11px; padding: 1px 6px; border:1px solid var(--line); border-radius: 10px; color: var(--muted); }
.status { font-weight: 600; }
.status.pass { color: var(--ok); } .status.fail { color: var(--bad); } .status.error { color: var(--warn); } .status.none { color: var(--muted); }
.flag { font-size: 12px; color: var(--warn); }
.evidence img, .evidence video { max-width: 100%; border:1px solid var(--line); border-radius: 4px; display:block; margin: 8px 0; }
ul { margin: 6px 0; padding-left: 20px; }
details summary { cursor: pointer; }
details.panel { border:1px solid var(--line); border-radius: 8px; background: var(--card); margin-bottom: 12px; }
details.panel > summary { padding: 10px 14px; font-weight: 600; display:flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
details.panel > summary .muted { font-weight: 400; font-size: 13px; }
details.panel > .body { padding: 0 14px 12px; }
details.panel .card { background: var(--bg); }
.pending { display:flex; gap: 10px; align-items:center; color: var(--muted); padding: 12px 0; }
.spinner { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
footer { border-top: 1px solid var(--line); padding: 12px 20px; display:flex; flex-direction: column; gap: 10px; background: var(--bg); }
footer .row { display:flex; gap: 14px; flex-wrap: wrap; align-items: center; }
button { font: inherit; padding: 7px 13px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.quiet { background: transparent; }
button[disabled] { opacity: .5; cursor: default; }
textarea { font: inherit; width: 100%; max-width: 640px; min-height: 60px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
label { display:inline-flex; gap: 6px; align-items: center; }
#result, #rerun-result { font-weight: 600; }
.history li { margin: 2px 0; }
/* Preview drawer */
#drawer { display:none; flex-direction: column; width: var(--drawer); min-width: 360px; max-width: 85vw; border-left: 1px solid var(--line); background: var(--bg); position: relative; }
body.drawer-open #drawer { display:flex; }
#drawer .bar { display:flex; gap: 6px; align-items:center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
#drawer .bar input { flex: 1; min-width: 0; font: 13px ui-monospace, Menlo, monospace; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
#drawer .bar button { padding: 5px 9px; font-size: 13px; }
#drawer iframe { flex: 1; border: 0; width: 100%; background: #fff; }
#drawer .grip { position:absolute; left:-4px; top:0; bottom:0; width: 8px; cursor: col-resize; }
#drawer .note { padding: 6px 10px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
@media (max-width: 980px) { body.drawer-open main { display:none; } #drawer { width: 100% !important; max-width: none; min-width: 0; border-left: 0; } }
`;

export function renderReviewPage(d: ReviewPageData): string {
  const b = d.bundle;
  const m = d.meta;
  const shaShort = b.sha.slice(0, 7);
  const eff = latestFor(d.verdicts, b.sha);
  const prov = String(b.brief.before_implementation ?? 'unknown');
  const edited = m.criteria_diff.map((c) => c.id);
  const crit = b.criteria;
  const briefCriteria = new Map(b.brief.criteria.map((c) => [c.id, c]));
  const metaCriteria = new Map((m.criteria ?? []).map((c) => [c.id, c]));
  const previewUrl = b.preview?.url && /^https:\/\//.test(b.preview.url) ? b.preview.url.replace(/\/$/, '') : null;
  const ghPr = `https://github.com/${esc(d.owner)}/${esc(d.repo)}/pull/${d.number}`;

  const banners: string[] = [];
  banners.push(`<div class="banner" id="preview-banner" hidden></div>`);
  if (b.preview?.moved) banners.push(`<div class="banner bad">The preview moved during capture. Every check is <b>error</b>; the artifacts are kept but can't be trusted.</div>`);
  if (edited.length) {
    banners.push(
      `<div class="banner">✎ The agent changed its criteria since the previous bundle: ${edited.map((id) => `<code>${esc(id)}</code>`).join(', ')} <details><summary>diff</summary><ul>${m.criteria_diff
        .map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.change)}${c.from ? `<br><span class="muted">from:</span> ${esc(c.from)}` : ''}${c.to ? `<br><span class="muted">to:</span> ${esc(c.to)}` : ''}</li>`)
        .join('')}</ul></details></div>`,
    );
  }
  if (d.head_sha && d.head_sha !== b.sha) banners.push(`<div class="banner">This bundle is for <code>${esc(shaShort)}</code>; the PR head is now <code>${esc(d.head_sha.slice(0, 7))}</code>.</div>`);
  if (eff && d.newer_bundle_exists) banners.push(`<div class="banner info">${esc(VERDICT_LABEL[eff.verdict])} on bundle <code>${esc(eff.bundle_id)}</code> · a newer capture exists for this SHA. The acceptance stands.</div>`);
  if (d.failed_deliveries.length) {
    banners.push(
      `<div class="banner bad">Some deliveries to GitHub gave up and need a human: <ul>${d.failed_deliveries
        .map((f) => `<li><code>${esc(f.effect)}</code> — ${esc(f.last_error ?? 'unknown error')}</li>`)
        .join('')}</ul></div>`,
    );
  }

  // ---- summary -------------------------------------------------------------
  const s = d.summary;
  let summaryHtml: string;
  if (s === null) {
    summaryHtml = `<h2>What changed</h2><div class="prose"><p class="muted">No summary: this Worker has no Anthropic key. The diff is ${diffLine(b, ghPr)}.</p></div>`;
  } else if (!s || s.status === 'pending') {
    summaryHtml = `<h2>What changed</h2><div class="pending" id="summary-pending"><span class="spinner"></span><span>Reading the diff and writing the summary… this takes about a minute.</span></div>`;
  } else if (s.status === 'error') {
    summaryHtml = `<h2>What changed</h2><div class="prose"><p class="muted">The summary could not be written: ${esc(s.error ?? 'unknown error')}. <button type="button" class="quiet small" id="summary-retry">Try again</button></p><p class="muted">The diff is ${diffLine(b, ghPr)}.</p></div>`;
  } else {
    const plan = (s.test_plan ?? []).filter((t) => t.step);
    summaryHtml = `
<h2>What changed</h2>
<div class="prose">${renderMarkdown(s.what_changed ?? '', { headingShift: 2 })}</div>
${
  s.key_changes?.length
    ? `<h2>Key changes</h2><ul class="changes">${s.key_changes
        .map((k) => `<li><b>${inline(k.title)}</b>${k.detail ? ` — ${inline(k.detail)}` : ''}${k.files?.length ? `<span class="files">${k.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span>` : ''}</li>`)
        .join('')}</ul>`
    : ''
}
${
  plan.length
    ? `<h2>Try it</h2><ol class="plan" id="plan">${plan
        .map(
          (t, i) => `<li><input type="checkbox" aria-label="step ${i + 1} done"><div><div class="step">${inline(t.step)}${
            t.path && previewUrl ? ` <a href="${esc(previewUrl + t.path)}" class="open" data-path="${esc(t.path)}">open ${esc(t.path)} ↗</a>` : ''
          }</div><div class="expect">${inline(t.expect)}</div></div></li>`,
        )
        .join('')}</ol>`
    : previewUrl
      ? `<h2>Try it</h2><p class="muted">No steps the preview can show. ${diffLine(b, ghPr, true)}</p>`
      : ''
}
${s.worth_a_look?.length ? `<h2>Worth a look</h2><ul>${s.worth_a_look.map((w) => `<li>${inline(w)}</li>`).join('')}</ul>` : ''}
<p class="muted small">Written by ${esc(s.model ?? 'Claude')} from the diff${s.input?.truncated ? ' (some large patches were left out)' : ''}, not by the agent. ${diffLine(b, ghPr, true)}</p>`;
  }

  // ---- agent's checks (demoted) -------------------------------------------
  const counts = { pass: 0, fail: 0, error: 0, none: 0 } as Record<string, number>;
  for (const c of crit) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const checksLabel = crit.length
    ? counts.pass === crit.length
      ? `${crit.length} of ${crit.length} passed`
      : [counts.pass ? `${counts.pass} passed` : '', counts.fail ? `${counts.fail} failed` : '', counts.error ? `${counts.error} errored` : '', counts.none ? `${counts.none} without evidence` : ''].filter(Boolean).join(', ')
    : 'none';
  const criteriaHtml = crit
    .map((c) => {
      const bc = briefCriteria.get(c.id);
      const mc = metaCriteria.get(c.id);
      const artifactChanged = new Map((mc?.evidence ?? []).map((e) => [e.path, e.artifact_changed]));
      const statusLabel =
        c.status === 'pass' ? 'Assertions passed' : c.status === 'fail' ? `Assertion failed${c.error ? ': ' + c.error : ''}` : c.status === 'error' ? `Couldn't complete${c.error ? ': ' + c.error : ''}` : 'No automated evidence';
      const ev = (c.evidence ?? [])
        .map((e) => {
          const url = `${d.bundle_base}/${e.path}`;
          const changed = artifactChanged.get(e.path);
          const flags = [e.role === 'supporting' ? 'supporting' : '', changed === true ? 'artifact changed' : changed === false ? 'identical to previous' : ''].filter(Boolean).join(' · ');
          let body = `<a href="${esc(url)}">${esc(e.path)}</a>`;
          if (e.type === 'image') body = `<a href="${esc(url)}"><img src="${esc(url)}" alt="${esc(e.path)}" loading="lazy"></a>`;
          else if (e.type === 'video') body = `<video src="${esc(url)}" controls preload="metadata"></video>`;
          const caption = [e.type === 'image' || e.type === 'video' ? e.path : '', flags].filter(Boolean).join(' · ');
          return `<div class="evidence">${body}${caption ? `<div class="muted small">${esc(caption)}</div>` : ''}</div>`;
        })
        .join('');
      return `<div class="card" id="c-${esc(c.id)}">
  <h3><code>${esc(c.id)}</code> ${esc(bc?.text ?? '')} <span class="kind">${esc(c.kind)}</span>${edited.includes(c.id) ? '<span class="flag">✎ criterion edited</span>' : ''}${mc?.spec_changed ? '<span class="flag">spec changed</span>' : ''}</h3>
  <div class="status ${esc(c.status)}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'error' ? '⚠' : '·'} ${esc(statusLabel)}</div>
  ${c.assertions?.length ? `<details><summary class="muted small">${c.assertions.length} assertion${c.assertions.length === 1 ? '' : 's'}</summary><ul>${c.assertions.map((a) => `<li><code>${esc(a)}</code></li>`).join('')}</ul></details>` : ''}
  ${c.spec?.source ? `<details><summary class="muted small">spec${c.spec.files?.length ? ` (${c.spec.files.length} file${c.spec.files.length === 1 ? '' : 's'})` : ''}${c.spec.external_imports?.length ? ' · imports ' + esc(c.spec.external_imports.join(', ')) : ''}</summary><pre>${esc(c.spec.source)}</pre></details>` : ''}
  ${ev}
</div>`;
    })
    .join('\n');

  const notes = b.notes ?? {};
  const noteList = (title: string, items?: string[]) => (items && items.length ? `<h4 style="margin:10px 0 4px">${esc(title)}</h4><ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>` : '');
  const notesHtml = noteList('Did', notes.did) + noteList("Didn't", notes.didnt) + noteList('Unsure', notes.unsure);
  const provenance = prov === 'true' ? 'brief written before the code' : prov === 'false' ? `brief written after some of the code${b.brief.first_seen_sha ? ` (first seen at <code>${esc(String(b.brief.first_seen_sha).slice(0, 7))}</code>)` : ''}` : 'brief order unknown';

  const history = d.verdicts.length
    ? `<details class="panel"><summary>Verdicts on this PR <span class="muted">${d.verdicts.length}</span></summary><div class="body"><ul class="history">${d.verdicts
        .slice()
        .reverse()
        .map((v) => `<li>#${v.seq} <b>${esc(VERDICT_LABEL[v.verdict])}</b> by @${esc(v.reviewer)} on <code>${esc(v.sha.slice(0, 7))}</code> · <code>${esc(v.bundle_id)}</code> · ${esc(v.at)}${v.on_behalf ? ' <span class="muted">(posted on behalf)</span>' : ''}</li>`)
        .join('')}</ul></div></details>`
    : '';

  const checks = (name: string, opts: Record<string, string>) =>
    Object.entries(opts)
      .map(([k, label]) => `<label><input type="checkbox" name="${esc(name)}" value="${esc(k)}"> ${esc(label)}</label>`)
      .join(' ');

  const pageState = {
    owner: d.owner,
    repo: d.repo,
    pr: d.number,
    sha: b.sha,
    bundle_id: b.bundle_id,
    preview_url: previewUrl,
    can_review: d.can_review,
    summary_status: s === null ? 'skipped' : (s?.status ?? 'missing'),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dub · ${esc(d.owner)}/${esc(d.repo)} #${d.number}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1><a href="${ghPr}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">#${d.number}</a> ${esc(briefTitle(b.brief.text))}</h1>
  <div class="actions">
    ${d.can_review ? `<button type="button" id="rerun" title="Re-run the capture workflow for this commit">Run checks again</button>` : ''}
    ${previewUrl ? `<button type="button" class="primary" id="toggle-drawer">Preview</button>` : '<span class="muted small">no preview URL in this bundle</span>'}
  </div>
</header>
<div class="meta">
  <span><code>${esc(shaShort)}</code> · bundle <code>${esc(b.bundle_id)}</code>${d.all_bundles_for_sha > 1 ? ` (${d.all_bundles_for_sha} captures for this SHA; newest shown)` : ''}</span>
  <span>prev: ${m.previous ? `${esc(m.previous.verdict ?? 'no verdict')} on <code>${esc(m.previous.sha.slice(0, 7))}</code>` : 'none'}</span>
  ${eff ? `<span>effective: <b>${esc(VERDICT_LABEL[eff.verdict])}</b> by @${esc(eff.reviewer)}</span>` : '<span>no verdict for this SHA</span>'}
  ${previewUrl ? `<a href="${esc(previewUrl)}" target="_blank" rel="noopener">open preview in a tab ↗</a>` : ''}
  <span id="rerun-result" aria-live="polite"></span>
  <span style="margin-left:auto">signed in as @${esc(d.viewer)}</span>
</div>
<div class="banners">${banners.join('\n')}</div>
<div class="shell">
<main>
  <div class="cols">
  <section>
    ${summaryHtml}
  </section>
  <section>
    <h2>From the agent</h2>
    <details class="panel"><summary>Agent's checks <span class="muted">${esc(checksLabel)} · written by the agent that wrote the PR</span></summary><div class="body">
      <p class="muted small">These say the PR does what the agent meant. They do not say the change is right; that is the point of this page.</p>
      ${criteriaHtml || '<div class="muted">No criteria in this bundle.</div>'}
      ${b.runner ? `<div class="muted small">runner <code>${esc(b.runner)}</code></div>` : ''}
    </div></details>
    <details class="panel"><summary>Brief <span class="muted">${provenance}</span></summary><div class="body prose">${renderMarkdown(b.brief.text, { headingShift: 2 })}</div></details>
    ${notesHtml ? `<details class="panel"><summary>Agent's notes</summary><div class="body">${notesHtml}</div></details>` : ''}
    ${m.rubric.hits.length ? `<details class="panel" open><summary>House rules that apply <span class="muted">${b.diff?.areas?.length ? esc(b.diff.areas.join(', ')) : ''}</span></summary><div class="body"><ul>${m.rubric.hits.map((h) => `<li>${inline(h)}</li>`).join('')}</ul></div></details>` : ''}
    ${history}
  </section>
  </div>
</main>
<aside id="drawer" aria-label="preview">
  <div class="grip" id="grip"></div>
  <div class="bar">
    <input id="drawer-path" value="/" spellcheck="false" aria-label="path in the preview">
    <button type="button" id="drawer-go" title="go">Go</button>
    <button type="button" id="drawer-reload" title="reload">↻</button>
    <a id="drawer-pop" href="${esc(previewUrl ?? '#')}" target="_blank" rel="noopener" title="open in a new tab"><button type="button">↗</button></a>
    <button type="button" id="drawer-close" title="close">✕</button>
  </div>
  <div class="note">If this stays blank, the preview app is refusing to be framed or needs a sign-in that only works in its own tab. Use ↗.</div>
  <iframe id="preview-frame" title="preview" referrerpolicy="no-referrer"></iframe>
</aside>
</div>
<footer>
  <form id="verdict" ${d.can_review ? '' : 'hidden'}>
    <div class="row">
      <button type="button" class="primary" data-verdict="dub">Dub it</button>
      <button type="button" data-verdict="revise">Revise</button>
      <button type="button" data-verdict="reject">Reject</button>
      <label><input type="checkbox" name="suggest_rule"> suggest as rule</label>
    </div>
    <textarea name="note" placeholder="note (optional)"></textarea>
    <div class="row"><span class="muted">Also used (any):</span> ${checks('used', USED_OPTIONS)}</div>
    <div class="row"><span class="muted">Because (any):</span> ${checks('because', BECAUSE_OPTIONS)}</div>
  </form>
  ${d.can_review ? '' : `<div class="muted">${inline(d.cannot_review_because ?? 'The verdict controls are hidden.')}</div>`}
  <div id="result" aria-live="polite"></div>
</footer>
<script>
const S = ${jsonForScript(pageState)};
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  const ids = { owner: S.owner, repo: S.repo, pr: S.pr, sha: S.sha, bundle_id: S.bundle_id };

  // ---- preview SHA poll ----
  const banner = $('preview-banner');
  async function poll() {
    if (!S.preview_url) return;
    try {
      const r = await fetch(S.preview_url + '/__dub/version', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.sha && j.sha !== S.sha) {
        banner.textContent = '⚠ Live preview runs ' + j.sha.slice(0, 7) + ' (differs from this bundle, ' + S.sha.slice(0, 7) + ')';
        banner.hidden = false;
      } else if (j && !j.sha) {
        banner.textContent = '⚠ Live preview does not report its SHA';
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    } catch (e) {
      banner.textContent = '⚠ Could not read the preview\\u2019s SHA (' + (e && e.message ? e.message : e) + ')';
      banner.hidden = false;
    }
  }
  poll();
  setInterval(poll, 15000);

  // ---- summary: written on first view, page reloads when it lands ----
  async function waitForSummary(force) {
    if (S.summary_status === 'skipped' || (!force && S.summary_status === 'done')) return;
    try {
      const j = await api('/api/summaries', Object.assign({ force: !!force }, ids));
      if (j.status === 'done' || j.status === 'error') location.reload();
      else setTimeout(() => waitForSummary(false), 4000);
    } catch (e) {
      const p = $('summary-pending');
      if (p) p.textContent = 'Could not write the summary: ' + e.message;
    }
  }
  if (S.summary_status === 'missing' || S.summary_status === 'pending') waitForSummary(false);
  const retry = $('summary-retry');
  if (retry) retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = 'Writing…'; waitForSummary(true); });

  // ---- test plan checkboxes (per viewer, per bundle) ----
  const plan = $('plan');
  if (plan) {
    const key = 'dub:plan:' + S.bundle_id;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
    const items = Array.from(plan.querySelectorAll('li'));
    items.forEach((li, i) => {
      const box = li.querySelector('input');
      box.checked = done.includes(i);
      li.classList.toggle('done', box.checked);
      box.addEventListener('change', () => {
        li.classList.toggle('done', box.checked);
        const now = items.map((l, j) => l.querySelector('input').checked ? j : -1).filter((j) => j >= 0);
        try { localStorage.setItem(key, JSON.stringify(now)); } catch (e) {}
      });
    });
  }

  // ---- preview drawer ----
  const drawer = $('drawer'), frame = $('preview-frame'), pathIn = $('drawer-path'), pop = $('drawer-pop');
  let loaded = false;
  function show(path) {
    if (!S.preview_url) return;
    document.body.classList.add('drawer-open');
    if (path !== undefined) pathIn.value = path;
    const url = S.preview_url + (pathIn.value.startsWith('/') ? pathIn.value : '/' + pathIn.value);
    if (!loaded || path !== undefined) { frame.src = url; loaded = true; }
    pop.href = url;
  }
  const toggle = $('toggle-drawer');
  if (toggle) toggle.addEventListener('click', () => document.body.classList.contains('drawer-open') ? document.body.classList.remove('drawer-open') : show());
  $('drawer-close').addEventListener('click', () => document.body.classList.remove('drawer-open'));
  $('drawer-go').addEventListener('click', () => show(pathIn.value));
  pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(pathIn.value); });
  $('drawer-reload').addEventListener('click', () => { frame.src = frame.src; });
  document.querySelectorAll('a.open[data-path]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.path); }));
  // Resize by dragging the left edge.
  const grip = $('grip');
  let drag = null;
  grip.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, w: drawer.getBoundingClientRect().width }; grip.setPointerCapture(e.pointerId); frame.style.pointerEvents = 'none'; });
  grip.addEventListener('pointermove', (e) => { if (!drag) return; const w = Math.max(360, Math.min(window.innerWidth * 0.85, drag.w + (drag.x - e.clientX))); document.documentElement.style.setProperty('--drawer', w + 'px'); });
  grip.addEventListener('pointerup', () => { drag = null; frame.style.pointerEvents = ''; });
  if (location.hash === '#preview') show();

  // ---- rerun ----
  const rerun = $('rerun'), rerunOut = $('rerun-result');
  if (rerun) rerun.addEventListener('click', async () => {
    rerun.disabled = true;
    rerunOut.textContent = 'Starting…';
    try {
      const j = await api('/api/reruns', { owner: S.owner, repo: S.repo, pr: S.pr, sha: S.sha });
      const started = Date.now();
      rerunOut.innerHTML = 'Running — a new capture lands in a few minutes. <a href="' + j.html_url + '" target="_blank" rel="noopener">watch ↗</a>';
      const tick = async () => {
        try {
          const r = await fetch('/api/prs/' + S.owner + '/' + S.repo + '/' + S.pr, { cache: 'no-store' });
          const st = await r.json();
          const fresh = (st.bundles || []).some((b) => b.sha === S.sha && Date.parse(b.received_at) > started && b.complete !== false);
          if (fresh) { location.href = location.pathname + '?sha=' + S.sha; return; }
        } catch (e) {}
        if (Date.now() - started < 40 * 60000) setTimeout(tick, 15000);
        else { rerunOut.textContent = 'No new capture after 40 minutes; check the run.'; rerun.disabled = false; }
      };
      setTimeout(tick, 30000);
    } catch (e) {
      rerunOut.textContent = 'Could not start: ' + e.message;
      rerun.disabled = false;
    }
  });

  // ---- verdict ----
  const form = $('verdict');
  const result = $('result');
  if (!S.can_review) return;
  let key = crypto.randomUUID();
  for (const btn of form.querySelectorAll('button[data-verdict]')) {
    btn.addEventListener('click', async () => {
      const vals = (n) => Array.from(form.querySelectorAll('input[name="' + n + '"]:checked')).map((i) => i.value);
      const body = Object.assign({}, ids, {
        idempotency_key: key,
        verdict: btn.dataset.verdict,
        note: form.note.value,
        suggest_rule: form.suggest_rule.checked,
        used: vals('used'), because: vals('because'),
      });
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      result.textContent = 'Recording…';
      try {
        const j = await api('/api/verdicts', body);
        let msg = 'Recorded ' + btn.dataset.verdict + ' for ' + S.sha.slice(0, 7) + ' (seq ' + j.seq + ').';
        if (j.historical) msg += ' The PR has moved on to ' + j.head_sha.slice(0, 7) + ', which has no verdict yet.';
        if (j.review === 'on_behalf_pending') msg += ' Your GitHub token could not post the review; Dub will post it on your behalf.';
        result.textContent = msg;
        key = crypto.randomUUID();
      } catch (e) {
        result.textContent = 'Failed: ' + e.message;
        for (const b of form.querySelectorAll('button')) b.disabled = false;
      }
    });
  }
})();
</script>
</body>
</html>`;
}

function diffLine(b: Bundle, ghPr: string, short = false): string {
  const stats = b.diff ? `${b.diff.files ?? '?'} files, +${b.diff.additions ?? '?'} −${b.diff.deletions ?? '?'}` : 'not described in the bundle';
  return `${short ? 'Diff: ' : ''}${esc(stats)} · <a href="${ghPr}/files" target="_blank" rel="noopener">open on GitHub</a>`;
}

function latestFor(events: VerdictEvent[], sha: string): VerdictEvent | null {
  let best: VerdictEvent | null = null;
  for (const e of events) if (e.sha === sha && (!best || e.seq > best.seq)) best = e;
  return best;
}

function briefTitle(text: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1]!.trim() : 'Dub request';
}

export function renderSimple(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main style="display:block;max-width:720px;padding:20px"><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
