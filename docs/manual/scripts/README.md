# Manual Screenshot Scripts

[한국어](README_ko.md)

Scripts that use Playwright to retake the pictures (`../ko/images`, `../en/images`) in the [Korean manual](../ko/README.adoc)
and the [English manual](../en/README.adoc). When the UI changes, run these scripts to regenerate the pictures.

## Setup

- The webmail server (4000), the Vite dev server (5173), James9Mail and MariaDB must be running.
- The test accounts `admin`, `user1` and `user2` (`@example.com`, password `TEST1234`) must exist (`server/sql/02-seed.sql`).

```bash
cd docs/manual/scripts
npm install
npx playwright install chromium
```

## Running

Each language has its own sample data (mail subjects and bodies, events, account display names). Samples from the other
language must be deleted before capturing a language so they do not mix into the pictures, so you normally use the
`all:*` commands that do everything at once.

```bash
npm run all:ko     # clean up samples → Korean samples → Korean capture → ../ko/images
npm run all:en     # clean up samples → English samples → English capture → ../en/images
```

> The samples of the last language you ran stay in the test accounts. To leave them in the usual state (Korean), run `all:ko` last.

| Command | What it does |
|---|---|
| `npm run cleanup` | Finds sample mail, events and tasks of every language by subject and deletes them |
| `npm run seed` / `seed:en` | Creates Korean / English samples. Also changes account display names (관리자·사용자1·사용자2·사용자3 ↔ Admin·User 1·User 2·User 3). user3 is changed through the admin API only if the account exists |
| `npm run capture` / `capture:en` | Captures every Korean / English screen |

To capture a single chapter, set `MANUAL_LOCALE` and run the script directly.

| Script | What it covers | Pictures |
|---|---|---|
| `cap-mail.mjs` | Chapters 1 and 2 (sign-in, screen layout, list, reading) | `01-*`, `02-*` |
| `cap-compose.mjs` | Chapter 3 (composing mail, read receipts). **Does not actually send mail** | `03-*`, `02-appointment-done` |
| `cap-cal.mjs` | Chapter 4 (calendar, tasks, CalDAV) | `04-*` |
| `cap-settings.mjs` | Chapter 5 preferences and admin screens. **Never clicks Save** | `05-*`, `A-*` |

```bash
MANUAL_LOCALE=en node cap-cal.mjs     # e.g. retake only the English calendar pictures
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MANUAL_LOCALE` | `ko` | `ko` or `en`. UI language, sample data and output folder |
| `MANUAL_WEB_URL` | `http://localhost:5173/` | Address of the webmail UI to capture |
| `MANUAL_API_URL` | `http://127.0.0.1:4000` | API server called by seed and cleanup |
| `MANUAL_PASSWORD` | `TEST1234` | Test account password |

## What captures leave behind in test data

- `cap-compose.mjs` — user1 responds **Accept** to the design review invitation (the event is added to the calendar).
- `cap-cal.mjs` — creates a recurring event (weekly team meeting) and 3 tasks in user1's calendar. They are not recreated if they already exist.
- The CalDAV and CardDAV enable checkboxes are restored after the instruction dialog is captured.
- `cleanup` also deletes the events and tasks above.

## Script layout

| File | Role |
|---|---|
| `lib.mjs` | Opening the browser, sign-in (language selection), hash navigation, red number markers (`mark`), area capture (`shot`), finding UI text (`t`, `exact`) |
| `i18n.mjs` | Reads the ko and en dictionaries from `client/src/i18n.ts`. Scripts never hard-code UI text; they look it up by i18n key |
| `data.mjs` | Sample data per language (mail, events, tasks, input values) |
| `api.mjs` | Helpers for calling the API directly (sign-in, requests) |
| `seed.mjs` / `cleanup.mjs` | Create / delete samples |
| `cap-*.mjs` | Per-chapter capture |

> **When UI text changes** — scripts find buttons by i18n key, so nothing needs fixing if only the wording changes. If a key
> is renamed, fix the `t('...')` calls in `cap-*.mjs`. Mailboxes in the side menu are found by their language-independent
> `title` (INBOX · Sent …).

> **When calling the API directly** — write requests need the `x-requested-with` header (CSRF protection). The read flag
> must be sent as `"\\Seen"` (with the backslash). If you send `"Seen"`, it is silently stored as a user keyword, and
> neither the read state nor the read receipt (READ_DATE) is set. One-line shell commands (`node -e "..."`) easily lose the
> backslash, so write a file instead.
