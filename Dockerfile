# The board, in one image.
#
# Multi-stage so the runtime layer carries no pnpm store, no TypeScript and no
# dev dependencies - just Bun, three document converters and the built output.

FROM node:24-slim AS build
WORKDIR /app

# pnpm asks before purging node_modules and refuses when there is no TTY, which
# is every image build. Without this the production install step fails with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and nothing else explains why.
ENV CI=true

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


# The runtime is Bun, not Node. Bun runs the same tsc output (dist/) and the
# same pnpm node_modules; only the process that executes them changes. The
# build stage above stays on Node + pnpm because the npm package still targets
# Node 24 (engines, bin shebangs), and self-hosters run it that way.
#
# Debian 12 (bookworm) is deliberate: it is what node:24-slim was, so pandoc,
# weasyprint and poppler are the exact versions resumes were converted with
# before (oven/bun:*-slim is Debian 13, which moves all three).
FROM oven/bun:1.4.0-slim AS bun

FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Resume imports shell out to these. Without them the board still runs and
# refuses PDFs with a sentence telling the person what to upload instead - but
# an installer that leaves a documented feature broken is not an installer.
#   poppler-utils -> pdftotext, for PDF resumes
#   pandoc        -> .doc, .odt, .rtf in, and .docx out
#   weasyprint    -> the PDF of a resume, rendered from our own HTML and CSS so
#                    the file and the page are the same document. A browser
#                    would render it too and would add ~350MB to this image for
#                    one button, so the export CSS is written for a print
#                    engine instead.
RUN apt-get update \
 && apt-get install --no-install-recommends -y poppler-utils pandoc weasyprint ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 bun \
 && useradd --uid 1000 --gid bun --home-dir /home/bun --create-home --shell /usr/sbin/nologin bun

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY --chown=bun:bun --from=build /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun --from=build /app/package.json ./package.json
COPY --chown=bun:bun bin ./bin
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun docs ./docs
COPY --chown=bun:bun web/public ./web/public

# Run unprivileged (uid 1000, the same uid `node` had). The image needs no
# write access to anything but /tmp, which is where document conversion stages
# its files. The COPYs above are --chown because COPY keeps the build context's
# file modes: a checkout made under a restrictive umask (0660 files, as on
# dev2) is unreadable by the app user once root owns it, and the process dies
# at boot. Railway's builder happened to hand us 0644.
USER bun

EXPOSE 8787
ENV PORT=8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/stats').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# Migrations run at boot inside an advisory lock, so scaling to several
# replicas is safe: the extra copies wait rather than race. The CLI inside the
# container is `bun dist/cli/index.js <command>` (there is no node here).
CMD ["bun", "dist/cli/index.js", "serve"]
