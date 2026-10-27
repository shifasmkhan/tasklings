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
| `src/features/capture/` | Capture sheet (US-01 voice, US-02 typing), the `SpeechRecognizer` interface and its mock, and the capture store (offline queue, results for Today, US-03) |
| `src/features/today/` | Today screen (US-04), the Start here rule and grouping logic, undo (US-09) |
| `src/theme/` | Light and dark palettes; contrast is tested |
| `src/lib/log.ts` | The only logger: IDs and codes only, never titles, notes or transcripts |
| `src/lib/nonce.ts` | Sign in with Apple nonce: secure random raw value plus its SHA-256 hex (client side; sign-in itself is US-10) |

## Capture (US-01, US-02, US-03)

- **Speech.** The sheet depends on `SpeechRecognizer` (`src/features/capture/speech/`). The app uses the scripted mock until the Native iOS workstream ships the on-device module; the swap point is `createSpeechRecognizer()` in `speech/index.ts`. Don't add a speech library. The module also needs the microphone and speech-recognition usage strings in `app.json`.
- **After saving.** `CaptureStore` generates `capture_id` (secure random UUID), sends `captured_at` and the device time zone, and tells Today when the tasks arrive. Results reach the app through `CaptureArrivals` (`src/api/arrivals.ts`), the stand-in for the realtime channel; the mock API implements it with a delay.
- **Opening the sheet.** A tap on Today's mic opens it and starts locked recording at once; a long press opens it idle (the hold can't carry over to the sheet's own mic).
- **No result.** If no result arrives within 60 s of the 202, the Sorting row becomes "Couldn't sort your note · Try again"; Try again resends the same `capture_id`. A late result still completes the capture.
- **Offline.** A capture that fails with `network_error` stays in the store's queue and is sent again when the app returns to the foreground. The queue is in memory only: persistent storage comes with the local SQLite store.
- **Mock results by keyword** (`src/api/syntheticCapture.ts`): "nothing to add", "never mind" or "thinking out loud" gives zero tasks; "garbled", "fallback" or "mumbling" gives one `needs_review` task; anything else gives one task per clause (up to 10). The mock recognizer's `empty` and `fallback` scripts use these words.

## Rules for this folder

- Screens depend on `ApiClient` only. Don't add an endpoint, column or field the PRD doesn't define.
- No analytics or crash-reporting SDKs. `console` is a lint error outside `src/lib/log.ts`.
- Over-the-air updates are off (`updates.enabled: false`); EAS Update is not configured.
- Bundle ID is `com.shifasmkhan.tasklings`. There is no app icon yet (owner decision); Expo shows its default.
- Pin exact versions and commit `package-lock.json`.
