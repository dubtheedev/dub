// A placeholder review page. Ryan's page replaces this; it exists so the
// pilot can run end to end and so the API has one consumer from day one.
import type { Bundle, Meta, VerdictEvent, Delivery } from '../types';
import { BECAUSE_OPTIONS, USED_OPTIONS, VERDICT_LABEL } from '../lib/verdicts';
import { esc, jsonForScript } from './html';

export interface ReviewPageData {
  owner: string;
  repo: string;
  number: number;
  viewer: string;
  can_review: boolean;
  head_sha: string | null;
  bundle: Bundle;
  meta: Meta;
  bundle_base: string; // URL prefix for bundle files
  verdicts: VerdictEvent[];
  failed_deliveries: Pick<Delivery, 'effect' | 'last_error'>[];
  newer_bundle_exists: boolean;
  all_bundles_for_sha: number;
}

const CSS = `
:root { --bg:#fff; --fg:#111; --muted:#666; --line:#ddd; --card:#fafafa; --ok:#1a7f37; --bad:#b42318; --warn:#9a6700; --info:#0b63c5; --accent:#2d5bff; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#9a9a9a; --line:#333; --card:#1a1a1a; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --info:#58a6ff; --accent:#6b8cff; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--fg); }
a { color: var(--info); }
header { padding: 14px 20px; border-bottom: 1px solid var(--line); display:flex; flex-wrap:wrap; gap: 10px 18px; align-items: baseline; }
header h1 { font-size: 18px; margin:0; }
code, pre { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--card); border:1px solid var(--line); padding:10px; overflow:auto; max-height: 420px; }
.muted { color: var(--muted); }
.banners { padding: 0 20px; }
.banner { margin: 10px 0; padding: 8px 12px; border-left: 4px solid var(--warn); background: var(--card); }
.banner.bad { border-color: var(--bad); }
.banner.info { border-color: var(--info); }
main { display:grid; grid-template-columns: minmax(260px, 1fr) 2fr; gap: 20px; padding: 20px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 8px; }
.card { border:1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: var(--card); }
.card h3 { margin: 0 0 6px; font-size: 15px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.kind { font-size: 11px; padding: 1px 6px; border:1px solid var(--line); border-radius: 10px; color: var(--muted); }
.status { font-weight: 600; }
.status.pass { color: var(--ok); } .status.fail { color: var(--bad); } .status.error { color: var(--warn); } .status.none { color: var(--muted); }
.flag { font-size: 12px; color: var(--warn); }
.evidence img, .evidence video { max-width: 100%; border:1px solid var(--line); border-radius: 4px; display:block; margin: 8px 0; }
ul { margin: 6px 0; padding-left: 20px; }
details summary { cursor: pointer; color: var(--muted); }
footer { border-top: 1px solid var(--line); padding: 16px 20px; display:flex; flex-direction: column; gap: 10px; position: sticky; bottom:0; background: var(--bg); }
footer .row { display:flex; gap: 14px; flex-wrap: wrap; align-items: center; }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button[disabled] { opacity: .5; cursor: default; }
textarea { font: inherit; width: 100%; max-width: 640px; min-height: 60px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
label { display:inline-flex; gap: 6px; align-items: center; }
#result { font-weight: 600; }
.history li { margin: 2px 0; }
.brief { white-space: pre-wrap; }
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

  const banners: string[] = [];
  banners.push(`<div class="banner" id="preview-banner" hidden></div>`);
  if (b.preview?.moved) banners.push(`<div class="banner bad">The preview moved during capture. Every status is <b>error</b>; the artifacts are kept below but can't be trusted.</div>`);
  if (edited.length) {
    banners.push(
      `<div class="banner">✎ Criteria changed since the previous bundle: ${edited.map((id) => `<code>${esc(id)}</code>`).join(', ')} <details><summary>diff</summary><ul>${m.criteria_diff
        .map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.change)}${c.from ? `<br><span class="muted">from:</span> ${esc(c.from)}` : ''}${c.to ? `<br><span class="muted">to:</span> ${esc(c.to)}` : ''}</li>`)
        .join('')}</ul></details></div>`,
    );
  }
  if (prov !== 'true') banners.push(`<div class="banner info">Brief order: <b>${esc(prov)}</b>${b.brief.first_seen_sha ? ` · first seen at <code>${esc(String(b.brief.first_seen_sha).slice(0, 7))}</code>` : ''} (a heuristic, not proof)</div>`);
  if (d.head_sha && d.head_sha !== b.sha) banners.push(`<div class="banner">This bundle is for <code>${esc(shaShort)}</code>; the PR head is now <code>${esc(d.head_sha.slice(0, 7))}</code>.</div>`);
  if (eff && d.newer_bundle_exists) banners.push(`<div class="banner info">${esc(VERDICT_LABEL[eff.verdict])} on bundle <code>${esc(eff.bundle_id)}</code> · a newer capture exists for this SHA. The acceptance stands.</div>`);
  if (d.failed_deliveries.length) {
    banners.push(
      `<div class="banner bad">Some deliveries to GitHub gave up and need a human: <ul>${d.failed_deliveries
        .map((f) => `<li><code>${esc(f.effect)}</code> — ${esc(f.last_error ?? 'unknown error')}</li>`)
        .join('')}</ul></div>`,
    );
  }

  const criteriaHtml = crit
    .map((c) => {
      const bc = briefCriteria.get(c.id);
      const statusLabel =
        c.status === 'pass' ? 'Assertions passed' : c.status === 'fail' ? `Assertion failed${c.error ? ': ' + c.error : ''}` : c.status === 'error' ? `Couldn't complete${c.error ? ': ' + c.error : ''}` : 'No automated evidence';
      const ev = (c.evidence ?? [])
        .map((e) => {
          const url = `${d.bundle_base}/${e.path}`;
          const flags = [e.role === 'supporting' ? 'supporting' : '', e.artifact_changed ? 'artifact changed' : ''].filter(Boolean).join(' · ');
          let body = `<a href="${esc(url)}">${esc(e.path)}</a>`;
          if (e.type === 'image') body = `<a href="${esc(url)}"><img src="${esc(url)}" alt="${esc(e.path)}" loading="lazy"></a>`;
          else if (e.type === 'video') body = `<video src="${esc(url)}" controls preload="metadata"></video>`;
          return `<div class="evidence">${body}<div class="muted">${esc(e.path)}${flags ? ' · ' + esc(flags) : ''}</div></div>`;
        })
        .join('');
      return `<div class="card" id="c-${esc(c.id)}">
  <h3><code>${esc(c.id)}</code> ${esc(bc?.text ?? '')} <span class="kind">${esc(c.kind)}</span>${edited.includes(c.id) ? '<span class="flag">✎ criterion edited</span>' : ''}${c.spec?.changed ? '<span class="flag">spec changed</span>' : ''}</h3>
  <div class="status ${esc(c.status)}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'error' ? '⚠' : '·'} ${esc(statusLabel)}</div>
  ${c.assertions?.length ? `<details><summary>${c.assertions.length} assertion${c.assertions.length === 1 ? '' : 's'}</summary><ul>${c.assertions.map((a) => `<li><code>${esc(a)}</code></li>`).join('')}</ul></details>` : ''}
  ${c.spec?.source ? `<details><summary>spec${c.spec.files?.length ? ` (${c.spec.files.length} file${c.spec.files.length === 1 ? '' : 's'})` : ''}${c.spec.external_imports?.length ? ' · imports ' + esc(c.spec.external_imports.join(', ')) : ''}</summary><pre>${esc(c.spec.source)}</pre></details>` : ''}
  ${ev}
</div>`;
    })
    .join('\n');

  const notes = b.notes ?? {};
  const noteList = (title: string, items?: string[]) => (items && items.length ? `<h2>${esc(title)}</h2><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

  const history = d.verdicts.length
    ? `<section><h2>Verdicts on this PR</h2><ul class="history">${d.verdicts
        .slice()
        .reverse()
        .map((v) => `<li>#${v.seq} <b>${esc(VERDICT_LABEL[v.verdict])}</b> by @${esc(v.reviewer)} on <code>${esc(v.sha.slice(0, 7))}</code> · <code>${esc(v.bundle_id)}</code> · ${esc(v.at)}${v.on_behalf ? ' <span class="muted">(posted on behalf)</span>' : ''}</li>`)
        .join('')}</ul></section>`
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
    preview_url: b.preview?.url ?? null,
    can_review: d.can_review,
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
  <h1>#${d.number} ${esc(briefTitle(b.brief.text))}</h1>
  <span><code>${esc(shaShort)}</code> · bundle <code>${esc(b.bundle_id)}</code>${d.all_bundles_for_sha > 1 ? ` <span class="muted">(${d.all_bundles_for_sha} captures for this SHA; newest shown)</span>` : ''}</span>
  <span class="muted">prev: ${m.previous ? `${esc(m.previous.verdict ?? 'no verdict')} on <code>${esc(m.previous.sha.slice(0, 7))}</code>` : 'none'}</span>
  ${eff ? `<span>effective: <b>${esc(VERDICT_LABEL[eff.verdict])}</b> by @${esc(eff.reviewer)}</span>` : '<span class="muted">no verdict for this SHA</span>'}
  ${b.preview?.url ? `<a href="${esc(b.preview.url)}" target="_blank" rel="noopener">Preview ↗</a>` : ''}
  <span class="muted">signed in as @${esc(d.viewer)}</span>
</header>
<div class="banners">${banners.join('\n')}</div>
<main>
  <section>
    <h2>Brief</h2>
    <div class="card brief">${esc(b.brief.text)}</div>
    ${noteList('Agent says it did', notes.did)}
    ${noteList("Didn't", notes.didnt)}
    ${noteList('Unsure', notes.unsure)}
    ${m.rubric.hits.length ? `<h2>Rubric${b.diff?.areas?.length ? ` (${esc(b.diff.areas.join(', '))})` : ''}</h2><ul>${m.rubric.hits.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    ${b.diff ? `<h2>Diff</h2><div class="muted">${b.diff.files ?? '?'} files, +${b.diff.additions ?? '?'} −${b.diff.deletions ?? '?'} · code review is separate · <a href="https://github.com/${esc(d.owner)}/${esc(d.repo)}/pull/${d.number}/files" target="_blank" rel="noopener">open on GitHub</a></div>` : ''}
    ${b.runner ? `<h2>Runner</h2><div class="muted"><code>${esc(b.runner)}</code></div>` : ''}
    ${history}
  </section>
  <section>
    <h2>Criteria</h2>
    ${criteriaHtml || '<div class="muted">No criteria in this bundle.</div>'}
  </section>
</main>
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
  ${d.can_review ? '' : `<div class="muted">You can read this bundle but aren't on the reviewer list for this repo, so the verdict controls are hidden.</div>`}
  <div id="result" aria-live="polite"></div>
</footer>
<script>
const S = ${jsonForScript(pageState)};
(function () {
  const banner = document.getElementById('preview-banner');
  async function poll() {
    if (!S.preview_url) return;
    try {
      const r = await fetch(S.preview_url.replace(/\\/$/, '') + '/__dub/version', { cache: 'no-store' });
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

  const form = document.getElementById('verdict');
  const result = document.getElementById('result');
  if (!S.can_review) return;
  for (const btn of form.querySelectorAll('button[data-verdict]')) {
    btn.addEventListener('click', async () => {
      const vals = (n) => Array.from(form.querySelectorAll('input[name="' + n + '"]:checked')).map((i) => i.value);
      const body = {
        owner: S.owner, repo: S.repo, pr: S.pr, sha: S.sha, bundle_id: S.bundle_id,
        verdict: btn.dataset.verdict,
        note: form.note.value,
        suggest_rule: form.suggest_rule.checked,
        used: vals('used'), because: vals('because'),
      };
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      result.textContent = 'Recording…';
      try {
        const r = await fetch('/api/verdicts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        let msg = 'Recorded ' + btn.dataset.verdict + ' for ' + S.sha.slice(0, 7) + ' (seq ' + j.seq + ').';
        if (j.historical) msg += ' The PR has moved on to ' + j.head_sha.slice(0, 7) + ', which has no verdict yet.';
        if (j.review === 'on_behalf_pending') msg += ' Your GitHub token could not post the review; Dub will post it on your behalf.';
        result.textContent = msg;
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main style="display:block;max-width:720px"><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
