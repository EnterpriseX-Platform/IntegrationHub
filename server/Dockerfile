# Multi-stage build for Production
FROM node:18-slim AS builder

# Install build dependencies for Prisma
# python3/make/g++ let native modules (sqlite3) compile from source when their
# prebuilt binary can't be downloaded from GitHub (happens on the build host)
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including dev dependencies)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-slim AS production

# Install runtime dependencies for Prisma, networking, and PDF text extraction.
# poppler-utils provides pdftotext, used by the OCR executor to read the text
# layer out of ABBYY's PDF output (and out of input PDFs that are already
# searchable, which ABBYY returns unchanged).
RUN apt-get update && apt-get install -y --no-install-recommends openssl netcat-openbsd poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies
# Install only production dependencies. Build tools are installed for the
# native-module fallback build and removed again in the same layer.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    npm ci --omit=dev && npm cache clean --force && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Generate Prisma client for production
RUN npx prisma generate

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Copy startup script
COPY scripts/docker-startup.sh /app/docker-startup.sh
RUN chmod +x /app/docker-startup.sh

# Create data directories with proper permissions
RUN mkdir -p /data/basket /data/baskets /data/uploads /data/temp /data/logs /data/duckdb && \
    chown -R nodejs:nodejs /data && \
    chmod -R 775 /data

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose application port (configurable via PORT env)
EXPOSE ${PORT:-8137}

# Health check (uses PORT env variable, default 8137; 127.0.0.1 to avoid IPv6)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "const p=process.env.PORT||8137;require('http').get('http://127.0.0.1:'+p+'/health',(r)=>r.statusCode===200?process.exit(0):process.exit(1))"

# Start the application using startup script
CMD ["/app/docker-startup.sh"]
