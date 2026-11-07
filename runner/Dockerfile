# ghcr.io/dubtheedev/runner — runs .dub/evidence/*.spec.ts against a preview.
#
# Invoked by `dub pack` (see docs/contract.md § Runner interface):
#   -v <repo>/.dub:/work/.dub:ro  -v <out>:/out
#   -e DUB_PREVIEW_URL -e DUB_SHA -e DUB_CRITERIA
#
# Specs resolve `@dub/test` and `@playwright/test` through /work/node_modules,
# a symlink to this image's own install, so the host repo never needs either.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /runner
COPY package.json package-lock.json tsconfig.json ./
COPY dub-test ./dub-test
RUN npm ci --omit=dev && npm cache clean --force

COPY playwright.config.ts reporter.ts ./

RUN mkdir -p /work /out && ln -s /runner/node_modules /work/node_modules

ENV DUB_OUT=/out
ENV CI=1
WORKDIR /runner
# Playwright exits 1 on any failed test; results.json is the real answer, and
# the CLI reads it regardless.
ENTRYPOINT ["npx", "playwright", "test", "--config", "/runner/playwright.config.ts"]
