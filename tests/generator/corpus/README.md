# Corpus

Real OpenAPI documents written by other people for their own APIs, checked in
so `npm test` runs the generator against something nobody here wrote. The
fixtures next door each exercise one rule.

| File | Source | Fetched |
| --- | --- | --- |
| `petstore.json` | <https://petstore3.swagger.io/api/v3/openapi.json> | 2026-08-16 |
| `museum.yaml` | <https://raw.githubusercontent.com/Redocly/museum-openapi-example/main/openapi.yaml> | 2026-08-16 |

Stripe (6.4MB) and the GitHub REST API (12.9MB) are too big to keep here, so
`tools/corpus.ts` fetches them and the weekly `corpus` workflow runs it.
Together they cover OpenAPI 3.0 and 3.1, form-encoded and JSON bodies,
`deepObject` filters, endpoints with no documented 2xx response, and names
that collide.
