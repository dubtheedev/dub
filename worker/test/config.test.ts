import { describe, expect, it } from 'vitest';
import { parseAreas, parseConfig, parseSimpleYaml } from '../src/lib/config';

describe('parseSimpleYaml', () => {
  it('handles scalars, inline lists and block lists, ignoring comments', () => {
    expect(
      parseSimpleYaml(`# top\nbase: main   # trailing\nreviewers: [ryanwsnow, "amackera"]\nareas:\n  - 'a'\n  - b\nempty: []\n`),
    ).toEqual({ base: 'main', reviewers: ['ryanwsnow', 'amackera'], areas: ['a', 'b'], empty: [] });
  });
});

describe('parseConfig', () => {
  it('defaults and lowercases reviewers', () => {
    expect(parseConfig(null)).toEqual({ reviewers: [], base: 'main', preview_origin_allowlist: [], close_on_reject: true, publish_workflow: null, allow_self_review: false });
    expect(parseConfig('reviewers: [@RyanWSnow]\nbase: trunk\n')).toMatchObject({ reviewers: ['ryanwsnow'], base: 'trunk', preview_origin_allowlist: [] });
  });
  it('reads allow_self_review', () => {
    expect(parseConfig('allow_self_review: true\n')).toMatchObject({ allow_self_review: true });
    expect(parseConfig('allow_self_review: no\n')).toMatchObject({ allow_self_review: false });
  });
  it('reads close_on_reject and publish_workflow', () => {
    expect(parseConfig('close_on_reject: false\npublish_workflow: .github/workflows/review-app.yml\n')).toMatchObject({ close_on_reject: false, publish_workflow: 'review-app.yml' });
    expect(parseConfig('close_on_reject: yes\npublish_workflow: review-app.yml\n')).toMatchObject({ close_on_reject: true, publish_workflow: 'review-app.yml' });
  });
});

describe('parseAreas', () => {
  it('maps area names to globs', () => {
    expect(parseAreas('email:\n  - lib/missive/mailer/**\n  - lib/missive_web/emails/**\ninvoices: [lib/missive/invoices/**]\n')).toEqual({
      email: ['lib/missive/mailer/**', 'lib/missive_web/emails/**'],
      invoices: ['lib/missive/invoices/**'],
    });
  });
});
