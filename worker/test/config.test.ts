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
    expect(parseConfig(null)).toEqual({ reviewers: [], base: 'main', preview_origin_allowlist: [] });
    expect(parseConfig('reviewers: [@RyanWSnow]\nbase: trunk\n')).toEqual({ reviewers: ['ryanwsnow'], base: 'trunk', preview_origin_allowlist: [] });
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
