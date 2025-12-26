# ===========================================
# Multi-stage Dockerfile for Video Generator
# ===========================================

# Stage 1: Build stage
FROM oven/bun:1.1-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Stage 2: Production stage
FROM oven/bun:1.1-alpine AS runner

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S vidgen -u 1001

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src

# Create storage directories
RUN mkdir -p storage/templates storage/characters storage/processing storage/output && \
    chown -R vidgen:nodejs /app

# Switch to non-root user
USER vidgen

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV STORAGE_PATH=/app/storage
ENV TEMPLATES_PATH=/app/storage/templates
ENV CHARACTERS_PATH=/app/storage/characters
ENV PROCESSING_PATH=/app/storage/processing
ENV OUTPUT_PATH=/app/storage/output
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

# Start the server
CMD ["bun", "run", "src/index.ts"]
