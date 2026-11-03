FROM node:22-alpine
WORKDIR /app
COPY scripts/preview-server.mjs ./preview-server.mjs
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "preview-server.mjs"]
