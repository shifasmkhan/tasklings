# Dependency audit (npm)

Date: 2026-10-28. Method: `npm ci && npm audit --json` in each package, then `npm ls` / `npm explain` per finding. `npm audit fix --force` is never used. Major-version bumps of direct dependencies are out of scope (Dependabot PRs for TypeScript 7, ESLint 10 and @types/node 26 are on hold by owner decision).

## Summary

| Package folder | Before | After this PR |
|---|---|---|
| `app/` | 17 (13 low, 4 high) | 16 (13 low, 3 high) |
| `ai/` | 0 | 0 |
| `supabase/` | 0 | 0 |

Nothing reaches the shipped app. Every finding is in Expo CLI / Metro / config tooling or in Jest, which run on a developer machine or CI and never ship in the JS bundle that runs on the phone. No moderate or critical findings.

## Findings (`app/`)

"Reaches app?" means: is the package part of the JS bundle that runs on the phone.

| Package | Severity | Advisory | Dependency path | Reaches app? | Action | Rationale |
|---|---|---|---|---|---|---|
| node-forge 1.4.0 | high | GHSA-86w9-cpqp-85rv (RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements) | expo > @expo/cli > node-forge; expo > @expo/cli > @expo/code-signing-certificates > node-forge | n | Fixed | `npm update node-forge` moves the lockfile to 1.4.2, inside the existing `^1.4.0` ranges. No package.json change. Typecheck, lint, 324 tests and `expo config` pass. |
| zod 3.25.76 (nested under @expo/cli) | high | GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections; affects `<4.6.6`) | expo > @expo/cli > zod | n | Accepted | Used by Expo CLI to validate its own local inputs on the developer machine. Never bundled and never sees untrusted data. @expo/cli pins `^3.25.76`; the only patched line is zod 4, a major bump of a transitive dependency inside an Expo-managed package, so an override is not worth the risk. Revisit when a later @expo/cli moves to zod 4 (e.g. on an Expo SDK upgrade). |
| zod 4.6.7 (hoisted) | none | n/a | eslint-config-expo > eslint-plugin-react-hooks > zod | n | None | Already at a patched version. Listed only so nobody confuses it with the row above. |
| expo | high (derived) | transitive, via @expo/cli (zod) | direct dependency | n for the flagged code | Accepted | Flagged only because it depends on the vulnerable @expo/cli. npm's suggested fix (`expo@51.0.39`) is a major downgrade and is wrong; ignore it. |
| @expo/cli | high (derived) | via zod | expo > @expo/cli | n | Accepted | Dev tooling (`expo start`, prebuild). See the zod row. |
| deepmerge 4.3.1 | low | GHSA-gcqx-w48m-w2h4 (`mergeObject()` allows prototype poisoning of returned objects) | expo > @expo/config > deepmerge; jest > @jest/core > jest-config > deepmerge | n | Accepted | Config resolution at build time and Jest configuration. Inputs are our own `app.json` and Jest config, not untrusted data. No patched 4.x release exists. |
| @expo/config, @expo/local-build-cache-provider, @expo/metro-config, @expo/prebuild-config | low (derived) | via deepmerge | expo > ... | n | Accepted | Build tooling; inherit the deepmerge finding. |
| jest, @jest/core, jest-cli, jest-config, jest-expo, jest-watch-typeahead, @testing-library/react-native, expo-router | low (derived) | via deepmerge (jest-config) | devDependencies (expo-router is a runtime dependency but is flagged only through its optional peer `@testing-library/react-native`, which we install as a devDependency) | n | Accepted | Test tooling. The advisory-to-package chain goes through jest-config only. |

Note on `expo-router`: it appears in the audit as low severity because of the test-library chain above. The vulnerable code (deepmerge inside jest-config) is not in the router's runtime code and not in the bundle.

## Findings (`ai/`, `supabase/`)

None. `npm audit` reports 0 vulnerabilities for both. `supabase/` contains only the `supabase` CLI and `deno` as dev dependencies.

## Policy for future triage

- Fix only within the semver range of the parent: lockfile-only `npm update <pkg>`, or a minimal `overrides` entry pinned to an exact patched version. Avoid overrides on Expo-managed packages.
- Anything that reaches the shipped bundle (runtime dependency of app code) is treated as a blocker regardless of severity.
- Dev-tooling findings are accepted with a written rationale and re-checked when Expo SDK or Jest are upgraded.
