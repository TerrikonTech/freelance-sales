FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install
COPY apps ./apps
RUN npm run build
RUN npm test -w apps/api
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
RUN apk add --no-cache chromium ca-certificates freetype harfbuzz nss ttf-freefont
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/sql ./apps/api/sql
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/data/documents && chown -R node:node /app/data && chmod -R a+rX /app/apps
USER node
EXPOSE 3000
