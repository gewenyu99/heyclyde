FROM node:24-slim

ARG CLYDE_EXTRA_DEPS=""
WORKDIR /app
COPY package.json clyde.example.toml ./
COPY src ./src

RUN if [ -n "$CLYDE_EXTRA_DEPS" ]; then npm install --no-save --omit=dev $CLYDE_EXTRA_DEPS; fi && \
    mkdir -p /data/blobs && chown -R node:node /app /data
USER node

ENV CLYDE_HOST=0.0.0.0
ENV CLYDE_PORT=8787
ENV CLYDE_DATA_DIR=/data
ENV CLYDE_AUTH_MODE=token

EXPOSE 8787
VOLUME ["/data"]

ENTRYPOINT ["node", "/app/src/cli.ts"]
CMD ["serve"]
