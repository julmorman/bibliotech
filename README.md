# Bibliotech

Catalog and loan system for school libraries, built for schools with no
dedicated tech support (often, not even a librarian). Runs as a Google
Apps Script *bound* to a Google Sheet that acts as the database — no
servers of your own, no credentials to manage, no hosting to maintain.

## How it works

- The "database" is a Google Sheet with three tabs: `Libros`
  (catalog + stock), `Prestamos` (each loan's lifecycle), and
  `Perfiles` (one row per person, with their role).
- The code (`apps-script/`) runs bound to that Sheet, with the Google
  login of whoever is accessing it — restricted to the school's domain —
  no service accounts or API keys needed, and that same login identifies
  each person.
- It serves its own web page (HTML/CSS/JS): students see the catalog and
  request loans (stock is validated and decremented on the spot,
  protected against two people grabbing the same last copy at once); the
  full cycle is `Solicitado → Entregado → Devuelto` (Requested →
  Delivered → Returned), with whoever has the `staff` role confirming
  delivery and return in person from their own tab within the same app.

## Installation (for whoever runs a school's library)

See [`apps-script/README.md`](apps-script/README.md) — no terminal or
programming knowledge required: it's just copying a template Google
Sheet and a couple of clicks on "Deploy" inside the Apps Script editor.

## Development

If you're touching the source code, `apps-script/README.md` also
documents how to version it with `clasp` (Google's official CLI for Apps
Script) so you can work with git like any other project.
