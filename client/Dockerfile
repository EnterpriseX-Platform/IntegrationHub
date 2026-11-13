# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY server.js .
ENV PORT=3000
ENV HOST=0.0.0.0
ENV BASE_PATH=/integration
ENV API_URL=http://integration-platform-server:8080
EXPOSE 3000
CMD ["node", "server.js"]
