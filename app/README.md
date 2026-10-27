# app/

Expo (React Native, TypeScript) app. Owned by the Mobile app workstream; native Swift targets go in `app/targets/` and are owned by the Native iOS workstream.

Starts from: the UI prototypes, stories US-01 to US-11 and US-19, and the API contracts.

## Run it

```sh
npm ci
npx expo start        # then press i for the iOS Simulator (macOS)
```

The app runs on an in-memory mock backend with synthetic tasks, so no Supabase project or sign-in is needed yet.

## Checks (the same ones CI runs)

```sh
npm run typecheck
npm run lint
npm run test:ci
```

## Layout

| Path | What lives there |
| --- | --- |
| `src/app/` | Expo Router routes: Today (`index`), `capture`, `task/[id]`, `check-in` |
| `src/api/` | `ApiClient` interface for every Phase 0 contract, the mock, and a thin Supabase stub |
| `src/features/today/` | Today screen (US-04), the Start here rule and grouping logic, undo (US-09) |
| `src/theme/` | Light and dark palettes; contrast is tested |
| `src/lib/log.ts` | The only logger: IDs and codes only, never titles, notes or transcripts |

## Rules for this folder

- Screens depend on `ApiClient` only. Don't add an endpoint, column or field the PRD doesn't define.
- No analytics or crash-reporting SDKs. `console` is a lint error outside `src/lib/log.ts`.
- Over-the-air updates are off (`updates.enabled: false`); EAS Update is not configured.
- Bundle ID `com.example.tasklings` is a placeholder until the owner picks one. There is no app icon yet (owner decision); Expo shows its default.
- Pin exact versions and commit `package-lock.json`.
