FROM public.ecr.aws/docker/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY --chown=node:node build/server.mjs ./server.mjs
COPY --chown=node:node dist ./dist
USER node
ENV HOST=0.0.0.0 PORT=8788 DATA_DIR=/data STATIC_DIR=/app/dist NODE_ENV=production COOKIE_SECURE=true
EXPOSE 8788
CMD ["node", "server.mjs"]
