# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY tsconfig.json ./
COPY src ./src
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN command -v flock >/dev/null 2>&1 || apk add --no-cache util-linux
COPY --chmod=0644 package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --strict-ssl=true && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
RUN chmod -R a+rX /app/scripts && \
    mkdir -p /app/uploads/documents /var/lib/financio-trust-automation && \
    chown -R node:node /app/uploads /var/lib/financio-trust-automation && \
    chmod 0700 /var/lib/financio-trust-automation
USER node
EXPOSE 4000
CMD ["/bin/sh", "/app/scripts/start.sh"]
