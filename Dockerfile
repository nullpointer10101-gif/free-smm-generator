FROM node:20-bookworm-slim

# Install Chromium, Xvfb, xauth, fonts, ca-certificates, curl, unzip, and display libraries
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    xvfb \
    xauth \
    x11-utils \
    curl \
    unzip \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV DISPLAY=:99

WORKDIR /app

# Download official Buster extension release directly
RUN mkdir -p /app/extensions/buster && \
    curl -k -fsSL https://github.com/dessant/buster/releases/download/v3.4.0/buster_captcha_solver_for_humans-3.4.0-chrome.zip -o /tmp/buster.zip && \
    unzip -q /tmp/buster.zip -d /app/extensions/buster && \
    rm /tmp/buster.zip

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3001

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", "node", "generator.js"]
