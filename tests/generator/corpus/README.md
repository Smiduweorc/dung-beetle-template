# Corpus

Real documents, checked in so the generator is tested against something nobody
here wrote. Fixtures next door are built to exercise one rule each; these were
written by other people for their own APIs, which is the point.

| File | Source | Fetched |
| --- | --- | --- |
| `petstore.json` | <https://petstore3.swagger.io/api/v3/openapi.json> | 2026-08-16 |
| `museum.yaml` | <https://raw.githubusercontent.com/Redocly/museum-openapi-example/main/openapi.yaml> | 2026-08-16 |

Both are small enough to read and to keep in the repository. Stripe (6.4MB) and
the GitHub REST API (12.9MB) are not, so `npm run corpus` fetches those instead
and the scheduled `corpus` workflow runs it. Between them they cover OpenAPI
3.0 and 3.1, form-encoded and JSON bodies, `deepObject` filters, endpoints that
document no 2xx response, and names that need settling by hand.
