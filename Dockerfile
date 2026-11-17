# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.34.9
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/panel/package.json apps/panel/
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/media && chown -R node:node /data
ENV MEDIA_DIR=/data/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Si la plataforma arranca como root (Railway monta los volúmenes como root), se arreglan los permisos de /data
# y el servidor igual corre como el usuario node.
CMD ["sh", "-c", "cd apps/server && node_modules/.bin/prisma migrate deploy && node dist/cli.js seed && if [ \"$(id -u)\" = 0 ]; then chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node dist/main.js; else exec node dist/main.js; fi"]
