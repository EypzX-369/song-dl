# Use official Node.js image (Alpine version)
FROM node:18-alpine

# Install Chromium and necessary fonts/libraries for Puppeteer
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# Tell Puppeteer to use the installed Chromium instead of downloading one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (ensure puppeteer is in your package.json)
RUN npm install --omit=dev

# Copy rest of the code
COPY . .

# Expose your port
EXPOSE 8000

# Start the app
CMD ["node", "app.js"]
