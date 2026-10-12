FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY kb ./kb
USER nobody
EXPOSE 8000
# Caddy reaches the api over the compose network, so uvicorn takes the client's address from its X-Forwarded-For.
# Only private addresses are trusted to set it. The api port is never published, and wrong tokens count per address.
CMD ["uvicorn", "kb.server:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", \
     "--forwarded-allow-ips", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"]
