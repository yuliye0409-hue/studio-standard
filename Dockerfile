FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY . .

ENV NODE_ENV=production
ENV STUDIO_HOST=0.0.0.0
CMD ["node", "server.mjs"]
