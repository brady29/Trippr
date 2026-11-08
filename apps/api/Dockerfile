# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/rules/package.json packages/rules/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter "@trippr/api..."
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @trippr/api build \
 && pnpm --filter @trippr/api deploy --prod /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
