# Reader verification fixtures

All PDF page text, vector graphics and PDF byte serialization are original synthetic test content, distributed under the project's AGPL-3.0-only license. No real paper, external PDF, external font file or screenshot was downloaded. `pdf-lib` 1.17.1 is an existing development dependency; Standard 14 font references are used.

Generate from the project root:

```powershell
pnpm exec tsx scripts/verification/generate-reader-fixtures.ts
```

`manifest.json` records byte counts, SHA256, page geometry, dependencies and public test passwords. Repeating generation on this environment produced identical PDF hashes.

| File | Purpose |
| --- | --- |
| encrypted-r2.pdf | One actual encrypted page using Standard security handler `/V 1 /R 2`. User password `paperflow-reader-test`; owner password `paperflow-owner-test`. No-password and wrong-password attempts fail in real PDF.js; both correct passwords decrypt the original page text. This legacy encryption is a compatibility fixture, not a security recommendation. |
| geometry.pdf | 16 pages: rotations 0/90/180/270 × UserUnit 1/2.5 × full MediaBox/offset CropBox. MediaBox `[0,0,612,792]`; offset CropBox `[23,37,523,737]`. Geometry markers include their page number. |
| long-600.pdf | 600 equal-size pages with distinct page markers. All page operator lists are parsed by the targeted unit test. Desktop import, canvas residency and navigation are separate E2E checks. |

The encryption writer is original code implementing the algorithms documented in [Adobe PDF Reference 1.4 §3.5](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.4.pdf). The specification was consulted through browsing, not redistributed. Its redistribution license and SHA256 are explicitly unverified in the manifest; PDF hashes refer only to the locally generated fixtures.
