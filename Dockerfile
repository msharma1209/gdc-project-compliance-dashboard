# ── GDC Compliance Dashboard ──────────────────────────────────────────────────
# Minimal Node.js image — no npm install needed (zero external dependencies).
# Build:  docker build -t gdc-dashboard .
# Run:    docker run -p 3500:3500 \
#           -e SF_TOKEN=<token> \
#           -e SF_INSTANCE=https://infa.my.salesforce.com \
#           -e ADMIN_PASSWORD=<pwd> \
#           -e CANVAS_PASSWORD=<pwd> \
#           gdc-dashboard

FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy only what's needed (no node_modules — zero dependencies)
COPY package.json ./
COPY server.js    ./
COPY public/      ./public/

# Expose the port the app listens on (default 3500, overridden by PORT env var)
EXPOSE 3500

# Environment variable defaults (override at runtime)
ENV NODE_ENV=production \
    PORT=3500 \
    SF_INSTANCE=https://infa.my.salesforce.com

# Start the server
CMD ["node", "server.js"]
