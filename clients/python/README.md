# Independent Python client

A second, independent client for the Valio Aimo trusted interface
(`apps/aimo-api`) — proof of real interoperability, not just our own
TypeScript client talking to our own TypeScript server.

- No shared code with `apps/buyer-demo` or `packages/shared`.
- Standard library only (`urllib`), so it runs with a bare `python3`, no
  `pip install` needed.
- Follows the same documented `/v1` contract in `apps/aimo-api/openapi.yaml`.

## Run it

```bash
AIMO_API_BASE_URL=https://aimo-api.onrender.com \
AIMO_API_KEY=demo-key-hotel-espoo \
python3 demo.py
```

It requests a quote, places an order, reads back the audit trail, then
proves the governance boundary from spec §0: a buyer-side approval attempt
on an Aimo-owned hold gets rejected with HTTP 403, and only an
Aimo-side approval clears it.
