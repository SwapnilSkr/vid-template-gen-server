# ===========================================
# Multi-stage Dockerfile for Video Generator
# glibc (debian-slim) base — avoids musl breakage with the
# native @resvg/resvg-js addon.
# ===========================================

# Stage 1: deps + caption fonts (no manual `bun run fetch-fonts` needed)
FROM oven/bun:1-slim AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# fonts.ts + fetch-fonts.ts are enough to download TTFs into assets/fonts.
# Existing local assets/fonts (if any) are copied first and skipped by the script.
COPY src ./src
COPY scripts ./scripts
COPY assets ./assets
RUN FETCH_FONTS_STRICT=1 bun run scripts/fetch-fonts.ts

# Stage 2: Production
FROM oven/bun:1-slim AS runner

# System deps:
#  - ffmpeg / ffprobe: video pipeline
#  - fontconfig + fonts: REQUIRED by resvg (reddit-card) and drawtext.
#    fonts-liberation gives a metric-compatible "Arial"; dejavu is a
#    broad unicode fallback so text never renders as tofu.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      fonts-liberation \
      fonts-dejavu-core \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -M -s /usr/sbin/nologin vidgen

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/assets ./assets
COPY package.json ./
COPY src ./src

RUN mkdir -p storage/templates storage/characters storage/processing \
             storage/output storage/gameplay \
    && chown -R vidgen:nodejs /app

USER vidgen

EXPOSE 3000

# Healthcheck via bun (no wget dependency on slim base)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_PATH=/app/storage \
    PROCESSING_PATH=/app/storage/processing \
    GAMEPLAY_DIR=/app/storage/gameplay \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

CMD ["bun", "run", "src/index.ts"]
