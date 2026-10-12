#!/usr/bin/env python3
"""Create (or find) the kb Droplet, its firewall and a Spaces key, then write deploy/.env.

  DO=<DigitalOcean token> [OPEN_AI=<key>] python deploy/provision.py

Idempotent: reruns find the existing Droplet (tag kb), firewall and SSH key, and never overwrite an existing .env.
Standard library only.
"""
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.digitalocean.com/v2"
NAME, REGION, SIZE, IMAGE = "kb", "tor1", "s-2vcpu-4gb", "ubuntu-24-04-x64"
KEY = Path.home() / ".ssh" / "kb_ed25519"
ENV = Path(__file__).resolve().parent / ".env"

USER_DATA = """#cloud-config
package_update: true
packages: [docker.io, docker-compose-v2, restic, ufw]
runcmd:
  - [sh, -c, "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"]
  - [sh, -c, "ufw default deny incoming && ufw allow 22/tcp && ufw allow 443/tcp && ufw --force enable"]
  - [systemctl, enable, --now, docker]
  - [mkdir, -p, /opt/kb]
"""


def call(method, path, body=None):
    token = os.environ.get("DO") or os.environ.get("DIGITALOCEAN_TOKEN") or sys.exit("set DO to a DigitalOcean API token")
    req = urllib.request.Request(f"{API}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: {e.code} {e.read().decode(errors='replace')}")


def ssh_key():
    if not KEY.exists():
        KEY.parent.mkdir(mode=0o700, exist_ok=True)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "kb-deploy", "-f", str(KEY)], check=True)
    pub = KEY.with_suffix(".pub").read_text().strip()
    for k in call("GET", "/account/keys?per_page=200")["ssh_keys"]:
        if k["public_key"].split()[:2] == pub.split()[:2]:
            return k["id"]
    return call("POST", "/account/keys", {"name": "kb-deploy", "public_key": pub})["ssh_key"]["id"]


def droplet(key_id, user_data=USER_DATA):
    found = call("GET", f"/droplets?tag_name={NAME}")["droplets"]
    if found:
        d = found[0]
        print(f"found droplet {d['id']}")
    else:
        # Account keys named kb-* (say kb-wen-mac) go on every build too, so a recreate keeps your access.
        extra = [k["id"] for k in call("GET", "/account/keys?per_page=200")["ssh_keys"] if k["name"].startswith("kb-")]
        d = call("POST", "/droplets", {"name": NAME, "region": REGION, "size": SIZE, "image": IMAGE,
                                       "ssh_keys": sorted({key_id, *extra}),
                                       "tags": [NAME], "user_data": user_data, "monitoring": True, "ipv6": True})["droplet"]
        print(f"created droplet {d['id']}")
    for _ in range(90):
        d = call("GET", f"/droplets/{d['id']}")["droplet"]
        ip = next((n["ip_address"] for n in d["networks"]["v4"] if n["type"] == "public"), None)
        if d["status"] == "active" and ip:
            return ip
        time.sleep(5)
    sys.exit("droplet did not become active")


def firewall():
    if any(f["name"] == NAME for f in call("GET", "/firewalls")["firewalls"]):
        return
    anywhere = {"addresses": ["0.0.0.0/0", "::/0"]}
    call("POST", "/firewalls", {
        "name": NAME, "tags": [NAME],
        "inbound_rules": [{"protocol": "tcp", "ports": p, "sources": anywhere} for p in ("22", "443")],
        "outbound_rules": [{"protocol": p, "ports": "all", "destinations": anywhere} for p in ("tcp", "udp")]
                          + [{"protocol": "icmp", "destinations": anywhere}]})
    print("created firewall: inbound 22 and 443 only")


def spaces_key():
    """A Spaces key for restic. Returns (key, secret), or blanks if the account can't mint one through the API."""
    try:
        k = call("POST", "/spaces/keys", {"name": "kb-backup", "grants": [{"bucket": "", "permission": "fullaccess"}]})["key"]
        return k["access_key"], k["secret_key"]
    except (SystemExit, KeyError) as e:
        print(f"could not create a Spaces key ({e}); fill SPACES_KEY and SPACES_SECRET in .env by hand")
        return "", ""


def main():
    ip = droplet(ssh_key())
    firewall()
    if ENV.exists():
        print(f"{ENV} exists; left unchanged")
    else:
        key, secret = spaces_key()
        ENV.write_text("\n".join([
            f"KB_HOST={ip}",
            f"KB_DOMAIN=kb.{ip.replace('.', '-')}.sslip.io",
            f"KB_TOKEN={secrets.token_urlsafe(32)}",
            f"KB_RUNTIME_TOKEN={secrets.token_urlsafe(32)}",
            f"KB_ADMIN_TOKEN={secrets.token_urlsafe(32)}",
            f"PG_PASSWORD={secrets.token_urlsafe(24)}",
            "KB_ARMS=index,hybrid",
            f"OPEN_AI={os.environ.get('OPEN_AI', '')}",
            f"SPACES_REGION={REGION}",
            f"SPACES_BUCKET=kb-backup-{secrets.token_hex(4)}",
            f"SPACES_KEY={key}",
            f"SPACES_SECRET={secret}",
            f"RESTIC_PASSWORD={secrets.token_urlsafe(32)}",
        ]) + "\n")
        ENV.chmod(0o600)
        print(f"wrote {ENV}")
    print(f"droplet {ip}. Next: deploy/deploy.sh")


if __name__ == "__main__":
    main()
