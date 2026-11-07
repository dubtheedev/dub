# Dub Worker

The review Worker, one Durable Object per pull request, and a placeholder
review page. The contract it implements is `../docs/contract.md`; setting it up
is `../docs/setup.md`.

```
src/index.ts        router: intake (OIDC), serving (access-checked), verdicts, webhooks, App OAuth, dub pr
src/do/pr.ts        the PullRequest Durable Object: verdict events, delivery state, alarm reconciler
src/lib/verdicts.ts effective verdict, close eligibility, backoff, review and sticky bodies   (pure)
src/lib/meta.ts     previous, criteria_diff, rubric hits                                      (pure)
src/lib/config.ts   .dub/config.yml and areas.yml                                             (pure)
src/lib/github.ts   App JWT, installation tokens, REST helpers
src/lib/oidc.ts     GitHub Actions OIDC verification
src/lib/tar.ts      minimal ustar reader for evidence.tar
src/lib/session.ts  signed cookie sessions and CLI tokens
src/lib/oauth.ts    signed OAuth state bound to a nonce cookie
src/page/           the placeholder review page (Ryan's replaces it)
```

```sh
npm install --legacy-peer-deps   # vitest 5 + @cloudflare/vitest-plugin need the flag
npm run typecheck
npm test                          # runs inside workerd via @cloudflare/vitest-plugin
npx wrangler dev
```

Tests swap `globalThis.fetch` for a fake GitHub (`test/fake-github.ts`); the
Worker and the Durable Object run in the test isolate, so no network is needed.
