FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html console.html vite.config.js vite.console.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 SECURE_COOKIE=true DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-console ./dist-console
COPY package.json ./
COPY server ./server
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4317
CMD ["node", "server/start.js", "--production"]
