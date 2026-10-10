# Postgres 17 with pgvector (from the base image) and pg_jieba for 中文 full-text search.
FROM pgvector/pgvector:0.8.1-pg17 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates postgresql-server-dev-17 \
 && git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/jaiminpan/pg_jieba /src/pg_jieba \
 && cmake -S /src/pg_jieba -B /src/pg_jieba/build -DPostgreSQL_TYPE_INCLUDE_DIR=/usr/include/postgresql/17/server \
 && make -C /src/pg_jieba/build -j"$(nproc)" \
 && make -C /src/pg_jieba/build install DESTDIR=/out

FROM pgvector/pgvector:0.8.1-pg17
COPY --from=build /out/ /
RUN echo "shared_preload_libraries = 'pg_jieba'" >> /usr/share/postgresql/postgresql.conf.sample
