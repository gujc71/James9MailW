# James9Mail Feature Tests

[한국어](README_ko.md)

Playwright (TypeScript). There are **three layers**, and each layer needs different things.

| Project | What it covers | What it needs | When to run |
|---|---|---|---|
| `mock` | The whole UI — 9 settings tabs, 6 admin tabs, list, reading, compose, actions | **Nothing** (client only) | Every commit |
| `api` | Endpoint contracts, permissions, input validation, Sieve round-trips | MariaDB (+ James for writes) | Every PR |
| `e2e` | The full path: sign in → send → receive → read → read receipt | MariaDB + James (WebAdmin, SMTP) | Nightly, before release |

Because the `mock` layer intercepts all of `/api/**`, it verifies the UI end to end without a DB, James or a filesystem.
This keeps the UI tests from going red for reasons unrelated to the UI when any one of those three is down.

## Running

```bash
cd test
npm install
npx playwright install chromium

npm test              # mock layer (default)
npm run test:ui       # while writing tests — step-by-step time travel + selector picker
npm run test:headed   # in a real browser window (for demos)
npm run report        # results of the last run (failures include screenshots, video and traces)

J9_BACKEND=1 npm run test:api    # also starts the web server
J9_BACKEND=1 npm run test:e2e
npm run typecheck
```

If what they need is not running, `api` and `e2e` specs are **skipped, not failed**. The report records what was missing —
"red because the environment is missing" is never mixed up with "red because the code is wrong".

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `J9_WEB` | Client address | `http://localhost:5173` |
| `J9_API` | Web server address | `http://127.0.0.1:4000` |
| `J9_BACKEND=1` | Also start the web server (4000) | off |
| `J9_NO_SERVE=1` | Do not start the dev server (already running) | off |
| `J9_SLOWMO` | Delay between actions (ms). `300` for demos | `0` |
| `J9_ADMIN_USER` / `J9_ADMIN_PW` | Admin account used by api and e2e | `admin@example.com` / `TEST1234` |

## Layout

```
test/
  playwright.config.ts   3 projects (mock, api, e2e), webServer, reporters
  fixtures/
    index.ts             mock-layer fixtures (state · page · shell · pageErrors)
    mockApi.ts           fake server that handles all of /api/** + its state
    factories.ts         response builders. Types are imported directly from client/src/api/types.ts
    eml.ts               raw message (.eml) generator — multipart, inline images, TNEF, Korean subjects, events
    multipart.ts         extracts fields from a send request (multipart)
    api.ts               api-layer fixtures (signed-in request context, skip decisions)
    e2e.ts               e2e-layer fixtures (UI sign-in, finishing a send, skip decisions)
  pages/                 POM per screen (Shell · Mailbox · Reading · Compose · Settings · Admin · Receipts)
  specs/mock|api|e2e/
```

## Gotchas when testing this app

Only things we actually ran into while building the tests.

- **Do not intercept `/api/**` with a glob.** The dev server also serves source modules, so addresses like
  `/src/api/client.ts` exist. A glob catches the app bundle too and the page never loads.
  Use `page.route((url) => url.pathname.startsWith('/api/'), ...)` and check the **pathname**.
- **The message body is inside a sandboxed iframe.** Body text is only visible through
  `frameLocator('iframe[title="mail-body"]')`. Since it is `blob:`/`srcdoc`, **the body looks empty in Trace Viewer
  snapshots** — reading specs save a separate screenshot with `attachBodyShot()`.
- **UI text is pinned to English.** Even though the default language is English, `localStorage('j9-locale')` and the
  `locale` from `/api/me` change the UI. Fixtures pin it to `en` before navigating.
- **There is not a single `data-testid`.** So selectors rely on role, text and class. Inputs in settings and admin use a
  `.form-row` structure where the `<label>` does not wrap the `<input>`, so `getByLabel` does not work —
  use `formRowInput()` from `pages/helpers.ts`.
- **Playwright dismisses `confirm()` and `prompt()` by default.** Left as is, delete, empty and add-mailbox silently do
  nothing. Call `acceptDialogs(page)` first.
- **Dropdown menus are portal-rendered into body.** Do not look near the button; look for `ul.menu-list`. The menu
  measures its position and moves once, and if the table behind it re-renders, it detaches entirely, so `pickFromMenu()`
  retries the whole "open and pick" sequence.
- **Button names match partially by default.** `name: 'Delete'` also matches `Delete permanently`, and
  `name: 'Mail'` also matches the site name `James9Mail`. Use `exact: true` with strings.
- **Some places only change after a save completes.** A rule's "Enabled" checkbox changes value after save → refetch,
  so `click()` it and then check the result instead of using `uncheck()`.
- **Toasts disappear after 1.2 seconds.** Instead of asserting on toasts, check the request sent to the server or the UI state.
- **The list is virtually scrolled.** Only visible rows are in the DOM, so instead of counting messages, check that the
  expected messages are visible.
- **Sync polling runs every 30 seconds.** When waiting for new mail in e2e, do not wait for the poll; reopen the screen.

## Test data

The `mock` layer creates a fresh `state` for every test and a fresh browser context each time, so tests do not interfere
with each other. A leftover Dexie mirror (IndexedDB) would pollute list assertions, so `storageState` is not reused.

The `api` and `e2e` layers use the three accounts from `server/sql/02-seed.sql` (`admin@`, `user1@`, `user2@example.com`,
password `TEST1234`). Mailboxes and subjects created by e2e carry a run tag (`e2e-<time>`) so they do not mix with
leftovers from earlier runs.

Running e2e with multiple workers would make them touch the same account's mailboxes, so the `e2e` project runs serially
with 1 worker. If parallelism becomes necessary, extend it by creating an account per worker with `POST /api/admin/users`
and deleting it at the end.

## Defects found and fixed while building these tests

Both are fixed, and specs guard against regressions.

- **Date/time and location of appointment mail were not shown.** `mime/parse.worker.ts` only checked attachment content
  with `instanceof ArrayBuffer` and otherwise converted it with `String(content)`. postal-mime returns a `Uint8Array`, so the
  text/calendar part became a list of numbers like `"66,69,71,…"` and DTSTART could not be found — the event box appeared
  but was empty. Fixed to slice only the range the view points to (`toArrayBuffer`).
  → `specs/mock/reading.spec.ts` "appointment mail shows date/time and location"
- **The "Save to Spam" rule lost its action type when read back.** In Sieve it is just `fileinto`, so `sieve/parse.ts`
  always returned `FILEINTO`, and the edit dialog showed "Move to Trash". Only on the blocked-senders screen, where the
  distinction actually exists, a target of `Spam` is restored as `SPAM`.
  → three specs in `specs/api/rules-roundtrip.spec.ts` (three blocked-sender actions, keeps trash, keeps filter)

## Extending

- When you add a new screen, add a spec to `mock` first. Collect response types in `factories.ts` and import them from
  `client/src/api/types.ts` — if the shape of a server response changes, it surfaces first as a type error.
- Paths `mockApi.ts` does not handle are collected in `state.unhandled` and return 404. When a new endpoint appears,
  it does not pass silently; it shows up here.
- It is cheaper to add `data-testid` starting where selectors keep breaking. There is no need to add them everywhere —
  only to elements whose text changes with i18n and elements that share a name with others.
