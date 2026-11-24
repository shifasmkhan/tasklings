# Dependency audit (npm)

Date: 2026-11-23. Method: `npm ci && npm audit --json` in each package, then `npm ls` / `npm explain` per finding. `npm audit fix --force` is never used. Major-version bumps of direct dependencies are out of scope (Dependabot PRs for TypeScript 7, ESLint 10 and @types/node 26 are on hold by owner decision).

## Summary

| Package folder | Before this PR | After this PR |
|---|---|---|
| `app/` | 38 (35 moderate, 3 high) | 31 (31 moderate, 0 high) |
| `ai/` | 0 | 0 |
| `supabase/` | 0 | 0 |

Nothing reaches the shipped app. Every finding is in Expo CLI / config-plugin tooling, the Xcode project generator, Jest or typescript-eslint, which run on a developer machine or CI and never ship in the JS bundle that runs on the phone. No high or critical findings remain.

What changed in this PR:

- Expo SDK 58 patch updates (same exact versions as Dependabot #36, which this PR supersedes): `expo` 58.0.22 (brings `@expo/cli` 58.1.21), `react-native` 0.88.1, `react` 19.3.1, `jest-expo` 58.0.13, and the other patch bumps in `package.json`. That moved `@expo/cli`'s `zod` to 4.x (fixed), `node-forge` to 1.4.4 (fixed) and `@expo/plist` / `@xmldom/xmldom` under `expo` to patched versions.
- `@bacons/apple-targets` stays at 5.0.0, the latest release. It still pins `@bacons/xcode` 1.0.0-alpha.32 (latest is alpha.33, which still depends on `@expo/plist` 0.0.18 and `uuid` ^8.3.2), so no release drops the old chain. A scoped npm override was added instead (see below).

## Overrides

```json
"overrides": {
  "@bacons/xcode": { "@xmldom/xmldom": "0.8.15", "uuid": "11.1.1" }
}
```

Scoped to `@bacons/xcode` only, exact versions, never applied to Expo-managed packages. It replaces `@xmldom/xmldom` 0.7.13 (many high advisories, e.g. GHSA-wh4c-j3r5-mjhp, GHSA-2v35-w6hq-6mfw; the 0.7 line has no fix) with 0.8.15, the version `expo` already uses, and `uuid` 8.3.2 (GHSA-w5hq-g745-h8pq) with 11.1.1. Evidence it is safe: `@bacons/xcode` does not call `uuid` anywhere in its built code, and 0.8.x is API-compatible for the plist parsing `@expo/plist` 0.0.18 does. Verified with `npx expo prebuild --platform ios --no-install --clean` in a temp copy (the widget extension target is generated) and by the CI `ios simulator build (unsigned)` job. Remove the override when `@bacons/apple-targets` ships a release that depends on a fixed `@bacons/xcode`.

## Findings (`app/`)

"Reaches app?" means: is the package part of the JS bundle that runs on the phone. All 31 npm audit entries come from two advisories; the rest are derived ("via") entries. Fixing either needs a major downgrade or upgrade of Expo or Jest (npm's suggested fixes `expo@52.0.49`, `jest@29.7.0` and `jest-expo@58.0.6` are wrong or majors), so they are accepted.

| Package | Severity | Advisory | Dependency path | Reaches app? | Action | Rationale |
|---|---|---|---|---|---|---|
| glob 10.5.0 and 13.0.6 (several copies) | moderate | GHSA-3g3m-2fjr-6pw4 (AbortSignal cancellation bypass allows post-timeout filesystem traversal; `>=9.0.0 <=14.0.1`) | jest > @jest/core, @jest/reporters, jest-config, jest-runner, jest-runtime, jest-snapshot > test-exclude > glob; jest-expo > glob; @bacons/apple-targets > glob, @expo/config, @expo/config-plugins | n | Accepted | Only matters when a caller aborts a glob with an AbortSignal and expects it to stop. Used on a developer machine or CI over our own repo files. Fix is glob 14.0.2 or later, which parents pin below (`^10`, `^13`); an override would force a major across Jest and Expo packages. Revisit on Jest or Expo SDK upgrade. |
| minimatch 9.0.9 and 10.2.6 (several copies) | moderate | GHSA-g3hv-75wg-m249 (DoS via globparts amplification; `>=7.0.0 <11.0.1`) | jest family > minimatch; test-exclude > glob > minimatch; @expo/fingerprint > minimatch; @typescript-eslint/typescript-estree > minimatch; @bacons/apple-targets > minimatch | n | Accepted | Needs an attacker-controlled glob pattern. Patterns here come from our own Jest, ESLint and Expo config. Fix is minimatch 11, a major that the parents do not accept. |
| expo | moderate (derived) | via @expo/fingerprint > minimatch | direct dependency | n for the flagged code | Accepted | Flagged only through the minimatch row. `@expo/fingerprint` is CLI tooling. npm's suggested fix (`expo@52.0.49`) is a major downgrade; ignore it. |
| @expo/fingerprint | moderate (derived) | via minimatch | expo > @expo/fingerprint | n | Accepted | Build tooling. |
| @bacons/apple-targets, @bacons/apple-targets > @expo/config, @expo/config-plugins, @expo/prebuild-config | moderate (derived) | via glob / minimatch | direct dependency (config plugin that generates the widget target) | n | Accepted | Runs at prebuild only. The package is not imported by app code. No newer release exists (5.0.0 is latest). |
| jest, jest-cli, jest-config, jest-runner, jest-runtime, jest-snapshot, jest-circus, jest-resolve-dependencies, @jest/core, @jest/expect, @jest/globals, @jest/reporters, @jest/transform, babel-jest, babel-plugin-istanbul, test-exclude, jest-watch-typeahead, jest-expo | moderate (derived) | via glob / minimatch | devDependencies | n | Accepted | Test tooling; runs only locally and in CI. The advisory chain goes through `test-exclude` and `jest-config`. |
| @typescript-eslint/eslint-plugin, parser, type-utils, typescript-estree, utils | moderate (derived) | via minimatch (typescript-estree) | eslint-config-expo > @typescript-eslint/* | n | Accepted | Lint tooling only; lints our own files. |

Resolved in this PR (no longer reported): `zod` < 4.6.6 under `@expo/cli` (high, previously accepted), `node-forge` <= 1.4.2 (Expo CLI), `@xmldom/xmldom` under `@expo/plist` via `expo` and `@expo/config-plugins` (high), `@xmldom/xmldom` 0.7.13 and `uuid` 8.3.2 under `@bacons/xcode` (high / moderate; override above), and the `@expo/cli`, `@expo/plist`, `@bacons/xcode` derived entries. The low `deepmerge` findings from 2026-10-28 are no longer reported.

## Findings (`ai/`, `supabase/`)

None. `npm audit` reports 0 vulnerabilities for both. `supabase/` contains only the `supabase` CLI and `deno` as dev dependencies.

## Policy for future triage

- Fix only within the semver range of the parent: lockfile-only `npm update <pkg>`, or a minimal `overrides` entry pinned to an exact patched version. Avoid overrides on Expo-managed packages.
- Anything that reaches the shipped bundle (runtime dependency of app code) is treated as a blocker regardless of severity.
- Dev-tooling findings are accepted with a written rationale and re-checked when Expo SDK or Jest are upgraded.
