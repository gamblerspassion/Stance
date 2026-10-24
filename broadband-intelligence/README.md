# Broadband Intelligence — FCC/ArcGIS data pipeline

Dedicated project inside the **gamblerspassion** GitHub account, on the `broadband-intelligence-extraction` branch. This does NOT modify or deploy Internet 4 ALL.

## What is implemented
- Resumable ArcGIS layer 5 (aggregate H3 coverage, prior-period fields) and layer 6 (provider/H3) downloader.
- Save every returned record to SQLite, keyed by `(layer, OBJECTID)`; restart continues from the largest saved ID.
- Reject missing fields, changed source fingerprints, out-of-order pages, or API errors.
- CSV exports retain source field names.
- Existing national FCC ZIP data is **not** automatically overwritten.

## Start with metadata (no large download)
```bash
python broadband-intelligence/arcgis_extract.py inspect --layer 5
python broadband-intelligence/arcgis_extract.py inspect --layer 6
```

**Check inspect output for the actual reporting period and fields.** The public ArcGIS service has a legacy `December_2024_View` name and can be updated; the release argument is a *manual label*, not a server-side historical-version selector. Never assume historical fields describe any specific pair of periods without validating metadata.

## Small pilot / actual extraction
```bash
python broadband-intelligence/arcgis_extract.py extract --layer 5 --db data/arcgis.sqlite --release 2025-12-31 --max-pages 2
python broadband-intelligence/arcgis_extract.py export --layer 5 --db data/arcgis.sqlite --output data/coverage_h3.csv
```
Only after verifying source vintage and schema, run without `--max-pages` for a complete copy, then layer 6 separately. Runtime/storage may be substantial.

## Important geographic limitation
Layer 5/6 H3 records do NOT automatically map to USPS ZIP codes. A verified H3↔2020 ZCTA weighting/crosswalk and an aggregation policy for overlapping populations/BSLs are required before publishing ZIP coverage percentages. Do not sum provider-served locations across overlapping geographic cells as though they were unique homes. Do not add percentages across overlapping networks. This repository's extractor **does not** claim to have performed ZIP joins yet.

## Work to complete before national production
1. Verify field schemas and snapshot with live inspect, and adapt field aliases if ArcGIS schema differs.
2. Run pilot fetch and reconcile its values against existing 32303/45240 network samples.
3. Integrate documented H3-to-ZCTA crosswalk, create robust ZIP aggregates, and test totals.
4. Backfill historical periods for provider-specific change reporting separately if required.
5. Download rich FCC availability fields (max advertised speeds/up/down, low-latency) from appropriate source; they are NOT present in this extract.
6. Compare all generated ZIP records with existing 424,080-row December 2025 national output.
7. Publish compact derived JSON to website only after all checks and channel eligibility are verified.

## Source / deployment
ArcGIS service: https://services8.arcgis.com/peDZJliSvYims39Q/ArcGIS/rest/services/FCC_Broadband_Data_Collection_December_2024_View/FeatureServer

The SQLite database and CSV extracts are excluded from git. Do not store credentials in code or commit any customer records.
