# ─── Build Stage ─────────────────────────────────────────────────────────────
# We use a multi-stage build to keep the production image small.
# The build stage installs all dependencies (including devDependencies)
# and compiles TypeScript. The production stage only copies the compiled
# JS and production dependencies.

FROM node:22-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching.
# Dependencies change less often than source code, so this layer
# gets cached across most builds.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production Stage ────────────────────────────────────────────────────────
# Slim image with only what we need to run the server.
# No TypeScript compiler, no devDependencies, no source maps.

FROM node:22-slim AS production

WORKDIR /app

# Security: run as non-root user
RUN groupadd -r bastion && useradd -r -g bastion bastion

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from the build stage
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER bastion

# The server listens on this port (configurable via PORT env var)
EXPOSE 3001

# Health check — Caddy or your load balancer can also use this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# Start the MCP server in HTTP mode
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=3001

CMD ["node", "dist/index.js"]
