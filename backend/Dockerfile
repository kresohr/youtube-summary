FROM node:22-alpine

# 1. Install build dependencies required for native modules (bcrypt)
#    + Chromium and all its Alpine system dependencies for Puppeteer
RUN apk add --no-cache \
    python3 py3-pip make g++ \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    ffmpeg

# Install yt-dlp — used to extract captions/transcripts from datacenter IPs
# where YouTube's poToken requirement blocks server-side HTTP methods.
# yt-dlp generates poToken internally and keeps its client fingerprints current.
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Tell Puppeteer to use the system Chromium and skip downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./

# 2. Remove --ignore-scripts so bcrypt can compile its native binary
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

COPY init.sql ./init.sql

# Create the data directory that holds cookies.txt and yt-cookies.json.
# This dir is bind-mounted from the host in docker-compose, but must exist
# in the image for standalone `docker run` use as well.
RUN mkdir -p /app/data

# 3. Secure the application
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 4000

CMD ["npm", "start"]