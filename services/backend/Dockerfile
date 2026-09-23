FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e AS toolchain
COPY --from=ghcr.io/astral-sh/uv:0.12.16@sha256:adc68cd785ca65ea25c0611043b0a00b4ea3a22e1b54102fc084406d888082ee /uv /uvx /usr/local/bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

FROM toolchain AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr=5.3.0-2 tesseract-ocr-eng=1:4.1.0-2 \
    && rm -rf /var/lib/apt/lists/*
ENV OMP_THREAD_LIMIT=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" PYTHONPATH="/app/services/backend"
# Fail the build if the advertised native photo decoders/color support are absent.
RUN python -c "from PIL import features; from pi_heif import libheif_info; assert all(features.check(f) for f in ('avif', 'webp', 'libtiff', 'littlecms2')); assert 'libde265' in libheif_info()['decoders']"
COPY services/backend services/backend
COPY migrations migrations
COPY alembic.ini ./
RUN groupadd -g 10001 scanner && useradd -u 10001 -g scanner -m scanner
USER scanner
# Check source access as the runtime user before replacing a running installation.
RUN python -c "from scanner import bootstrap; from pathlib import Path; [path.read_bytes() for path in Path('migrations').rglob('*.py')]"
CMD ["uvicorn", "scanner.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

FROM runtime AS test
USER root
RUN uv sync --frozen
COPY tests tests
COPY scripts/setup.py scripts/setup.py
USER scanner
ENV PYTEST_ADDOPTS="-p no:cacheprovider"
CMD ["pytest", "-q"]
