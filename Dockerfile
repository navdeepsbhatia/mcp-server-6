# Hosted (Railway) image for google-workspace-mcp. Local use does not need Docker.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
# Railway injects PORT. The server binds 0.0.0.0:$PORT and refuses to start without MCP_AUTH_TOKEN.
CMD ["node", "dist/http.js"]
