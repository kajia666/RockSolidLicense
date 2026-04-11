FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV RSL_HOST=0.0.0.0
ENV RSL_PORT=3000
ENV RSL_TCP_ENABLED=true
ENV RSL_TCP_HOST=0.0.0.0
ENV RSL_TCP_PORT=4000

COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY sdk ./sdk

RUN mkdir -p /app/data

EXPOSE 3000
EXPOSE 4000

CMD ["node", "src/server.js"]
