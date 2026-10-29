# app/

Expo (React Native, TypeScript) app. Owned by the Mobile app workstream; native Swift targets go in `app/targets/` and are owned by the Native iOS workstream.

Starts from: the UI prototypes, stories US-01 to US-11 and US-19, and the API contracts.

## Run it

```sh
npm ci
npx expo start        # then press i for the iOS Simulator (macOS)
```

### Simulator build without local CocoaPods (EAS)

`eas.json` has one profile, `simulator`: an unsigned iOS Simulator build made on Expo's servers, so no Apple account, CocoaPods or Ruby is needed locally. It uses the mock backend: `.env.local` is git-ignored, so EAS doesn't upload it. Don't add `EXPO_PUBLIC_SUPABASE_*` variables to this profile or as EAS environment variables until US-10.

```sh
cd app
npx eas-cli@latest login
npx eas-cli@latest build -p ios --profile simulator
```

When it finishes, the CLI offers to install the build on a booted Simulator; or download the `.tar.gz`, unpack it and drag the `.app` onto the Simulator. To reload JavaScript changes without rebuilding, run `npx expo start --dev-client` only after `expo-dev-client` is added (not yet).

By default the app runs on an in-memory mock backend with synthetic tasks, so no Supabase project or sign-in is needed. To use a real project, see "Live backend" below.

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
| `src/api/` | `ApiClient` interface for every Phase 0 contract, the mock, and the live Supabase client (`supabase.ts`, realtime in `supabaseArrivals.ts`, Keychain session storage in `secureSessionStorage.ts`, backend choice in `live.ts` and `index.ts`) |
| `src/features/capture/` | Capture sheet (US-01 voice, US-02 typing), the `SpeechRecognizer` interface and its mock, and the capture store (offline queue, results for Today, US-03) |
| `src/features/today/` | Today screen (US-04), the Start here rule and grouping logic, undo (US-09) |
| `src/features/task/` | Task detail (US-05): inline editing with autosave, script card, "Found for you", Done / Tomorrow / Drop with undo |
| `src/features/checkin/` | Evening check-in (US-07, US-12): card stack, still-need-this cards, drop reasons, summary |
| `src/theme/` | Light and dark palettes; contrast is tested |
| `src/lib/log.ts` | The only logger: IDs and codes only, never titles, notes or transcripts |
| `src/lib/nonce.ts` | Sign in with Apple nonce: secure random raw value plus its SHA-256 hex (client side; sign-in itself is US-10) |

## Capture (US-01, US-02, US-03)

- **Speech.** The sheet depends on `SpeechRecognizer` (`src/features/capture/speech/`). `createSpeechRecognizer()` returns the on-device native module (`modules/tasklings-speech/`, Swift, SFSpeechRecognizer with on-device recognition required) when it is built in, and the scripted mock in Jest, Expo Go and web. No server fallback: audio never leaves the phone. Don't add a speech library. The module needs the microphone and speech-recognition usage strings in `app.json` (present).
  - **Language: English only for the MVP.** It uses the device locale if that is an English variant with on-device support, else en-US if that has on-device support, else `start` fails with `unavailable`.
  - **Interruptions never lose a note.** A call, Siri, backgrounding, a route change, a media reset, a recognizer stop or the 2-minute cap ends the run with `onEnded`, not `onError`. The sheet then saves the text heard so far exactly like a release; if nothing was heard it just returns to idle with no message. `onError` is only for real failures: permission denied, on-device recognition unavailable, engine start failure.
- **After saving.** `CaptureStore` generates `capture_id` (secure random UUID), sends `captured_at` and the device time zone, and tells Today when the tasks arrive. Results reach the app through `CaptureArrivals` (`src/api/arrivals.ts`); the mock implements it with a delay and the live client over Supabase realtime.
- **Source.** `process-capture` takes an optional `source` (`voice`, `text`, `siri`, `widget`; default `voice`), stored in `captures.source`. The sheet sends `voice` for spoken notes and `text` for typed ones. Anything else is `invalid_request`.
- **Undo.** "Added N tasks" · Undo calls `undo_capture(capture_id)`, one call that deletes the capture's tasks. It works for 30 seconds after the capture finished and only while every task is still open and unedited. If it raises `undo_expired` the app says nothing and the tasks stay; any other failure shows "Couldn't undo. Try again." and reloads Today.
- **Opening the sheet.** A tap on Today's mic opens it and starts locked recording at once; a long press opens it idle (the hold can't carry over to the sheet's own mic).
- **No result.** If no result arrives within 60 s of the 202, the Sorting row becomes "Couldn't sort your note · Try again"; Try again resends the same `capture_id`. A late result still completes the capture.
- **Offline.** A capture that fails with `network_error` stays in the store's queue and is sent again when the app returns to the foreground. The queue is in memory only: persistent storage comes with the local SQLite store.
- **Mock results by keyword** (`src/api/syntheticCapture.ts`): "nothing to add", "never mind" or "thinking out loud" gives zero tasks; "garbled", "fallback" or "mumbling" gives one `needs_review` task; anything else gives one task per clause (up to 10). The mock recognizer's `empty` and `fallback` scripts use these words.

## Task detail and Evening check-in (US-05, US-07, US-12)

- **Task detail** loads its task from `today_tasks()` (there is no get-task contract). Title edits save after 800 ms of quiet or on blur; chip menus save at once. A failed save puts the old value back and shows an inline error. Edits never send `effort_min_initial`.
- **Not in the API yet:** the capture transcript ("From your voice note" is omitted), enrichments ("Found for you" reads placeholder data from `mockEnrichments` in `src/api/fixtures.ts`) and `profiles.brief_time` (the check-in summary shows 8:00 with a note).
- **Today reloads** when it regains focus (`refreshKey` on `TodayScreen`), so a cleared "Needs a look" card disappears at once.
- **Check-in** builds up to 7 cards (still-need-this, then due today, then most carried); the rest roll over on their own. Swipe right is Done, left is Tomorrow; the buttons do the same and are the accessible path. The "Remind me in 1 hour" notification action is native/push work and is not part of this screen.

## Live backend

The app uses the mock **unless both** variables below are set to non-empty values. Copy `.env.example` to `.env.local` and fill them in:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Project URL, `https://<ref>.supabase.co`. `http://localhost` / `http://127.0.0.1` is accepted for a local `supabase start`; any other `http://` URL is refused. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The project's public anon (publishable) key. |

**Both are public by design.** Expo inlines `EXPO_PUBLIC_*` variables into the JavaScript bundle at build time, so they ship in every copy of the app; the anon key only identifies the project, and row-level security plus the user session do the protecting. `.env.example` holds placeholders only; `.env.local` is git-ignored. The service-role key must never go here: the client refuses a service-role JWT or an `sb_secret_` key (`invalid_config`). If one variable is set and the URL is invalid, the app fails at startup instead of silently falling back to the mock.

- **No sign-in yet.** Sign in with Apple is US-10. Until it lands the live client has no session, so every call except `signInWithApple` fails at once with `unauthenticated` (HTTP 401 semantics) without sending a request. The anon key is never used as a bearer token. To exercise the live client before US-10, sign in from a dev script against a local project; there is no UI for it.
- **Session storage (security review S-12).** The Supabase session (access and refresh tokens) is stored only in the iOS Keychain through `expo-secure-store`, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: readable only while the device is unlocked, not synced to iCloud, not restored onto another device. A session is longer than SecureStore's 2048 bytes per value, so `secureSessionStorage.ts` splits it into 512-character chunks. AsyncStorage is never used; ESLint rejects importing it.
- **Client.** `@supabase/supabase-js` (pinned) covers everything: `rpc()` for `today_tasks`, the task RPCs and `undo_capture`; `from('tasks').update()` for task edits; `functions.invoke()` for the edge functions; realtime for `CaptureArrivals`. `react-native-url-polyfill` is imported by `supabase.ts` because supabase-js builds URLs with `URL.searchParams`, which React Native's built-in `URL` only approximates. Token refresh runs only while the app is active.
- **Errors.** PostgREST errors map to the standard `{code, message}` shape (stable code from `hint`, see `supabase/README.md`), edge-function errors come through unchanged, a request that never got an answer is `network_error`, and server text for platform errors is never passed on.
- **Realtime.** `CaptureArrivals` subscribes to the user's own `captures` row (`id=eq.<capture_id>`). When its status becomes `done` it reads the capture's tasks and delivers them once; on every channel (re)join it also reads the status once, so a result that finished while the connection was down is not missed. A `failed` capture is not delivered: the existing 60-second timeout offers Try again. Row-level security applies to realtime, so another user's capture id produces no events. This needs the `captures` table in the `supabase_realtime` publication (migration `20261027000700`).
- **Not covered by automated tests:** a real round trip against a Supabase project (realtime in particular). Tests use a fake `fetch` and a fake realtime channel.

## Rules for this folder

- Screens depend on `ApiClient` only. Don't add an endpoint, column or field the PRD doesn't define.
- No analytics or crash-reporting SDKs. `console` is a lint error outside `src/lib/log.ts`.
- Over-the-air updates are off (`updates.enabled: false`); EAS Update is not configured.
- Bundle ID is `com.shifasmkhan.tasklings`. There is no app icon yet (owner decision); Expo shows its default.
- Pin exact versions and commit `package-lock.json`.
