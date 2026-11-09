# The Quintara API. Build from the repository root:  docker build -f apps/api/Dockerfile -t quintara-api .
# Node runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:22-slim
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /app
RUN corepack enable
# Dependencies first, so they are cached between builds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/api-client/package.json packages/api-client/
# Behind a TLS-inspecting proxy, pass its CA as a build secret:  --secret id=extra_ca,src=/path/to/ca.pem
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prod --filter "@quintara/api..." && pnpm store prune
COPY db db
COPY packages/domain packages/domain
COPY packages/api-client packages/api-client
COPY apps/api/src apps/api/src
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/apps/api
# Migrations are run as a separate release step:  node --experimental-strip-types src/migrate-cli.ts
CMD ["node", "--experimental-strip-types", "src/server.ts"]
