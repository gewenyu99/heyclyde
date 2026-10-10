#!/usr/bin/env python3
"""Deploy without SSH: ship memory/ through Spaces and let cloud-init install it on a fresh Droplet.

  python deploy/cloud-deploy.py [path/to/pkg-seed/out] [--recreate]

For hosts that can reach HTTPS but not port 22. It encrypts the code, deploy/.env and the seed with a one-off key,
uploads the bundle to the backup bucket, and creates the kb Droplet with a cloud-init script that fetches the bundle,
runs deploy/install.sh and deploy/selftest.sh, and uploads the encrypted log back. This machine then prints the log.
--recreate destroys the existing kb Droplet first. Its database goes with it, so take a backup before you use it on a
live box. The key and the presigned URLs sit in the Droplet's user data, so the bundle is deleted once the log is back.
Needs boto3 and openssl.
"""
import argparse
import io
import os
import secrets
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import boto3
from botocore.config import Config

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provision as p  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUNDLE, RESULT = "deploy/bundle.enc", "deploy/result.enc"

BOOT = """#!/bin/sh
exec > /var/log/kb-boot.log 2>&1
up() {{ echo "exit $?"; tar czf - /var/log/kb-boot.log | openssl enc -aes-256-cbc -pbkdf2 -pass pass:{key} > /root/kb-result.enc
       curl -fsS -X PUT --upload-file /root/kb-result.enc '{put}'; }}
trap up EXIT
set -e
curl -fsS '{get}' | openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:{key} | tar xzf - -C /opt/kb
ip=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
sed -i "s/^KB_HOST=.*/KB_HOST=$ip/; s/^KB_DOMAIN=.*/KB_DOMAIN=kb.$(echo $ip | tr . -).sslip.io/" /opt/kb/deploy/.env
chmod 600 /opt/kb/deploy/.env
sh /opt/kb/deploy/install.sh
sh /opt/kb/deploy/selftest.sh
"""


def env():
    return dict(line.split("=", 1) for line in (ROOT / "deploy/.env").read_text().splitlines() if "=" in line)


def bundle(seed_out):
    buf = io.BytesIO()
    skip = lambda t: None if "__pycache__" in t.name or t.name == "deploy/.env" else t  # noqa: E731
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for d in ("db", "api", "deploy", "seed", "eval"):
            tar.add(ROOT / d, arcname=d, filter=skip)
        tar.add(ROOT / "deploy/.env", arcname="deploy/.env")
        if seed_out:
            tar.add(seed_out, arcname="seed-out")
    return buf.getvalue()


def crypt(data, key, decrypt=False):
    args = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-pass", f"pass:{key}"] + (["-d"] if decrypt else [])
    return subprocess.run(args, input=data, capture_output=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("seed_out", nargs="?")
    ap.add_argument("--recreate", action="store_true")
    ap.add_argument("--wait", type=int, default=3600, help="seconds to wait for the selftest log")
    a = ap.parse_args()
    e = env()
    s3 = boto3.client("s3", region_name=e["SPACES_REGION"], endpoint_url=f"https://{e['SPACES_REGION']}.digitaloceanspaces.com",
                      aws_access_key_id=e["SPACES_KEY"], aws_secret_access_key=e["SPACES_SECRET"],
                      config=Config(signature_version="s3v4", request_checksum_calculation="when_required",
                                    response_checksum_validation="when_required"))
    bucket = e["SPACES_BUCKET"]
    try:
        s3.head_bucket(Bucket=bucket)
    except s3.exceptions.ClientError:
        s3.create_bucket(Bucket=bucket)
        print(f"created bucket {bucket}")

    key = secrets.token_urlsafe(32)
    s3.put_object(Bucket=bucket, Key=BUNDLE, Body=crypt(bundle(a.seed_out), key))
    s3.delete_object(Bucket=bucket, Key=RESULT)
    get = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": BUNDLE}, ExpiresIn=6 * 3600)
    put = s3.generate_presigned_url("put_object", Params={"Bucket": bucket, "Key": RESULT}, ExpiresIn=6 * 3600)
    print("uploaded bundle")

    found = p.call("GET", f"/droplets?tag_name={p.NAME}")["droplets"]
    if found and not a.recreate:
        sys.exit(f"droplet {found[0]['id']} exists. Use deploy.sh over SSH, or --recreate to replace it (its data goes too)")
    for d in found:
        p.call("DELETE", f"/droplets/{d['id']}")
        print(f"destroyed droplet {d['id']}")
    while found and p.call("GET", f"/droplets?tag_name={p.NAME}")["droplets"]:
        time.sleep(5)
    boot = "".join(f"      {line}\n" for line in BOOT.format(key=key, get=get, put=put).splitlines())
    user_data = p.USER_DATA + "  - [sh, /root/kb-boot.sh]\nwrite_files:\n  - path: /root/kb-boot.sh\n    permissions: '0700'\n    content: |\n" + boot
    p.USER_DATA = user_data
    ip = p.droplet(p.ssh_key())
    p.firewall()
    text = (ROOT / "deploy/.env").read_text().replace(f"KB_HOST={e['KB_HOST']}", f"KB_HOST={ip}")
    text = text.replace(f"KB_DOMAIN={e['KB_DOMAIN']}", f"KB_DOMAIN=kb.{ip.replace('.', '-')}.sslip.io")
    (ROOT / "deploy/.env").write_text(text)
    print(f"droplet {ip}. Waiting for the selftest log")

    deadline = time.time() + a.wait
    while time.time() < deadline:
        try:
            blob = s3.get_object(Bucket=bucket, Key=RESULT)["Body"].read()
            break
        except s3.exceptions.NoSuchKey:
            time.sleep(20)
    else:
        sys.exit("no selftest log yet. Rerun with a longer --wait, or check the Droplet console")
    with tarfile.open(fileobj=io.BytesIO(crypt(blob, key, decrypt=True))) as tar:
        sys.stdout.write(tar.extractfile("var/log/kb-boot.log").read().decode(errors="replace"))
    for k in (BUNDLE, RESULT):
        s3.delete_object(Bucket=bucket, Key=k)
    print(f"\nhttps://kb.{ip.replace('.', '-')}.sslip.io/healthz")


if __name__ == "__main__":
    main()
