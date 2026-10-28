# ADR-0001: TypeScript 7 compiler, TypeScript 6 API for the tools

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

## Update 2026-10-28: TypeScript 7 side by side with the TypeScript 6 API

TypeScript 7.0 ships the native compiler without a programmatic API (one is planned for 7.1).
`typescript-eslint` (8.72, peer range `<6.1`) and `vue-tsc` (Volar) need that API and refuse or
crash with 7.0; both projects point to running TypeScript 6 and 7 side by side, as the
TypeScript 7.0 announcement describes. Microsoft publishes `@typescript/typescript6` for this: the
6.0 API and a `tsc6` command.

Decision:

- The package name `typescript` is an npm alias of `@typescript/typescript6`, so `typescript-eslint`
  and `vue-tsc` keep the 6.0 API through their peer dependency. `@typescript/native` is an alias of
  `typescript` 7, which provides the `tsc` command.
- `tsc` (build and type check of the backend and the shared package) runs on TypeScript 7; the
  frontend type check (`vue-tsc`) and type-aware linting stay on TypeScript 6.
- No code or tsconfig changes were needed: the configuration uses none of the options 7.0 removed
  (`baseUrl`, `moduleResolution: node10`, `target: es5`, ...), and the NestJS decorator metadata is
  emitted as before (backend checked live).
- Renovate keeps `@typescript/typescript6` below 7 and updates TypeScript 7 freely.

Consequences:

- Type checks of the backend and the shared package are about six times faster (backend 3.1 s →
  0.5 s).
- Two TypeScript versions are installed; a type error that only one of them reports is possible in
  theory, but both run in `pnpm typecheck` and `pnpm lint`.
- Drop the alias once `typescript-eslint` and `vue-tsc` support the API of TypeScript 7.1 or later.
