# The board, in one image.
#
# Multi-stage so the runtime layer carries no pnpm store, no TypeScript and no
# dev dependencies - just Node, two document converters and the built output.

FROM node:24-slim AS build
WORKDIR /app

# pnpm comes from corepack rather than npm install, so the version in
# packageManager is the version that runs.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY myna-plugin/package.json ./myna-plugin/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# A second install, production only, so node_modules can be copied across
# without the toolchain. Done after the build because the build needs tsc.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Resume imports shell out to these. Without them the board still runs and
# refuses PDFs with a sentence telling the person what to upload instead - but
# an installer that leaves a documented feature broken is not an installer.
#   poppler-utils -> pdftotext, for PDF resumes
#   pandoc        -> .doc, .odt, .rtf
RUN apt-get update \
 && apt-get install --no-install-recommends -y poppler-utils pandoc ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY bin ./bin
COPY migrations ./migrations
COPY docs ./docs
COPY web/public ./web/public

# Run unprivileged. The image needs no write access to anything but /tmp,
# which is where document conversion stages its files.
USER node

EXPOSE 8787
ENV PORT=8787

# Migrations run at boot inside an advisory lock, so scaling to several
# replicas is safe: the extra copies wait rather than race.
CMD ["node", "dist/cli/index.js", "serve"]
