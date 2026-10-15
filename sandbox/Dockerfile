FROM golang:1.27-bookworm AS go
FROM node:24-bookworm-slim
# Keep registry transfers in modest layers while retaining the complete toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs ca-certificates curl ripgrep unzip && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10 @jdxcode/mise@2026.10.9 && corepack enable yarn
# Agents run unprivileged; mise installs whatever runtime a repository declares into their home, first on PATH.
ENV MISE_DATA_DIR=/home/node/.local/share/mise MISE_CONFIG_DIR=/home/node/.config/mise MISE_CACHE_DIR=/home/node/.cache/mise \
    MISE_TRUSTED_CONFIG_PATHS=/workspace MISE_YES=1 MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node,python,go,ruby,java,bun,deno \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH=/home/node/.local/share/mise/shims:/home/node/.local/bin:/home/node/.cargo/bin:/opt/braid/go/bin:$PATH
COPY --from=go /usr/local/go /opt/braid/go
COPY public/cli/braid.mjs /opt/braid/braid.mjs
COPY sandbox/collect.mjs /opt/braid/collect.mjs
COPY sandbox/askpass.sh /opt/braid/askpass.sh
RUN mkdir -p /workspace && chown node:node /workspace && chmod +x /opt/braid/askpass.sh && chmod -R a-w /opt/braid
WORKDIR /workspace
CMD ["sleep", "infinity"]
