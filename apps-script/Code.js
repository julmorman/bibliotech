// Bibliotech — server-side logic (Google Apps Script, bound to the Spreadsheet)
// Runs as whoever is accessing it (webapp.executeAs: USER_ACCESSING,
// webapp.access: DOMAIN in appsscript.json): no service account, no
// credentials JSON, no secrets.toml — Google itself gates access.

const SHEET_BOOKS = 'Libros';
const SHEET_LOANS = 'Prestamos';
const SHEET_PROFILES = 'Perfiles';

const ROLE_STAFF = 'staff';
const ROLE_MEMBER = 'member';

const STATUS_REQUESTED = 'Solicitado';
const STATUS_DELIVERED = 'Entregado';
const STATUS_RETURNED = 'Devuelto';

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Bibliotech')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Injects Stylesheet.html / JavaScript.html into Index.html. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Reads a full sheet and returns its headers plus rows (header row excluded). */
function readSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return { sheet, headers, rows: data };
}

/**
 * Profile (email/name/grade/role) of whoever is using the app, or null if
 * they haven't signed up yet (first visit). The email comes from the
 * Google session, never from the client.
 */
function getCurrentProfile() {
  const email = Session.getActiveUser().getEmail();
  const { headers, rows } = readSheet_(SHEET_PROFILES);
  const emailIdx = headers.indexOf('Email');
  const nameIdx = headers.indexOf('Nombre');
  const gradeIdx = headers.indexOf('Curso');
  const roleIdx = headers.indexOf('Rol');

  const row = rows.find(r => r[emailIdx] === email);
  if (!row) return null;

  return {
    email,
    name: row[nameIdx],
    grade: row[gradeIdx],
    role: row[roleIdx] || ROLE_MEMBER
  };
}

/**
 * Signs up the current user's profile. The role is always fixed to
 * 'member' server-side (never taken from the client); promoting someone
 * to 'staff' means editing the Rol column directly on the Perfiles sheet.
 */
function createProfile(data) {
  const existing = getCurrentProfile();
  if (existing) {
    return { ok: true, profile: existing };
  }

  const email = Session.getActiveUser().getEmail();
  const name = (data.name || '').trim();
  const grade = (data.grade || '').trim();

  if (!name || !grade) {
    return { ok: false, error: 'Completá todos los campos.' };
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PROFILES);
  sheet.appendRow([email, name, grade, ROLE_MEMBER, new Date()]);

  return { ok: true, profile: { email, name, grade, role: ROLE_MEMBER } };
}

/** Throws if whoever is using the app has no profile or isn't staff. */
function requireStaff_() {
  const profile = getCurrentProfile();
  if (!profile || profile.role !== ROLE_STAFF) {
    throw new Error('No autorizado.');
  }
  return profile;
}

/**
 * Returns the catalog of books with stock > 0.
 * Expected headers on row 1 of "Libros":
 * Id_Libro | Titulo | Autor | Cantidad_Total | Disponibles | Prestado
 *
 * Disponibles is computed as Cantidad_Total − Prestado (the Disponibles
 * column itself is never read: it's kept as a visual mirror, the source
 * of truth is Cantidad_Total/Prestado).
 */
function getCatalog() {
  const { headers, rows } = readSheet_(SHEET_BOOKS);
  const titleIdx = headers.indexOf('Titulo');
  const authorIdx = headers.indexOf('Autor');
  const totalCopiesIdx = headers.indexOf('Cantidad_Total');
  const borrowedIdx = headers.indexOf('Prestado');

  return rows
    .map(row => {
      const totalCopies = Number(row[totalCopiesIdx]) || 0;
      const borrowed = Number(row[borrowedIdx]) || 0;
      return {
        title: row[titleIdx],
        author: row[authorIdx],
        available: totalCopies - borrowed
      };
    })
    .filter(book => book.available > 0);
}

/**
 * Requests a loan for whoever is using the app: validates the profile and
 * stock, bumps "Prestado" and appends the row on "Prestamos" with status
 * "Solicitado". Uses LockService so two simultaneous submits can't both
 * grab the same last copy (the bug the Streamlit version had).
 * Stock is decremented right here, not when staff confirm delivery — that
 * way a second request for the last copy already sees no stock even
 * though the book is still "Solicitado" and hasn't been picked up yet.
 */
function requestLoan(data) {
  const profile = getCurrentProfile();
  if (!profile) {
    return { ok: false, error: 'Completá tu perfil antes de pedir un préstamo.' };
  }

  const title = data.book;
  if (!title) {
    return { ok: false, error: 'Elegí un libro.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const books = ss.getSheetByName(SHEET_BOOKS);
    const rows = books.getDataRange().getValues();
    const headers = rows[0];
    const bookIdIdx = headers.indexOf('Id_Libro');
    const titleIdx = headers.indexOf('Titulo');
    const totalCopiesIdx = headers.indexOf('Cantidad_Total');
    const availableIdx = headers.indexOf('Disponibles');
    const borrowedIdx = headers.indexOf('Prestado');

    let rowIndex = -1;
    let bookId = null;
    let totalCopies = 0;
    let borrowed = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][titleIdx] === title) {
        rowIndex = i + 1; // 1-based for getRange, +1 for the header row
        bookId = rows[i][bookIdIdx];
        totalCopies = Number(rows[i][totalCopiesIdx]) || 0;
        borrowed = Number(rows[i][borrowedIdx]) || 0;
        break;
      }
    }

    if (rowIndex === -1) {
      return { ok: false, error: 'El libro no existe en el catálogo.' };
    }

    const available = totalCopies - borrowed;
    if (available <= 0) {
      return { ok: false, error: 'Ese libro ya no tiene stock disponible.' };
    }

    const newBorrowed = borrowed + 1;
    books.getRange(rowIndex, borrowedIdx + 1).setValue(newBorrowed);
    books.getRange(rowIndex, availableIdx + 1).setValue(totalCopies - newBorrowed);

    const loans = ss.getSheetByName(SHEET_LOANS);
    loans.appendRow([
      Utilities.getUuid(),
      new Date(),
      profile.email,
      profile.name,
      profile.grade,
      bookId,
      title,
      STATUS_REQUESTED,
      '',
      ''
    ]);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/** Loans belonging to whoever is using the app, most recent first. */
function getMyLoans() {
  const email = Session.getActiveUser().getEmail();
  const { headers, rows } = readSheet_(SHEET_LOANS);
  const emailIdx = headers.indexOf('Email');
  const bookIdx = headers.indexOf('Libro');
  const statusIdx = headers.indexOf('Estado');
  const dateIdx = headers.indexOf('Fecha');

  return rows
    .filter(row => row[emailIdx] === email)
    .map(row => ({
      book: row[bookIdx],
      status: row[statusIdx],
      date: row[dateIdx]
    }))
    .reverse();
}

function mapLoanRow_(row, headers) {
  const idx = name => headers.indexOf(name);
  return {
    id: row[idx('Id_Prestamo')],
    book: row[idx('Libro')],
    name: row[idx('Nombre')],
    grade: row[idx('Curso')],
    status: row[idx('Estado')],
    date: row[idx('Fecha')]
  };
}

/** Loan requests still waiting on delivery. Staff only. */
function getPendingRequests() {
  requireStaff_();
  const { headers, rows } = readSheet_(SHEET_LOANS);
  const statusIdx = headers.indexOf('Estado');
  return rows
    .filter(row => row[statusIdx] === STATUS_REQUESTED)
    .map(row => mapLoanRow_(row, headers));
}

/** Loans delivered and not returned yet. Staff only. */
function getActiveLoans() {
  requireStaff_();
  const { headers, rows } = readSheet_(SHEET_LOANS);
  const statusIdx = headers.indexOf('Estado');
  return rows
    .filter(row => row[statusIdx] === STATUS_DELIVERED)
    .map(row => mapLoanRow_(row, headers));
}

/** Row (1-based, header offset included) of a loan by its Id_Prestamo. */
function findLoanRow_(sheet, headers, loanId) {
  const idIdx = headers.indexOf('Id_Prestamo');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][idIdx] === loanId) {
      return i + 1;
    }
  }
  return -1;
}

/** Confirms the book was handed over in person. Staff only. Doesn't touch stock. */
function confirmDelivery(loanId) {
  requireStaff_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOANS);
  const headers = sheet.getDataRange().getValues()[0];
  const rowIndex = findLoanRow_(sheet, headers, loanId);
  if (rowIndex === -1) return { ok: false, error: 'Préstamo no encontrado.' };

  const statusIdx = headers.indexOf('Estado');
  const deliveredAtIdx = headers.indexOf('Fecha_Entrega');
  sheet.getRange(rowIndex, statusIdx + 1).setValue(STATUS_DELIVERED);
  sheet.getRange(rowIndex, deliveredAtIdx + 1).setValue(new Date());

  return { ok: true };
}

/**
 * Confirms the physical return and restores stock (the only step in the
 * cycle that gives stock back: it was decremented on request, not on
 * delivery). Staff only.
 */
function confirmReturn(loanId) {
  requireStaff_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const loans = ss.getSheetByName(SHEET_LOANS);
    const loanHeaders = loans.getDataRange().getValues()[0];
    const rowIndex = findLoanRow_(loans, loanHeaders, loanId);
    if (rowIndex === -1) return { ok: false, error: 'Préstamo no encontrado.' };

    const statusIdx = loanHeaders.indexOf('Estado');
    const returnedAtIdx = loanHeaders.indexOf('Fecha_Devolucion');
    const bookIdIdx = loanHeaders.indexOf('Id_Libro');
    const bookId = loans.getRange(rowIndex, bookIdIdx + 1).getValue();

    loans.getRange(rowIndex, statusIdx + 1).setValue(STATUS_RETURNED);
    loans.getRange(rowIndex, returnedAtIdx + 1).setValue(new Date());

    const books = ss.getSheetByName(SHEET_BOOKS);
    const bookRows = books.getDataRange().getValues();
    const bookHeaders = bookRows[0];
    const booksBookIdIdx = bookHeaders.indexOf('Id_Libro');
    const totalCopiesIdx = bookHeaders.indexOf('Cantidad_Total');
    const availableIdx = bookHeaders.indexOf('Disponibles');
    const borrowedIdx = bookHeaders.indexOf('Prestado');

    for (let i = 1; i < bookRows.length; i++) {
      if (bookRows[i][booksBookIdIdx] === bookId) {
        const bookRow = i + 1;
        const totalCopies = Number(bookRows[i][totalCopiesIdx]) || 0;
        const borrowed = Number(bookRows[i][borrowedIdx]) || 0;
        const newBorrowed = Math.max(0, borrowed - 1);
        books.getRange(bookRow, borrowedIdx + 1).setValue(newBorrowed);
        books.getRange(bookRow, availableIdx + 1).setValue(totalCopies - newBorrowed);
        break;
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}
