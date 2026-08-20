# Bibliotech — Google Apps Script prototype

Replaces the `streamlit-gsheets` connector (which failed with `HTTP 400`)
with a script **bound** to the Google Sheet itself: it runs with the Google
login of whoever is accessing the app (within the school's domain), so
there's no service account, no credentials JSON, no `secrets.toml` — and
that same login doubles as identifying each person. You serve the HTML
yourself, with full control over the design.

## Files

- `appsscript.json` — project manifest (web app config).
- `Code.js` — server-side logic: profiles and roles, catalog, full loan
  cycle (`Solicitado → Entregado → Devuelto`) with staff actions, and
  `LockService` so two people can't grab the last copy at once.
- `Index.html` — frontend markup (catalog + form), no frameworks.
- `Stylesheet.html` / `JavaScript.html` — frontend CSS and JS, split out
  of `Index.html` and injected with `include()` (Google's recommended
  pattern for Apps Script projects — avoids one giant HTML file).

## Expected Sheet structure

- **Libros** tab: columns `Id_Libro | Titulo | Autor | Cantidad_Total | Disponibles | Prestado`
  (row 1 = headers). `Disponibles` is computed as `Cantidad_Total − Prestado` —
  the script writes that value so it's visible on the sheet, but the source
  of truth is `Prestado` (`Disponibles` is never read to decide stock).
- **Prestamos** tab: columns `Id_Prestamo | Fecha | Email | Nombre | Curso |
  Id_Libro | Libro | Estado | Fecha_Entrega | Fecha_Devolucion` (row 1 =
  headers). `appendRow` writes by column position, not by name — keep that
  exact order. `Estado` moves through `Solicitado → Entregado →
  Devuelto`; stock on `Libros` is decremented on Request (not on Delivery)
  and restored on confirming the Return — that way the last copy shows no
  stock the moment someone requests it, without waiting for them to pick
  it up at the desk.
- **Perfiles** tab: columns `Email | Nombre | Curso | Rol | FechaAlta`
  (row 1 = headers). Fills itself in the first time each person opens the
  app (one-time sign-up form). `Rol` starts as `member`; to promote
  someone to staff, edit that cell by hand to `staff`.

## Access and login

`appsscript.json` has `webapp.access: "DOMAIN"` and `webapp.executeAs:
"USER_ACCESSING"`: the web app requires a Google login from the school's
own domain before serving the page, and the server runs as whoever is
looking at the page (not as the script's owner). That's what lets
`Session.getActiveUser().getEmail()` identify who's requesting each loan,
with no auth code of our own.

**Testing this requires an account on the same Workspace** as the script
(it doesn't work with standalone @gmail.com accounts) — deploy under the
school's real Workspace, or a test one.

## How to test it (before you have the school's Workspace)

There are two levels of testing, depending on what you want to validate:

**A) Fast iteration on the logic (catalog, requesting a loan, status
cycle, staff view)** — no Workspace needed, works with your personal
account:

1. `npx @google/clasp login` (once — opens the browser, authorizes your
   Google account). No need to install it globally, `npx` is enough.
2. Create a new Google Sheet and set up 3 tabs with these exact headers
   on row 1 (same order — `appendRow` writes by position):
   - `Libros`: `Id_Libro | Titulo | Autor | Cantidad_Total | Disponibles | Prestado`
   - `Prestamos`: `Id_Prestamo | Fecha | Email | Nombre | Curso | Id_Libro | Libro | Estado | Fecha_Entrega | Fecha_Devolucion`
   - `Perfiles`: `Email | Nombre | Curso | Rol | FechaAlta`
   Add 1-2 test rows in `Libros` (with `Cantidad_Total` set and `Prestado`
   at `0`) so there's something in the catalog.
3. Temporarily change `webapp.access` in `appsscript.json` from
   `"DOMAIN"` to `"MYSELF"` (only you'll be able to open it — no domain
   needed for that). This is a throwaway change for testing; don't commit
   it as-is.
4. From `apps-script/`, link the project to that Sheet (the ID is the one
   in its URL):
   ```bash
   cd apps-script
   npx @google/clasp create --type sheets --title "Bibliotech test" --parentId <SPREADSHEET_ID>
   ```
5. Push the code and deploy it:
   ```bash
   npx @google/clasp push
   npx @google/clasp deploy
   ```
   `clasp deploy` gives you back a URL — that's your "local server".
6. Open that URL: you'll always be signed in as yourself. Complete the
   profile to see the `member` view. To see the `staff` view, go to the
   `Perfiles` tab on the Sheet, change your own row to `Rol: staff` by
   hand, and reload the page.
7. When you change `Code.js`/`Index.html`/etc., repeat `clasp push` and
   reload — no need for a fresh `clasp deploy` to see the changes if you
   open the **test deployment** URL (`clasp open` → Deploy → Test
   deployments), which always serves the latest pushed version without
   publishing a new version each time.
8. This does **not** test the domain gate itself (`access: DOMAIN`) or
   whether two different accounts show up as two different profiles —
   that needs B. Switch `access` back to `"DOMAIN"` before committing.

**B) Full validation before taking it to a real school** — this does need
a Workspace domain, but it doesn't have to be the school's yet:
[Google Workspace has a free 14-day trial](https://workspace.google.com/)
that's enough for this. With that admin account, create 2 test users (one
to act as `member`, another to promote to `staff`), switch
`webapp.access` back to `"DOMAIN"`, deploy, and run through the end-to-end
flow from the plan's "Verification" section (login blocked for outside
accounts, profile sign-up, request, delivery/return confirmation with the
staff account).

## Versioning it in git: `clasp`

Apps Script normally lives only in Google's web editor
(script.google.com), with no git. **`clasp`** (`@google/clasp`, Google's
official CLI) fixes that: it keeps the files as local `.js`/`.html`/`.json`
— like any other project — and syncs them against the Apps Script project
in the cloud.

### Setup (once, as the developer)

```bash
npm install -g @google/clasp
clasp login                       # opens the browser, authorizes your Google account
```

### Linking this folder to an Apps Script project

Two paths:

**A) Create the bound project from here** (needs the test Spreadsheet's ID):
```bash
cd apps-script
clasp create --type sheets --title "Bibliotech" --parentId <SPREADSHEET_ID>
```

**B) Link a project you already created by hand** (Extensions → Apps Script on the Sheet):
```bash
cd apps-script
clasp clone <SCRIPT_ID>          # the Script ID is in the project's settings
```

Both commands generate `.clasp.json` (holds the `scriptId`, specific to
each Sheet/deployment — **not** pushed to git, see `.gitignore`).

### Day-to-day workflow

```bash
clasp push      # uploads Code.js / Index.html / appsscript.json to the cloud
clasp open      # opens the web editor to test
clasp deploy    # publishes a version of the web app (generates the public URL)
```

The source of truth stays in this repo; `clasp push` is just the "upload
the latest version" step, same as a deploy.

## How a school with no technical knowledge would use this

They **don't** need clasp for that — it's a tool for you as the
developer, not for whoever runs the library at each school. The intended
flow is:

1. You set up a "template" Google Sheet with the `Libros`, `Prestamos`
   and `Perfiles` tabs (headers already in place), with the script already
   pasted in (via `Extensions > Apps Script`) and already deployed as a
   web app.
2. Each school does **File → Make a copy** of that template Sheet. The
   copy includes the script.
3. Someone at the school goes to `Extensions > Apps Script > Deploy >
   New deployment` once, and shares that URL with everyone else.
4. That same person opens the URL with their school account (signs up as
   `member`), then edits their own row on `Perfiles` by hand to set
   `Rol: staff` — it's the only manual step on the Sheet needed to get
   started; promoting more staff after that works the same way.

No GitHub, no terminal, no credentials — cloning a Sheet instead of
cloning a repo.
