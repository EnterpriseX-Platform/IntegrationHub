# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Branding: open-source default is IntegrationX; internal builds pass
#   --build-arg VITE_APP_NAME=<name> --build-arg VITE_APP_TAGLINE="<tagline>"
ARG VITE_APP_NAME=IntegrationX
ARG VITE_APP_TAGLINE="Integration Platform"
ENV VITE_APP_NAME=$VITE_APP_NAME VITE_APP_TAGLINE=$VITE_APP_TAGLINE
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
