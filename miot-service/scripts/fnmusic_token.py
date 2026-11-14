#!/usr/bin/env python3
"""Find a FeiNiu Music token that the *server* currently accepts.

Why this exists: fnOS accounts created via NAS OAuth (``user.created_by='oauth'``)
have no usable local password, so ``/user/password-login`` always returns
``code=120001``. The official web client instead sends ``Cookie: music-token``.
Only some rows in ``user_token`` are live sessions (``is_auth_login=1`` usually
wins), and they expire after about a month -- so we probe them rather than
blindly picking the newest one.

Read-only on music.db. Prints the token on stdout; diagnostics go to stderr.
Exit 1 when no token works (the Node client then falls back to password login).

Usage (inside the container):
    python3 /srv/miot-service/scripts/fnmusic_token.py \
        --db /fnmusic-db/music.db \
        --base http://192.168.2.7:6688 \
        --cache /data/miot/fnmusic-token [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import random
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTHX_PREFIX = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
AUTHX_KEY = "6D5602D4-A342-4799-A0F0-BB795E7167D0"
PROBE_PATH = "/user/me"


def log(msg: str) -> None:
    print("[fnmusic-token] " + msg, file=sys.stderr)


def sign_authx(pathname: str) -> str:
    """GET with an empty query: payload is empty, so md5(payload) is fixed."""
    nonce = str(random.randint(100000, 999999))
    timestamp = str(int(time.time() * 1000))
    payload_hash = hashlib.md5(b"").hexdigest()
    source = "_".join((AUTHX_PREFIX, pathname, nonce, timestamp, payload_hash, AUTHX_KEY))
    digest = hashlib.md5(source.encode("utf-8")).hexdigest()
    return "nonce=%s&timestamp=%s&sign=%s" % (nonce, timestamp, digest)


def is_local_gateway_host(host: str) -> bool:
    """Only local/private gateway hosts may skip TLS verification."""
    h = (host or "").strip("[]").lower()
    if h == "localhost" or h == "::1" or h.startswith("127.") or h.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return bool(ip.is_loopback or ip.is_private or ip.is_link_local)
    except ValueError:
        return False


def probe_ssl_context(base: str):
    """fnOS force-HTTPS redirects an HTTP request to a self-signed HTTPS port
    (whose cert usually does not match 127.0.0.1). urllib follows the 301, so
    the relaxed context must be installed on the initial request as well --
    ``context`` is harmless for plain HTTP and applies to the redirected HTTPS
    connection. Only local/private gateway hosts get this treatment."""
    parsed = urllib.parse.urlparse(base)
    if not is_local_gateway_host(parsed.hostname or ""):
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def probe(base: str, token: str, timeout: float) -> bool:
    url = base.rstrip("/") + "/music/api/v1" + PROBE_PATH
    req = urllib.request.Request(url, headers={
        "Cookie": "music-token=" + token,
        "X-Music-API": "v1",
        "Accept": "application/json",
        "authx": sign_authx(PROBE_PATH),
    })
    # build_opener 让重定向后的 HTTPS 连接也使用同一个放宽的 context；
    # urlopen(context=...) 在部分 Python 版本上只作用于首次请求。
    handlers = []
    parsed = urllib.parse.urlparse(base)
    local = is_local_gateway_host(parsed.hostname or "")
    # 回环 / 内网网关一律直连：环境里的 HTTP_PROXY 会把 127.0.0.1 的请求
    # 发到代理上导致超时，而网关根本不需要代理。公网自定义基址仍可用代理。
    if local:
        handlers.append(urllib.request.ProxyHandler({}))
    ctx = probe_ssl_context(base)
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
            return payload.get("code") == 0
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        log("probe failed for %s...: %s" % (token[:8], exc))
        return False


def read_candidates(db: str) -> list[str]:
    con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
    try:
        rows = con.execute(
            "select token, is_auth_login, expired_at from user_token "
            "order by is_auth_login desc, expired_at desc"
        ).fetchall()
    finally:
        con.close()
    out, seen = [], set()
    for token, _auth, _exp in rows:
        if token and token not in seen:
            seen.add(token)
            out.append(token)
    return out


def write_cache(cache: str, token: str) -> None:
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        tmp = cache + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(token)
        os.chmod(tmp, 0o600)
        os.replace(tmp, cache)
    except OSError as exc:
        log("WARN cannot write cache: %s" % exc)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/fnmusic-db/music.db")
    ap.add_argument("--base", default="http://127.0.0.1:6688")
    ap.add_argument("--cache", default="/data/miot/fnmusic-token")
    ap.add_argument("--timeout", type=float, default=4.0)
    ap.add_argument("--force", action="store_true", help="ignore cached token")
    args = ap.parse_args()

    if not args.force and os.path.isfile(args.cache):
        cached = open(args.cache, encoding="utf-8").read().strip()
        if cached and probe(args.base, cached, args.timeout):
            print(cached)
            return 0
        log("cached token no longer valid, rescanning music.db")

    try:
        candidates = read_candidates(args.db)
    except (sqlite3.Error, OSError) as exc:
        log("cannot read %s: %s" % (args.db, exc))
        return 1

    log("probing %d token(s) from music.db" % len(candidates))
    for token in candidates:
        if probe(args.base, token, args.timeout):
            write_cache(args.cache, token)
            log("accepted token %s..." % token[:8])
            print(token)
            return 0
    log("no accepted token found")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
