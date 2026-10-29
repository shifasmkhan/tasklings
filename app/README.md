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
| `src/app/` | Expo Router routes: Today (`index`), `capture`, `task/[id]`, `check-in`, `settings` |
| `src/api/` | `ApiClient` interface for every Phase 0 contract, the mock, and the live Supabase client (`supabase.ts`, realtime in `supabaseArrivals.ts`, Keychain session storage in `secureSessionStorage.ts`, backend choice in `live.ts` and `index.ts`) |
| `src/features/capture/` | Capture sheet (US-01 voice, US-02 typing), the `SpeechRecognizer` interface and its mock, the capture store (offline queue, results for Today, US-03), and the system entry-point glue (`captureLaunch.ts`, `intentLaunch.ts`, `IntentLaunchHandler.tsx`) |
| `targets/widget/` | Swift widget extension (`@bacons/apple-targets`): Home Screen mic widget, Control Center / lock screen / Action Button control; `_shared/` holds the App Intent and App Shortcut, linked into the app too |
| `modules/` | Local Expo modules: `tasklings-speech` (on-device recognition) and `tasklings-intents` (the "launched by our own intent" flag) |
| `src/features/today/` | Today screen (US-04), the Start here rule and grouping logic, undo (US-09) |
| `src/features/task/` | Task detail (US-05): inline editing with autosave, script card, "Found for you", Done / Tomorrow / Drop with undo |
| `src/features/settings/` | Settings (US-11) and Recently dropped (US-09): times, restore, export and delete, with the Apple re-sign-in seam and the share-sheet export |
| `src/features/onboarding/` | First-run onboarding (US-19): flow, first-run flag, notification permission interface; sign-in uses the shared `features/auth/appleCredential.ts` |
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

## Entry points (US-01)

All of them open the existing Capture sheet; none forks it.

| Entry point | What it is | Where |
| --- | --- | --- |
| **Siri / Shortcuts / Spotlight** | App Intent "Add a task" with App Shortcut phrases "Add a task in Tasklings" and "New Tasklings note" | `targets/widget/_shared/AddTaskIntent.swift` (app + extension), `plugins/app-shortcuts/TasklingsShortcuts.swift` (app target only, added by `plugins/withAppShortcuts.js`) |
| **Action Button** | Settings > Action Button > Shortcut > Tasklings > Add a task, or > Controls > Tasklings > Add a task | same intent / the control below |
| **Control Center and lock screen control** (iOS 18+) | `ControlWidgetButton` running the intent | `targets/widget/CaptureControl.swift` |
| **Home Screen widget** (small) | App name and a mic button (`Button(intent:)`). Static, no data: counts and the next task are US-06 and need an App Group summary store, which is not added | `targets/widget/MicWidget.swift` |
| **Deep link** `tasklings://capture` | Opens the sheet **idle**, like a long press. Opened cold, there is no screen under it, so closing it goes to Today (and Today sends a first-run user to onboarding) | `src/app/capture.tsx` |

The widget extension targets iOS 17; the Control is wrapped in `if #available(iOS 18.0, *)` in the widget bundle. The app itself targets iOS 16.4.

### Auto-start rule (security)

Starting the microphone must never be triggerable by another app or a web page.

- **Only our own App Intent starts recording on open.** The intent (`openAppWhenRun`, foreground only; there is no background-recording intent) writes a timestamp to the app's private `UserDefaults` (not an App Group) and posts an in-process notification. The `tasklings-intents` module's `consumePendingLaunch()` returns true **once** per run and only if the timestamp is under 15 s old. `IntentLaunchHandler` checks it at startup (before the first render), on the `onIntentLaunch` event and when the app becomes active, then opens `/capture` and arms auto-start.
- **No URL parameter can start recording.** `src/app/capture.tsx` reads no route params at all; `?start=lock`, `?hint=...` and anything else are ignored. In-app starts (Today's tap, onboarding) use the same one-shot in-process flag (`captureLaunch.ts`, expires after 5 s, cleared by the sheet after reading) instead of the old `start=lock` URL parameter.
- No new permissions: the existing microphone and speech strings cover it. The first ever run still shows the permission prompts from the sheet, and an intent launch before onboarding is complete is dropped (onboarding first).

### Which process runs the intent

`AddTaskIntent` is in both the app and the extension, with `openAppWhenRun`; on iOS 26+ it also declares `supportedModes = .foreground` so the system runs `perform()` in the app, where the private flag can be read. Before iOS 26, widget and control runs rely on `openAppWhenRun` alone. If a run ever lands in the extension process, the flag never reaches the app: the app opens and the sheet does not auto-record (safe, but not what we want). There is no App Group to bridge it, by design.

**Verified only by the CI build (compiles, not exercised): need a device check** on iOS 18 to 25 and on iOS 26: Home Screen widget button, Control Center control, lock screen control, Action Button, Siri/Shortcuts phrases, and that each opens the sheet already recording.

### Nothing existing is shown

After an intent launch, Today renders a neutral background (not the task list) until the Capture sheet closes, however it closes. On a warm start the app also dismisses back to the root first, so no task detail sits behind the sheet. The Home Screen widget and the control read no task data at all.

### Locked device

`openAppWhenRun` means iOS asks for Face ID / passcode before it foregrounds Tasklings from the lock screen or Action Button. That is accepted for the MVP: capture starts as soon as the app is up. A background-recording intent is out of scope.

### Offline

The sheet saves through `CaptureStore`, so an offline capture waits in the queue and is sent when the app returns to the foreground (see "Offline" above).

### Try each one in the Simulator

Rebuild the native app first (`npx expo prebuild --platform ios --clean`, then run it); the widget extension is new. Free Apple accounts: every extension needs its own App ID, and `ios.appleTeamId` should be set in `app.json` for device builds (the build warns while it is missing).

- **Shortcuts app:** open Shortcuts > App Shortcuts (or search "Tasklings") and run "Add a task". Tasklings opens with the sheet recording. The Action Button can be pointed at it on a device.
- **Control Center (iOS 18+ Simulator):** swipe down, long-press empty space > Add a Control > Tasklings > Add a task. For the lock screen, long-press the lock screen > Customize > Lock Screen and replace a bottom control. Tapping it asks to unlock (the Simulator accepts Face ID with Features > Face ID > Matching Face) and then opens recording.
- **Widget gallery:** long-press the Home Screen > + > Tasklings > small "Add a task" widget. Tap the mic.
- **Siri:** say or type "Add a task in Tasklings" (Simulator: Siri via Device > Siri).
- **Deep link:** `xcrun simctl openurl booted "tasklings://capture?start=lock"` must open the sheet idle.

What can't be checked without a physical iPhone: the Action Button itself, the real lock screen unlock flow, and the "recording starts within 1 s" timing on a cold launch.

## Task detail and Evening check-in (US-05, US-07, US-12)

- **Task detail** loads its task from `getTask(id)`, so it also opens tasks that aren't on Today. It shows "From your voice note" (the capture's transcript, when there is one), the script card for any task with a `script`, and "Found for you" with phone, address and hours only: `url` and `note` enrichments and every `source_url` are never rendered (PRD decision: no web links yet). Title edits save after 800 ms of quiet or on blur; chip menus save at once. A failed save puts the old value back and shows an inline error. Edits never send `effort_min_initial`.
- **Brief time.** The check-in summary reads `getProfile().briefTime`; if the profile can't be read the "Your brief will be ready at ..." line is left out.
- **Today reloads** when it regains focus (`refreshKey` on `TodayScreen`), so a cleared "Needs a look" card disappears at once.
- **Check-in** builds up to 7 cards (still-need-this, then due today, then most carried); the rest roll over on their own. Swipe right is Done, left is Tomorrow; the buttons do the same and are the accessible path. The "Remind me in 1 hour" notification action is native/push work and is not part of this screen.

## Settings and Recently dropped (US-11, US-09)

Route `settings`, opened from the gear in Today's header (`aria-label` "Settings"). Contracts used (PRD, proposed 2026-10-28, using only existing RLS and column grants):

| `ApiClient` method | Live implementation |
| --- | --- |
| `getProfile()` | `profiles` select of `display_name, timezone, brief_time, checkin_time` (RLS: own row). Postgres `HH:MM:SS` is normalised to `HH:MM`. |
| `updateProfileTimes({ briefTime?, checkinTime? })` | `profiles` update of `brief_time` / `checkin_time` only, `eq('user_id', session user)`. Values are checked as `HH:MM` 00:00 to 23:59 before any request; invalid is `invalid_request`. |
| `getTask(id)` | `tasks` row by id, plus the capture's `transcript` and the task's `task_enrichments`. Unknown id (or another user's) is `not_found`. |
| `recentlyDropped()` | `tasks` with `status = 'dropped'` and `updated_at` in the last 30 days, newest first, limit 100. Restore is `undoTask`. |

- **Times.** A native compact time picker (`@react-native-community/datetimepicker`) per time. A change shows at once and saves; saves go one at a time. On failure the old time comes back and an inline message appears. Footnote: "Reminders start once notifications are turned on." (pushes are US-06).
- **Recently dropped.** Restore calls `undo_task`, removes the row and shows a short confirmation. Empty state: "Nothing dropped in the last 30 days."
- **Export and delete** both start with a fresh Sign in with Apple through `AppleCredentialSource` (`appleCredential.ts`), then call `signInWithApple` and the edge function, because the server needs a session under 5 minutes old. Until US-10 the default source returns a placeholder token: the mock accepts it, the live client is refused and the screen says "Sign in with Apple isn't set up yet." A `reauth_required` answer from the server asks the person to sign in again. Export writes the JSON to the app cache, opens the iOS share sheet on that file (React Native `Share`, `expo-file-system` for the file) and deletes the file afterwards; its contents are never logged. Delete asks in a bottom sheet first; on success the live client clears its Keychain session (local sign-out) and the screen returns to Today. TODO(US-19): go to first-run onboarding instead, once that route exists. The mock's `deleteAccount` empties its tasks and resets the profile.
- **Native modules.** `@react-native-community/datetimepicker` and `expo-file-system` are native: rebuild the dev/simulator build after pulling this.
## Onboarding (US-19)

Welcome, Sign in, Times, Notifications, First note, then Today: five screens, no typing, no animation (a single screen swaps its content, so Reduce Motion needs no special case). Every step can be skipped except sign-in.

- **First-run gate.** `onboarding_complete` lives in expo-secure-store (`onboardingStore.ts`; AsyncStorage is banned). `app/index.tsx` redirects to `/onboarding` while the flag is absent, so Today is not mounted until onboarding ends. The flag is written only at the end of the last step (first note saved, or Skip for now). An unreadable flag counts as absent.
- **After Delete account.** Settings closes, then clears the flag, so the gate sends the person back to onboarding.
- **Re-run it in the Simulator.** In a dev build, long-press the "Today" title: it clears the flag and returns to onboarding.
- **Sign in.** The button uses Apple's styling (black on light, white on dark, logo glyph) and calls `ApiClient.signInWithApple` with a nonce from `lib/nonce.ts`. The credential comes from `AppleCredentialSource` in `src/features/auth/appleCredential.ts`, the same seam Settings uses, so US-10 replaces one place; it is a placeholder because `expo-apple-authentication` is not added yet. The mock backend accepts it; a live backend answers `unauthenticated`, shown as "Sign in with Apple isn't set up yet."
- **Times.** Brief 8:00 AM and check-in 8:30 PM are pre-filled; Earlier / Later buttons move 15 minutes. Continue saves with `ApiClient.updateProfileTimes` (US-11); a failure shows an inline error and Continue retries.
- **Notifications.** `NotificationPermission` (`notifications.ts`) has a mock only. Do not add `expo-notifications` before the paid Apple membership: it adds the push entitlement, which breaks free-tier device installs. Allow, Not now, a denial or an error all continue.
- **Microphone and speech.** The native speech module has no separate permission call; `start()` asks. The First note screen says so, and the Record button opens the existing Capture sheet (`/capture?start=lock&hint=first`) with the example line "Try: Call the dentist and buy milk on the way home". Typing stays available in the sheet. When the sheet closes after a save, onboarding ends and Today shows the usual "Added N tasks" (or "Nothing to add") toast. Closing the sheet without saving stays on the step.

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
