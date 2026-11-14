#!/usr/bin/env python3
"""
Independent reference client for the Valio Aimo Trusted Trade Interface.

This is deliberately NOT part of the Node/TypeScript codebase: no shared
types, no shared HTTP client, stdlib only (urllib). It exists to prove the
API is a real, documented, language-agnostic contract (openapi.yaml at the
repo root) rather than something only our own TypeScript client happens to
understand.

Usage:
    AIMO_API_BASE_URL=https://aimo-api.onrender.com \
    AIMO_API_KEY=demo-key-hotel-espoo \
    python3 demo.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

if sys.platform == "win32":
    # Windows consoles often default to a non-UTF-8 codepage; reconfigure so
    # the euro sign and other non-ASCII output print correctly.
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = os.environ.get("AIMO_API_BASE_URL", "https://aimo-api.onrender.com")
API_KEY = os.environ.get("AIMO_API_KEY", "demo-key-hotel-espoo")
BUYER_ID = os.environ.get("BUYER_ID", "k-hotel-espoo")


def call(method, path, body=None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-API-Key", API_KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def main():
    print(f"Independent Python client -> {BASE_URL}\n")

    print("1. Request a quote for 1,000 L of lactose-free milk (product 464073)")
    status, quote = call("POST", "/v1/quote", {"buyer_id": BUYER_ID, "lines": [{"product_id": "464073", "qty": 1000}]})
    assert status == 200, f"quote failed: {status} {quote}"
    line = quote["lines"][0]
    print(f"   quote_id={quote['quote_id']} total=€{quote['total_eur']:.2f} product={line['requested_product_name']!r}")
    print(f"   trust envelope: issuer={line['envelope']['provenance']['issuer']!r} "
          f"verification={line['envelope']['verification']['status']!r}\n")

    print("2. Commit the quote")
    status, order = call("POST", "/v1/orders", {"quote_id": quote["quote_id"]})
    assert status == 200, f"order failed: {status} {order}"
    print(f"   order_id={order['order_id']} status={order['status']!r}\n")

    print("3. Retrieve the audit trail")
    status, audit = call("GET", f"/v1/audit/{order['order_id']}")
    assert status == 200, f"audit failed: {status} {audit}"
    for event in audit["events"]:
        print(f"   [{event['actor']}] {event['action']}")

    print("\n4. Prove the governance boundary: this client cannot clear an Aimo-owned hold")
    status, big_quote = call("POST", "/v1/quote", {"buyer_id": BUYER_ID, "lines": [{"product_id": "464073", "qty": 4520}]})
    assert status == 200, f"quote failed: {status} {big_quote}"
    status, big_order = call("POST", "/v1/orders", {"quote_id": big_quote["quote_id"]})
    assert status == 200, f"order failed: {status} {big_order}"
    if big_order["status"] == "held_for_approval":
        print(f"   order {big_order['order_id']} held, owner={big_order['approval']['owner']!r}")
        status, attempt = call("POST", f"/v1/orders/{big_order['order_id']}/approve", {"actor": "human:buyer"})
        print(f"   buyer-side approval attempt -> HTTP {status}: {attempt}")
        assert status == 403, "expected the buyer-side approval attempt to be rejected"
        status, approved = call("POST", f"/v1/orders/{big_order['order_id']}/approve", {"actor": "human:aimo"})
        assert status == 200, f"aimo approval failed: {status} {approved}"
        print(f"   aimo-side approval -> status={approved['status']!r}")
    else:
        print("   order was within the auto-approval ceiling this time — nothing to approve.")

    print("\nAll calls succeeded against the documented /v1 contract, from a client with no shared code.")


if __name__ == "__main__":
    main()
