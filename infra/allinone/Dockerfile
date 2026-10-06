# PakTrak in a single container: PostgreSQL, Valkey, SeaweedFS, Keycloak, the
# API and workers, and nginx, started in order by supervisord. Build from the
# repository root:
#   docker build -f infra/allinone/Dockerfile -t paktrak .
# The Compose installation (compose.yaml) remains the multi-container option.

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS web
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e AS python
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir uv==0.12.16 supervisor==4.3.0
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev && pip uninstall -y uv
COPY services/backend services/backend
COPY migrations migrations
COPY alembic.ini ./

# Pre-build Keycloak for this configuration so it starts with --optimized.
FROM keycloak/keycloak:26.7.4@sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c AS identity
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true --http-relative-path=/identity --cache=local

# The same PostgreSQL 17 build as compose.yaml, so a Compose database moves over as is.
FROM postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0 AS runtime
ARG INSTALL_OCR=true
RUN if [ "$INSTALL_OCR" = true ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr=5.3.0-2 tesseract-ocr-eng=1:4.1.0-2 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=python /usr/local /usr/local
COPY --from=python /app /app
COPY --from=valkey/valkey:8.1-bookworm@sha256:fea8b3e67b15729d4bb70589eb03367bab9ad1ee89c876f54327fc7c6e618571 /usr/local/bin/valkey-server /usr/local/bin/valkey-server
COPY --from=chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882 /usr/bin/weed /usr/local/bin/weed
COPY --from=nginx:1.28.0-bookworm@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609 /usr/sbin/nginx /usr/sbin/nginx
COPY --from=nginx:1.28.0-bookworm@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609 /etc/nginx/mime.types /etc/nginx/mime.types
COPY --from=eclipse-temurin:21-jre-jammy@sha256:f04fb34e053148344e83317976114ec3f37e4b830ec8bdab5a2fe3cecd7d010b /opt/java/openjdk /opt/java/openjdk
COPY --from=identity /opt/keycloak /opt/keycloak
COPY infra/themes/paktrak /opt/keycloak/themes/paktrak
COPY --from=web /app/public/fonts /opt/keycloak/themes/paktrak/login/resources/fonts
COPY --from=web /app/public /opt/keycloak/themes/paktrak/login/resources/shared
COPY --from=web /app/dist /usr/share/paktrak/web
COPY infra/nginx.conf /usr/share/paktrak/nginx-site.conf
COPY infra/allinone/supervisord.conf /etc/paktrak/supervisord.conf
COPY infra/allinone/aio.py /usr/local/lib/paktrak/aio.py
COPY infra/allinone/entrypoint.sh /usr/local/bin/paktrak-entrypoint
COPY infra/allinone/startup.sh /usr/local/bin/paktrak-startup
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/doc/paktrak/
COPY docs/DEPENDENCIES.md /usr/share/doc/paktrak/DEPENDENCIES.md
RUN groupadd -g 10001 paktrak && useradd -u 10001 -g paktrak -m paktrak \
    && chown -R paktrak:paktrak /opt/keycloak/data \
    && chmod 0755 /usr/local/bin/paktrak-entrypoint /usr/local/bin/paktrak-startup
ENV PATH="/app/.venv/bin:/opt/java/openjdk/bin:$PATH" PYTHONPATH="/app/services/backend" \
    PYTHONUNBUFFERED=1 OMP_THREAD_LIMIT=1 JAVA_HOME=/opt/java/openjdk PGDATA=/data/postgres
# Fail the build if a bundled program cannot start or the photo decoders are missing.
RUN valkey-server --version && weed version && nginx -v && java -version \
    && python -c "from PIL import features; from pi_heif import libheif_info; assert all(features.check(f) for f in ('avif', 'webp', 'libtiff', 'littlecms2')); assert 'libde265' in libheif_info()['decoders']" \
    && gosu paktrak python -c "from scanner import bootstrap; from pathlib import Path; [path.read_bytes() for path in Path('/app/migrations').rglob('*.py')]"
WORKDIR /app
VOLUME /data
EXPOSE 8095
STOPSIGNAL SIGTERM
ENTRYPOINT ["paktrak-entrypoint"]
