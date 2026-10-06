FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:daa17b944bac2b578e962da4c61ad72a59233b3c63abea17113acaf4e6b9aea4 AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/node_modules/react/LICENSE /usr/share/doc/paktrak/react-LICENSE
COPY --from=build /app/node_modules/react-dom/LICENSE /usr/share/doc/paktrak/react-dom-LICENSE
COPY --from=build /app/node_modules/scheduler/LICENSE /usr/share/doc/paktrak/scheduler-LICENSE
COPY --from=build /app/package-lock.json /usr/share/doc/paktrak/npm-package-lock.json
COPY infra/nginx.conf /etc/nginx/templates/default.conf.template
# Login theme for the identity service, copied into a volume by identity-theme.
COPY infra/themes/paktrak /usr/share/paktrak/identity-theme
COPY --from=build /app/public/fonts /usr/share/paktrak/identity-theme/login/resources/fonts
COPY --from=build /app/public /usr/share/paktrak/identity-theme/login/resources/shared
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/doc/paktrak/
COPY docs/DEPENDENCIES.md /usr/share/doc/paktrak/DEPENDENCIES.md
ENV NGINX_ENVSUBST_FILTER=^APP_URL$
