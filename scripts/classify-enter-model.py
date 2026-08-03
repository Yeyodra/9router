#!/usr/bin/env python3
"""Pre-classify Enter accounts for one expensive model; stdlib only."""
import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

DB = os.environ.get("NINEROUTER_DB", os.path.expanduser("~/.9router/db/data.sqlite"))
URL = "https://api.enter.pro/code/api/v1/chat/completions"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"


def json_path(key):
    return '$."' + key.replace('"', '\\"') + '"'


def probe(row, model):
    account_id, key, workspace = row
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Reply OK"}],
        "max_completion_tokens": 1,
        "stream": False,
    }).encode()
    headers = {
        "Authorization": f"Bearer {key}", "X-Workspace-ID": str(workspace),
        "Origin": "https://enter.converge.ai", "Referer": "https://enter.converge.ai/",
        "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json",
    }
    try:
        with urllib.request.urlopen(urllib.request.Request(URL, body, headers, method="POST"), timeout=15) as r:
            text, status = r.read(1000).decode(errors="replace"), r.status
    except urllib.error.HTTPError as e:
        text, status = e.read(1000).decode(errors="replace"), e.code
    except Exception as e:
        return account_id, "unknown", f"{type(e).__name__}: {e}"
    low = text.lower()
    if status == 402 and "insufficient build credits" in low:
        return account_id, "402", text[:200]
    if status < 300 or (status == 400 and "output limit was reached" in low):
        return account_id, "healthy", text[:200]
    if status == 502 or status >= 500:
        return account_id, "502", text[:200]
    return account_id, "unknown", f"HTTP {status}: {text[:160]}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--db", default=DB)
    p.add_argument("--workers", type=int, default=5)
    p.add_argument("--limit", type=int, default=0, help="0 = all unclassified")
    p.add_argument("--canary", type=int, default=10)
    p.add_argument("--dry-run", action="store_true", help="Probe but do not update DB")
    p.add_argument("--pending-only", action="store_true", help="Probe rows marked modelProbe_<model>=pending")
    a = p.parse_args()
    if not 1 <= a.workers <= 10 or not 1 <= a.canary <= 20:
        p.error("workers must be 1..10 and canary 1..20")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", a.model):
        p.error("model contains unsupported characters")

    lock_key, probe_key = f"modelLock_{a.model}", f"modelProbe_{a.model}"
    lock_path, probe_path = json_path(lock_key), json_path(probe_key)
    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    probe_clause = "json_extract(data, ?) = 'pending'" if a.pending_only else "json_extract(data, ?) IS NULL"
    lock_clause = "1=1" if a.pending_only else "json_extract(data, ?) IS NULL"
    sql = f"""SELECT id,json_extract(data,'$.apiKey'),json_extract(data,'$.providerSpecificData.workspaceId')
             FROM providerConnections
             WHERE provider='enter-converge' AND isActive=1
               AND {lock_clause} AND {probe_clause}
               AND json_extract(data,'$.apiKey') IS NOT NULL
               AND json_extract(data,'$.providerSpecificData.workspaceId') IS NOT NULL"""
    params = (probe_path,) if a.pending_only else (lock_path, probe_path)
    rows = con.execute(sql, params).fetchall()
    con.close()
    if a.limit:
        rows = rows[:a.limit]
    print(f"model={a.model} candidates={len(rows)} workers={a.workers}", flush=True)
    if not rows:
        return

    def run(batch):
        out = []
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            futures = [pool.submit(probe, row, a.model) for row in batch]
            for future in as_completed(futures):
                result = future.result()
                out.append(result)
                print(f"{result[1]:7} {result[0]}", flush=True)
        return out

    first, rest = rows[:a.canary], rows[a.canary:]
    results = run(first)
    outages = sum(kind == "502" for _, kind, _ in results)
    if outages >= max(3, (len(first) + 1) // 2):
        print(f"ABORT: circuit breaker ({outages}/{len(first)} canaries returned 5xx)", file=sys.stderr)
        return 2
    results += run(rest)

    counts = {k: sum(kind == k for _, kind, _ in results) for k in ("healthy", "402", "502", "unknown")}
    print("results " + " ".join(f"{k}={v}" for k, v in counts.items()), flush=True)
    if a.dry_run:
        print("dry-run: DB unchanged")
        return

    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    locked_until = (datetime.now(timezone.utc) + timedelta(days=3650)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    locked = [(lock_path, locked_until, probe_path, "402", detail, 402, now, now, account_id)
              for account_id, kind, detail in results if kind == "402"]
    healthy = [(probe_path, "healthy", now, account_id)
               for account_id, kind, _ in results if kind == "healthy"]
    if not locked and not healthy:
        print("no definitive results to persist")
        return
    con = sqlite3.connect(a.db, timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    changes_before = con.total_changes
    if a.pending_only:
        con.executemany("""UPDATE providerConnections SET data=json_set(data,
            ?, ?, ?, ?, '$.lastError', ?, '$.errorCode', ?, '$.lastErrorAt', ?), updatedAt=?
            WHERE id=? AND json_extract(data, ?)='pending'""",
            [(*row, probe_path) for row in locked])
        con.executemany("""UPDATE providerConnections SET data=json_remove(json_set(data,
            ?, ?), ?), updatedAt=? WHERE id=? AND json_extract(data, ?)='pending'""",
            [(probe, state, lock_path, updated, account_id, probe_path)
             for probe, state, updated, account_id in healthy])
    else:
        con.executemany("""UPDATE providerConnections SET data=json_set(data,
            ?, ?, ?, ?, '$.lastError', ?, '$.errorCode', ?, '$.lastErrorAt', ?), updatedAt=?
            WHERE id=? AND json_extract(data, ?) IS NULL AND json_extract(data, ?) IS NULL""",
            [(*row, probe_path, lock_path) for row in locked])
        con.executemany("""UPDATE providerConnections SET data=json_set(data,
            ?, ?), updatedAt=? WHERE id=? AND json_extract(data, ?) IS NULL
            AND json_extract(data, ?) IS NULL""",
            [(probe, state, updated, account_id, probe_path, lock_path)
             for probe, state, updated, account_id in healthy])
    persisted = con.total_changes - changes_before
    con.commit()
    con.close()
    print(f"persisted={persisted}")


if __name__ == "__main__":
    raise SystemExit(main() or 0)
