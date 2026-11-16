# The workbench as a static site behind nginx. No backend: everything runs in the browser (R35).
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM nginx:1.27-alpine
COPY --from=build /repo/packages/ui/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
