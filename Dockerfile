# ---- Build stage: compile TypeScript to dist/ ----
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (incl. dev) using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies only (none at runtime, but keep it clean).
RUN npm prune --omit=dev

# ---- Runtime stage: minimal, non-root ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy only what the server needs to run.
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

# Writable data/log dirs owned by the non-root user.
RUN mkdir -p /app/data /app/logs \
  && chown -R node:node /app

# Drop privileges — never run as root.
USER node

EXPOSE 9797
ENV PORT=9797 \
    LOG_DIR=/app/logs

# Simple healthcheck against the public auth status endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9797)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
