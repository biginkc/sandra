FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node core.mjs config.mjs server.mjs ./
USER node
ENV NODE_ENV=production PORT=9081 INBOX_PROJECTION_BIND=0.0.0.0
EXPOSE 9081
CMD ["node","server.mjs"]
