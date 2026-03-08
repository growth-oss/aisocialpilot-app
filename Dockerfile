FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Install Node.js server dependencies
COPY package.json .
RUN npm install --production

# Install Claude Code CLI (the automation brain)
RUN npm install -g @anthropic-ai/claude-code

# Install VNC + virtual display for live browser viewing in admin panel
RUN apt-get update && apt-get install -y \
  xvfb \
  x11vnc \
  novnc \
  websockify \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Copy application code
COPY server/ server/
COPY admin/ admin/
COPY .claude/ .claude/
COPY templates/ templates/
COPY config/ config/
COPY scripts/ scripts/
RUN chmod +x scripts/start.sh

# Create data directory (overridden by volume mount in production)
RUN mkdir -p /app/data/clients /app/data/logs

# Environment
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV RAILWAY_RUN_UID=0
ENV DISPLAY=:99

# Expose the admin panel port (VNC proxied through this via /vnc/)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD curl -f http://localhost:3000/api/status || exit 1

# Start Xvfb + VNC + noVNC + Express
CMD ["bash", "scripts/start.sh"]
