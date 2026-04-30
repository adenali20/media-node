# Use a Node.js LTS image with build tools
FROM node:20-slim AS builder

# Install build dependencies for mediasoup (C++ compilation)
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Final stage to keep the image slim
FROM node:20-slim

# Mediasoup requires python3 to run the worker
RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy from builder
COPY --from=builder /app .

# Expose signaling port and the UDP range for media
EXPOSE 3002
EXPOSE 40000-40100/udp

# Command to run the app
CMD ["node", "server.js"]
