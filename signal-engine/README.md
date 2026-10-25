# SIGNAL Market Engine — isolated backend (v1)

Nationwide, read-only broadband market research and sales-routing backend for Internet 4 ALL. This development branch does **not** change the live site or its page templates.

## Verified snapshot (2026-10-25)
- 41,721 ZIP/ZCTA/postal-association market records; 32,931 FCC ZCTAs
- 424,080 December 2025 FCC provider/geography/technology rows
- 111,819 branded provider rows
- 69,803 existing website URL routes, including 31,043 ZIP and 19,184 city routes
- Special territory overlays: 840 T-Mobile Fiber D2D ZIPs, 1,450 Ohio Verizon inquiry ZIPs, 222 Cincinnati/Dayton Spectrum event ZIPs
- EarthLink is a reseller/address-quote inquiry route, **not** a verified serviceability claim.

The repository stores `snapshot-pack/pack-manifest.json` and 28 ASCII parts; the unpacker validates base64 length and SHA-256 before extracting. The large expanded dataset is generated locally, not checked into Git.

## Reproduce and test
From `signal-engine/` with Python 3 and Node.js >=20:

```sh
python3 scripts/unpack_snapshot.py
python3 scripts/audit_snapshot.py
npm test
node src/cli.mjs zip 45202
node src/server.mjs
```

To expose static data to a **preview** Astro application without changing page templates, use `python3 scripts/unpack_snapshot.py --public /path/to/preview/public/data/signal/v1`. Inspect outputs before connecting any live route.

## Read-only endpoints
`GET /v1/health`, `/v1/zip/{zip}`, `/v1/city/{city-state-slug}`, `/v1/state/{code}`, `/v1/provider/{provider}`, `/v1/cities/search?q=...`, `/v1/route?path=/internet-providers/zip/45202/`, and `/v1/compare/{zip}?a=altafiber&b=spectrum`. The server binds to 127.0.0.1 by default and performs no paid lookup.

Provider/technology coverage describes **FCC-reported geographic evidence**, not installation-address eligibility, real-time plan speed, product price, or authorization to place an order. Frontier DSL is excluded from direct fiber leads; Spectrum is event-only; T-Mobile Fiber is door-to-door; Verizon requires wireless-first qualification. EarthLink requires dealer-side address quote.

`qualifyAddressWithDealer` is a guarded extension point requiring a **trusted server-side provider adapter** and confirmation bound to the submitted address and provider. No real dealer credentials, address-verification integrations, or live order submission are present in this repository; do not present the backend as an automated checkout or address-orderability checker until those separately authorized integrations are implemented and tested.

## Rebuild from source
`python3 scripts/build_engine.py --source <directory-with-the-October-FCC-and-Stance-data> --output data/signal-v1` requires the five named source files documented in `data/signal-v1/manifest.json`; the checked-in snapshot allows testing without re-downloading the national extracts. Source vintage and commercial rules are recorded in manifest and rules JSON.

## Integrity rules
Run `scripts/audit_snapshot.py` and `npm test` after every source or logic change. Keep geographic data separate from Stance sales/channel permissions. Never sum overlapping network coverage across reporting entities. Do not activate routine paid BroadbandMap lookups or edit production routes here.
