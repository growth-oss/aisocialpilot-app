FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# ── Slow, rarely-changing layers first (maximise Docker cache reuse) ──────────

# System packages — only rebuilds if this list changes
RUN apt-get update && apt-get install -y \
  xvfb \
  x11vnc \
  novnc \
  websockify \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — only rebuilds if you bump the version
RUN npm install -g @anthropic-ai/claude-code

# Non-root user for Claude CLI (Claude Code 2.x blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude_runner && \
    mkdir -p /home/claude_runner/.claude

# ── App dependencies — rebuilds only when package.json changes ────────────────

COPY package.json .
RUN npm install --production

# ── Application code — rebuilds on every code push (fast, no installs) ────────

COPY server/ server/
COPY admin/ admin/
COPY .claude/ .claude/
COPY scripts/ scripts/
RUN chmod +x scripts/start.sh

# Create data directory (overridden by volume mount in production)
RUN mkdir -p /app/data/clients /app/data/logs

# ── Environment ───────────────────────────────────────────────────────────────

# Skip browser download — browsers already installed in the base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV RAILWAY_RUN_UID=0
ENV DISPLAY=:99

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD curl -f http://localhost:3000/api/status || exit 1

CMD ["bash", "scripts/start.sh"]
