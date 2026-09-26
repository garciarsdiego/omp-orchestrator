# Linux x86_64 only. The OMP binary is fetched from its release URL and its
# published SHA-256 is checked before it is placed on PATH.
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

ARG OMP_VERSION=18.3.2
ARG OMP_LINUX_X64_SHA256=8cbbcd4bea7a7b86116a13352f31e3778fd4d93df931036bb1771738b0702534

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && curl --fail --location --silent --show-error \
    --output /usr/local/bin/omp \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
  && echo "${OMP_LINUX_X64_SHA256}  /usr/local/bin/omp" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/omp

WORKDIR /opt/omp-orchestrator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . ./

RUN mkdir -p /var/lib/omp-orchestrator /workspaces /run/omp-orchestrator \
  && chown -R node:node /opt/omp-orchestrator /var/lib/omp-orchestrator /workspaces /run/omp-orchestrator

ENV NODE_ENV=production \
  HOME=/var/lib/omp-orchestrator \
  OMP_ORCHESTRATOR_STATE_DIR=/var/lib/omp-orchestrator/state \
  OMP_ORCHESTRATOR_BIND=0.0.0.0 \
  OMP_ORCHESTRATOR_PORT=8080

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/omp-orchestrator.mjs", "serve", "--bind", "0.0.0.0", "--port", "8080"]
