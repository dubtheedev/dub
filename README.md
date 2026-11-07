# Dub

*"I dub thee merged."* Product acceptance for agent-written work: every change
arrives as a **dub request** (the brief, evidence against each acceptance
criterion, a live preview, the diff), and a human decides **Dub it**, **Revise**
or **Reject** from a review page. The verdict lands on the PR as a `dubbed`
commit status and a COMMENT review. Code review stays a separate gate.

## Layout

```
cmd/dub/       Go CLI: init, pack, publish, pr, login
internal/      brief, inline, provenance, preview, runner, bundle, publish, gh
runner/        ghcr.io/dubtheedev/runner — the Playwright harness image
worker/        Cloudflare Worker + one Durable Object per PR
skill/dub/     Claude Code skill for agents writing briefs and evidence specs
docs/          spec, feedback, the build contract, setup
```

## Build

```
make build          # dist/dub
make test           # go vet + go test
make runner         # docker build the runner image locally
cd worker && npm install && npm test
```

`docs/contract.md` is what the code does where the spec and its feedback had to
be reconciled; it wins over `docs/spec-v0.3.md`. `docs/setup.md` is the
one-time setup: the GitHub App, the Worker secrets, branch protection.
