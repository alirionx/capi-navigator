# ADR-0016: OpenAPI generated from Zod schemas and route metadata

- Status: accepted
- Date: 2026-10-19
- Pack: FP-23

## Context

FP-23 asks for an OpenAPI description and Swagger UI. The usual NestJS way, `@nestjs/swagger`,
describes requests and responses with decorated DTO classes. The app already defines every request
and response once as a Zod schema in `packages/shared` (hard rule 2): 42 validation pipes carry the
request schemas, and the frontend validates every response with a Zod schema. A second description
in DTO classes would drift from the validation, and bridging packages (e.g. `nestjs-zod`) add
dependencies the lean stack avoids.

## Decision

- **Own generator in the backend**, no new generator dependency:
  - Controllers are found with NestJS's `DiscoveryService`; path, method and the `@Requires`
    permission come from the route metadata.
  - Request bodies and query parameters come from the Zod schemas of the `ZodValidationPipe`s of
    each route, so the documented schema is the validated one.
  - One decorator per endpoint, `@Api({ summary, response })`, adds what the code does not know at
    runtime: a short summary and the response schema. A test fails when it is missing.
  - Zod 4's `z.toJSONSchema` (draft 2020-12, the dialect of OpenAPI 3.1) turns schemas into JSON
    Schema; schemas exported from `packages/shared` become named components.
- **Swagger UI from `swagger-ui-dist`**, served by the backend under `/api/docs` with its own
  start script. No CDN and no inline script, so the Content Security Policy stays
  `script-src 'self'` and the page works without internet access. The start script adds the CSRF
  header to mutating requests; requests use the browser's session.
- **Public by decision of the product owner.** `/api/openapi.json` and `/api/docs` answer without
  sign-in, so external tools can read the description. The document contains no secrets and no
  data, only the endpoints and the permission model; calling the API still needs a session (later
  an API token, FP-22) and the permission. Operators who do not want this switch it off
  (`apiDocs.enabled=false`).
- **Committed copy** `docs/api/openapi.json`, written by `pnpm openapi:generate` and checked to be
  current by a test, so API changes show in pull requests.

## Consequences

- Every new endpoint needs `@Api` with a summary and, for JSON, a response schema from
  `packages/shared`; response shapes defined only in the frontend move to `packages/shared`.
- The generator covers what the app uses (JSON bodies, query objects, path parameters, SSE, 204);
  other NestJS features (file uploads, versioning) would need an extension.
- `swagger-ui-dist` is a runtime dependency of about 12 MB (static files); Renovate keeps it current.
