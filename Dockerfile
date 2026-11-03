FROM node:22-bookworm
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start", "--", "-H", "0.0.0.0"]
