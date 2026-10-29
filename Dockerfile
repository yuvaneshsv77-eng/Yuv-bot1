FROM node:24-slim

# better-sqlite3 needs build tools to compile its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Persistent volume mount point for the SQLite database (see src/db.js,
# configurable via DB_PATH). Mount a real volume at /app/data on your
# host/platform so the database survives redeploys.
VOLUME ["/app/data"]
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
