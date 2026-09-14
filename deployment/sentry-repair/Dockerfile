FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# The controller is stdlib-only. Copy its complete package so imports stay
# local and the image does not need the Sandra web application's dependencies.
COPY scripts/sentry-repair /app/scripts/sentry-repair
COPY deployment/sentry-repair/entrypoint.sh /usr/local/bin/sandra-sentry-repair-entrypoint

RUN useradd --create-home --uid 10001 sandra \
    && mkdir -p /data \
    && chown -R sandra:sandra /app /data \
    && chmod 0755 /usr/local/bin/sandra-sentry-repair-entrypoint

EXPOSE 8080

# Credentials and the durable database path are injected by the Railway
# service. The executable start command is explicit in the Railway IaC file;
# retaining it as the image default keeps local image runs equivalent.
CMD ["/usr/local/bin/sandra-sentry-repair-entrypoint"]
