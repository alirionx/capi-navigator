# ADR-0001: TypeScript 6.0 instead of 7.0

- Status: accepted
- Date: 2026-10-17
- Pack: FP-0

## Context

The requirements ask for strict TypeScript and ESLint (FP0-F-02). TypeScript 7.0 (the native
compiler) is the current release, but `typescript-eslint` 8.71 supports only `typescript < 6.1`.
Type-aware linting and `vue-tsc` therefore do not work reliably with 7.0 yet.

## Decision

Use TypeScript `~6.0`. Renovate is capped at `< 6.1` until `typescript-eslint` supports a newer
version.

## Consequences

- Lint, typecheck and Vue type checking work with the official tooling.
- Revisit as soon as `typescript-eslint` supports TypeScript 7; the switch should need no code
  changes, since the code uses no syntax specific to either version.
