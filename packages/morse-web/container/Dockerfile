# Multi-stage build for Morse (server mode, multi-user).
#
# Layout: `base → toolchain → engines → setup → runtime`.
#
# - `toolchain` downloads the checksum-verified ezx supervisor (needed only at
#   run time, so it lives here — an EZX_VERSION bump is a curl-sized layer).
# - `engines` installs the pinned agent engines: pi (npm) and OpenCode
#   (release tarball, checksum-verified). Engine bumps never invalidate the
#   source build below.
# - `setup` builds Morse from source (libraries, Angular UI, server bundle).
#   Its cache key is the app version plus manifests — the things that genuinely
#   require recompiling.
# - `runtime` keeps node, ezx, the engines, the server bundle and the UI, and
#   the ezx bootstrap entrypoint. No build tools, no source, no morse CLI:
#   this image only serves (`server mode only`).
#
# Methodology follows containers/container-scripts (forge+ezx, env-driven,
# supervised, non-root app user). The one deviation: the setup stage runs npm
# instead of `forge build` — forge has no npm component yet.
# syntax=docker/dockerfile:1.6
FROM debian:bookworm-slim AS base

ARG NODE_VERSION=v22.23.5
ARG EZX_VERSION=0.8.1
ARG PI_VERSION=1.6.1
ARG OPENCODE_VERSION=v1.19.6
ARG TARGETARCH

# Build metadata
ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.created=$BUILD_DATE \
    org.opencontainers.image.revision=$VCS_REF \
    org.opencontainers.image.title="Morse" \
    org.opencontainers.image.description="Comfortable Pi Interface in your browser: multi-user NestJS host with pi and OpenCode engines" \
    org.opencontainers.image.authors="Supan Adit Pratama <email@supanadit.com>" \
    org.opencontainers.image.source=https://github.com/supanadit/morse

ENV NODE_VERSION=${NODE_VERSION} \
    MORSE_HOME=/opt/containers/data \
    MORSE_HOST=0.0.0.0 \
    MORSE_PORT=4399 \
    MORSE_MULTIUSER=1 \
    MORSE_WORKSPACE_ROOT=/workspaces \
    PATH=/opt/node/bin:/opt/engines/bin:/usr/local/bin:/usr/bin:/bin

# ---------------------------------------------------------------------------
# Toolchain layer — node (checksum-verified tarball) and the ezx supervisor
# (checksum-verified release binary). Keyed only on versions + TARGETARCH.
# ---------------------------------------------------------------------------
FROM base AS toolchain

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node: amd64/x64 and arm64 artefacts live under different names.
RUN set -e; \
    if [ "${TARGETARCH}" = "arm64" ]; then NODE_ARCH=arm64; NODE_SHA=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09; \
    else NODE_ARCH=x64; NODE_SHA=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8; fi; \
    curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz; \
    echo "${NODE_SHA}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm /tmp/node.tar.xz

# ezx: the PID 1 supervisor. Runtime-only, so it stays out of the build stage.
RUN set -e; \
    if [ "${TARGETARCH}" = "arm64" ]; then EZX_SHA=8635028a01ead2ae34d9ee2cc741beb4a7331d994f1791910e25daf154f3f250; \
    else EZX_SHA=7fc4c00309b70b2b8db375903b5d1d5e77376cb4aee041b8e56ddbf652230354; fi; \
    curl -fsSL https://github.com/supanadit/ezx/releases/download/${EZX_VERSION}/ezx-${EZX_VERSION}-linux-${TARGETARCH} -o /tmp/ezx; \
    echo "${EZX_SHA}  /tmp/ezx" | sha256sum -c -; \
    mv /tmp/ezx /usr/local/bin/ezx && chmod +x /usr/local/bin/ezx

# ---------------------------------------------------------------------------
# Engines layer — pinned pi (npm) and OpenCode (release tarball). Engine bumps
# rebuild this layer only, never the source build.
# ---------------------------------------------------------------------------
FROM toolchain AS engines

RUN set -e; \
    if [ "${TARGETARCH}" = "arm64" ]; then OC_ARCH=arm64; OC_SHA=5b68c1f4c5e75b4134e664cc8f36d634d64208d4fcfe5bcf3b48bab699c2dbac; \
    else OC_ARCH=x64; OC_SHA=47734e08968b30cc22a0bffb6d9feeed76ad4aa743213a12122040392d09a057; fi; \
    mkdir -p /opt/engines; \
    npm install --prefix /opt/engines -g @earendil-works/pi-coding-agent@${PI_VERSION}; \
    curl -fsSL https://github.com/sst/opencode/releases/download/${OPENCODE_VERSION}/opencode-linux-${OC_ARCH}.tar.gz -o /tmp/opencode.tar.gz; \
    echo "${OC_SHA}  /tmp/opencode.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/engines/opencode && tar -xzf /tmp/opencode.tar.gz -C /opt/engines/opencode; \
    rm /tmp/opencode.tar.gz; \
    ln -s /opt/engines/opencode/opencode /opt/engines/bin/opencode
ENV PATH=/opt/engines/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin

# ---------------------------------------------------------------------------
# Setup layer — build Morse from source. Cache key: manifests + source.
# ---------------------------------------------------------------------------
FROM engines AS setup

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/engine-config/package.json packages/engine-config/
COPY packages/extension/package.json packages/extension/
COPY packages/integration-opencode/package.json packages/integration-opencode/
COPY packages/integration-pi/package.json packages/integration-pi/
COPY packages/morse-web/package.json packages/morse-web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/system/package.json packages/system/
COPY packages/ui-angular/package.json packages/ui-angular/
COPY packages/ui-runtime/package.json packages/ui-runtime/
# npm's download cache survives rebuilds, so a manifest-only change refetches
# just the delta instead of the whole tree.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Cache contract: only a manifest/lock change may rerun `npm ci`, and only a
# source change in a package may rebuild that package. Layer order is
# least-volatile first — editing the UI never rebuilds the libraries, editing
# the server never rebuilds the UI, and editing the entrypoint never touches
# this stage at all (entrypoint.d is copied in the runtime stage instead).
COPY packages/agent packages/agent/
COPY packages/protocol packages/protocol/
COPY packages/engine-config packages/engine-config/
COPY packages/ui-runtime packages/ui-runtime/
RUN npm run build -w @morse/protocol && npm run build -w @morse/agent && npm run build -w @morse/engine-config && npm run build -w @morse/ui-runtime
COPY packages/system packages/system/
RUN npm run build -w @morse/system
COPY packages/integration-pi packages/integration-pi/
COPY packages/integration-opencode packages/integration-opencode/
RUN npm run build -w @morse/integration-pi && npm run build -w @morse/integration-opencode
# The UI needs only the libraries above; ng's own cache survives rebuilds, so
# a template-only edit recompiles incrementally instead of from scratch.
COPY packages/ui-angular packages/ui-angular/
RUN --mount=type=cache,target=/src/packages/ui-angular/.angular npm run build:ui
# The bundle needs the built UI plus server sources — nothing else.
COPY packages/server packages/server/
COPY packages/morse-web/build.mjs packages/morse-web/package.json packages/morse-web/
RUN node packages/morse-web/build.mjs --server --ui

# ---------------------------------------------------------------------------
# Runtime layer — node, ezx, engines, the server bundle and the UI. No build
# tools, no source, no morse CLI: server mode only.
# ---------------------------------------------------------------------------
FROM toolchain AS runtime

COPY --from=engines /opt/engines /opt/engines
COPY --from=setup /src/packages/morse-web/dist/server.mjs /opt/morse/server.mjs
COPY --from=setup /src/packages/morse-web/dist/ui /opt/morse/ui
# Production dependencies of the server bundle (external to the esbuild
# bundle), resolved from the workspace lockfile — never hand-pinned here.
# Keyed on manifests only, so source edits never reinstall them.
COPY package.json package-lock.json /tmp/rt/
COPY packages/morse-web/package.json /tmp/rt/packages/morse-web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefix /tmp/rt --workspace @supanadit/morse-web --no-audit --no-fund \
    && mkdir -p /opt/morse/node_modules \
    && cp -r /tmp/rt/node_modules/. /opt/morse/node_modules/ \
    && rm -rf /tmp/rt
COPY packages/morse-web/container/entrypoint.d /opt/morse/entrypoint.d

# The application user: ezx stays PID 1 and drops privileges per node, so the
# server (and every engine it spawns) never runs as root. `/home` is a symlink
# into the single workspaces volume: every login user is also a Linux user
# whose home is `/home/<username>`, so one volume carries all trees and
# `MORSE_WORKSPACE_ROOT` needs no second mount.
RUN apt-get update && apt-get install -y --no-install-recommends passwd openssh-server sudo zsh && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspaces \
    && rm -rf /home \
    && ln -s /workspaces /home \
    && /usr/sbin/useradd --system --create-home --home-dir /home/morse --shell /usr/sbin/nologin morse \
    && printf '%s\n' 'morse ALL=(root) NOPASSWD: /usr/sbin/useradd, /usr/sbin/usermod, /usr/sbin/chpasswd, /usr/sbin/userdel, /usr/bin/chown, /usr/bin/chmod, /usr/bin/cp' > /etc/sudoers.d/morse-os-users \
    && chmod 0440 /etc/sudoers.d/morse-os-users \
    && sed -i 's/^#\?UMASK.*/UMASK\t002/' /etc/login.defs \
    && mkdir -p /opt/containers/data /opt/containers/config /opt/containers/logs /opt/containers/run /opt/containers/backup /workspaces \
    && chown -R morse:morse /opt/containers /workspaces /opt/morse
# Seeded only when the user has none — afterwards it is theirs to rewrite.
COPY packages/morse-web/container/skel/.zshrc /etc/skel/.zshrc

ENV MORSE_HOME=/opt/containers/data \
    MORSE_UI_DIR=/opt/morse/ui \
    HOME=/home/morse \
    USER=morse \
    MORSE_HOST=0.0.0.0 \
    MORSE_PORT=4399 \
    MORSE_MULTIUSER=1 \
    MORSE_OS_USERS=1 \
    MORSE_SSH_PORT=2222 \
    SHELL=/bin/zsh \
    MORSE_WORKSPACE_ROOT=/workspaces \
    MORSE_PI_PATH=/opt/engines/bin/pi \
    MORSE_OPENCODE_BIN=/opt/engines/opencode/opencode \
    MORSE_OPENCODE_URL=http://127.0.0.1:4096 \
    PATH=/opt/engines/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin

EXPOSE 4399 2222

ENTRYPOINT ["ezx", "bootstrap", "/opt/morse/entrypoint.d/bootstrap/main.js"]
