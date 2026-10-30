# Nayaro POS — offline-first point of sale & inventory

**Demo MVP by Nayaro Tech for Nayaro Mart.** Single store, single counter, local SQLite database.
Not yet reviewed for production security, and **not approved or certified by Nepal's IRD**.

## Repository layout

| Path | What it is |
|---|---|
| `packages/shared` | Types, Zod input schemas, typed IPC contract, NPR money helpers, Nepal fiscal year (BS) logic |
| `packages/backend` | SQLite schema + migrations, repositories, services (sales, stock, purchases, reports, users, backup), label/receipt renderers, read-only mobile API, demo seed, tests |
| `apps/frontend` | React + TypeScript + Vite UI (renderer) |
| `apps/desktop` | Electron shell: secure window, validated IPC with role checks, printer service, backup/restore orchestration |
| `apps/mobile` | Read-only owner dashboard (installable PWA) served by the desktop app on the shop network |

The backend runs **only in the Electron main process**. The renderer has no Node, file or database
access: it talks through one preload method (`window.srmart.invoke`) with an allow-listed set of
channels; the main process validates every payload with Zod and checks the signed-in user's role.

## Requirements
- Node.js 22 or 24, npm 10+
- Windows 10/11 (target), macOS or Linux for development
- No internet needed at runtime. `better-sqlite3` ships prebuilt N-API binaries (incl. Windows x64), so no compiler is needed.

## Install, run, build

```bash
npm install            # once
npm run build          # builds frontend, mobile PWA and desktop main/preload
npm start              # launches the desktop app (builds main first)
npm run dev            # dev mode: Vite hot reload + Electron
```

Quality checks:

```bash
npm run typecheck      # tsc across all 5 workspaces
npm run lint           # ESLint
npm test               # backend acceptance + migration + system tests (Vitest, real SQLite files)
npm run migrate:check  # migration tests only
npm run smoke          # launches Electron headlessly: native SQLite, migrations, backup + test-restore
```

Installer (run on the target OS; not yet tested in this repo):

```bash
npm run dist           # electron-builder → apps/desktop/release/ (NSIS on Windows, DMG on macOS)
```

> If `npm install` ever leaves Vite failing with *"Cannot find module @rollup/rollup-…"* (a known npm
> optional-dependency bug), delete `node_modules` and `package-lock.json` and run `npm install` again.
> If Electron behaves like plain Node, your shell exported `ELECTRON_RUN_AS_NODE=1`; the npm scripts
> already remove it via `apps/desktop/run-electron.mjs`.

## Demo credentials and demo data

On first launch the app creates a database and loads **clearly-labelled fictional demo data**:
40 products across groceries, packaged foods, cosmetics, clothing and household (brands marked
"(Demo)"), a "Tihar offer (Demo)" 10% on clothing, a "Tihar Lucky Draw (Demo)" scheme with fictional customers
(placeholder phones `01000000xx`), 3 fictional suppliers, purchases with batches/expiry, ~3 weeks of sales in FY 2083/84 plus a
few in FY 2082/83, a void, a return, low-stock items and one "label outdated" product. Sample
manufacturer barcodes use GS1 prefix `20` (in-store/restricted range) so they cannot match real products;
other products get internal `NYM-000001`-style Code 128 barcodes. The header shows **DEMO DATA**.

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Admin@123` |
| Cashier | `cashier` | `Cashier@123` |

**These are for local demonstration only.** The app shows a warning while they are unchanged.

- **Reset demo data:** Settings → Demo / live data → *Reset demo data* (type `RESET DEMO` + password).
  If any real records exist it requires `DELETE REAL DATA`. A verified backup is always taken first.
- **Start live operation:** *Remove demo data & start live operation* (type `START LIVE`). Demo records are
  removed; users, settings and the audit log are kept; demo accounts must change passwords.
- **Start without demo data:** set `SRMART_NO_DEMO=1` before the first launch (creates the two accounts with forced password change).
- **Isolated data folder** (testing): `SRMART_DATA_DIR=/path/to/data npm start`.

## Feature overview

- **Fiscal year:** Nepal FY (1 Shrawan – end of Ashadh, BS) computed from the Bikram Sambat calendar.
  The running FY, its progress and today's BS date are always visible in the header; every sale,
  return and purchase is stamped with its FY; receipt numbers restart per FY (`NYM/83-84/000001`);
  reports offer *This FY / Previous FY* and BS-month grouping.
- **Checkout:** HID scanner input with Enter/Tab suffix, duplicate-read suppression, unknown-barcode
  errors, name search (F4), qty edit, line and order discounts (cashier limit + admin approval), cash
  tendered/change, recorded non-cash methods, receipt preview/print/PDF. Prices always come from the database.
- **Atomic sales:** sale, item price/cost snapshots, stock deductions + ledger rows, payment, receipt
  number, audit and outbox event in one `BEGIN IMMEDIATE` transaction; idempotent on a client transaction ID.
- **Voids & returns:** reasons required, admin approval for cashiers, refunds recorded, stock reversed,
  over-returns blocked. Database triggers make real sales, payments, stock movements and audit logs append-only.
- **Products & barcodes:** CRUD/disable, multiple barcodes per product, EAN/UPC check-digit validation,
  uniqueness enforced in code and by a UNIQUE index, internal Code 128 generation, price history, CSV import (dry-run report of duplicates/errors) and export.
- **Label studio:** product stickers and shelf labels with real barcodes (bwip-js), configurable sizes, batch print, PDF fallback, outdated-label tracking.
- **Purchases & inventory:** suppliers, invoice receiving (duplicate invoice blocked), optional batch/expiry, stock ledger, reasoned adjustments, low stock, expiring batches.
- **Reports:** daily/weekly/BS-monthly sales, payment totals, top products, categories, stock valuation, purchases, returns/voids, **estimated** gross margin (clearly labelled, not profit).
- **Users & audit:** admin/cashier roles, scrypt password hashing, login rate limiting, audit log for prices, discounts, voids, refunds, stock adjustments, settings, backups.
- **Settings:** store profile, receipt header/footer/prefix/paper width, payment methods, printers, label sizes, checkout rules, tax gate (disabled until verified), mobile server.
- **Mobile admin app:** read-only owner dashboard on the shop network.
- **Barcode scanners:** USB/Bluetooth keyboard-style scanners, and/or a **phone camera scanner** paired by QR code
  over the shop Wi-Fi (HTTPS with an offline self-signed certificate, no internet, no app install). Both are switched
  on/off in *Settings → Barcode scanners*.
- **Festival discounts:** scheduled % offers (all products or one category) applied automatically at checkout; the
  best offer wins; recorded per sale item, printed on the receipt, reported separately; not counted toward the cashier limit.
- **Lucky-draw schemes:** coupons for bills above a threshold (e.g. Rs 2,000, plus one per extra Rs 1,000), captured
  with the customer's name and phone **only with consent**; coupons are issued in the same transaction as the sale,
  printed on the receipt (phone masked), become ineligible if the sale is voided or fully returned, and winners are
  drawn with a cryptographically random, audit-logged draw. Lucky-draw permission rules are listed in the compliance doc.

## Cash shifts and parked carts

- Open **Cash shifts & closing → Open shift** and enter the cash float already in the drawer. One shared till shift can be open at a time. Every payment/refund made while it is open is attached to that shift, regardless of cashier. Sales without a shift remain possible, with a checkout warning, and are excluded from reconciliation; historical payments are not assigned retroactively.
- Record **Cash in / Cash out** with a reason. Expected cash uses the cash sale amount after change, not the cash tendered. Card/wallet totals are shown separately. Only the shift owner or an administrator can move cash or close the shift; cashiers see their own history and administrators see all shifts.
- Choose **Count & close shift**, enter the actual counted cash, and explain any variance. If payments changed while counting, refresh and review again. Closed shifts are immutable. Print the closing report or save it as PDF. Close before handover, then let the next cashier open a new shift with the counted float.
- Checkout automatically saves the current cart locally. Each cashier recovers their own active cart after restart/sign-in. **Park sale** gives it a name and starts a fresh cart; **Parked carts** resumes or discards one. Park or clear a nonempty current cart before resuming another. Up to 100 parked carts per cashier are supported; discard old carts explicitly.
- Resuming preserves the transaction ID but refreshes product prices and stock. Current promotions and checkout rules are evaluated again. Completing payment retires the draft in the same transaction as the sale, preventing a delayed save from bringing back a paid cart. Cart drafts do not store payment credentials or customer contact details.

## Reporting and mobile access

Sales reports use activity dates: sales on the sale date, returns on the return date, and void reversals on the void date. Net sales exclude tax and include those reversals. Refund totals include tax; payment totals use each payment/refund business date. Transaction counts show sales made in the period, including sales later reversed. Earlier periods no longer change when a later return or void is recorded. Estimated margin reverses cost only for restocked returns; discarded returns retain their cost.

The mobile dashboard now uses **HTTPS**. Replace old `http://` bookmarks with the address in Settings → Mobile admin app. The offline self-signed certificate must be trusted on the phone; PWA installation depends on browser certificate trust. Accounts requiring a password change must change it in the desktop app first. Password changes, logout, and database restore invalidate mobile sessions.

Existing databases upgrade automatically after a safety backup. Payment business dates are backfilled from the sale/return date; historical void refunds use their recorded timestamp interpreted in the computer's local timezone. Old batch sources cannot be reconstructed.

## Backup and recovery

- Database: `%APPDATA%/Nayaro POS/data/srmart.sqlite` on Windows (`~/Library/Application Support/…` on macOS); shown in *Backup*.
- Backups default to `Documents/Nayaro POS Backups` (a different folder). Choose a **USB drive or second disk**
  in *Backup → Change folder*; the app warns while backups are on the same disk.
- Automatic: daily while the app is running (also checked on startup and system resume), on every app exit, before migrations, before demo reset/go-live, and before a restore.
- Each backup is a `VACUUM INTO` snapshot written to a temporary file, fsynced, integrity-checked, then
  renamed to a **new unique name** — an existing backup is never overwritten. Retention (default 30) never
  deletes the newest verified backup or pre-restore safety copies.

**Restore procedure (tested by `tests/acceptance.test.ts › 11`):**
1. *Backup* → choose a backup → **Test restore**. It is restored into a separate temporary copy, migrated and integrity-checked; live data is untouched.
2. **Restore…** → type `RESTORE` + your password. A `pre-restore` safety backup of the current database is taken.
3. The database is closed, replaced atomically, reopened and migrated. Sign in again and check recent sales/stock.
4. To undo, restore the `pre-restore` backup.

**Manual/emergency restore (app will not start):** close the app, copy a backup file over
`srmart.sqlite` in the data folder, delete `srmart.sqlite-wal` and `srmart.sqlite-shm` if present, start the app.

## Device compatibility checklist
Nothing below is verified yet.
- [ ] USB HID barcode scanner, Enter suffix, US keyboard layout
- [ ] Scans EAN-13 and printed Code 128 labels at counter distance
- [ ] 80 mm (or 58 mm) thermal receipt printer with Windows driver; receipt barcode scans
- [ ] Label printer or A4 sticker sheets aligned at configured size
- [ ] Printer unplugged → clear message, PDF fallback works
- [ ] Power loss during/after a sale → no partial sale; completed sale persists
- [ ] Offline sale + restart
- [ ] Backup to USB + test restore
- [ ] (Optional) mobile dashboard on shop Wi-Fi / VPN

## Known limitations
- Not reviewed for production security; not penetration-tested. The optional LAN mobile server uses HTTPS with a local self-signed certificate; phones must trust it.
- **No tax is configured** and invoice format/numbering are unverified for IRD/CBMS — compliance gate in Settings.
- Quantities are whole units (no weighing scale; loose goods must be pre-packed).
- One payment method per sale (no split payments); non-cash methods are only recorded, no gateway integration.
- New sales record FEFO batch allocations, restored on voids and restocked returns. Legacy sales have no batch allocation history: their returns restore product stock only. Positive stock adjustments remain unbatched.
- No customer credit (udharo) or loyalty points; customers are recorded only for lucky-draw schemes. No multi-store, no cloud sync (only a `sync_outbox` scaffold).
- Phone-scanner pairings are kept in memory (re-pair after an app restart); the phone must accept a self-signed certificate warning.
- No buy-X-get-Y or per-product promotions yet (offers are store-wide or per category).
- Printing uses OS drivers; no direct ESC/POS commands or cash-drawer kick yet.
- Checkout autosaves unpaid drafts per cashier. Wait for “Cart saved on this computer” before quitting; an abrupt power loss can lose a change still marked “Saving”. Drafts reserve no stock and do not create sales or payments.
- Installer packaging (`npm run dist`) and Windows-specific behaviour have not been tested in this environment.

## Production deployment steps
1. Answer the open tax/invoice compliance questions with IRD / an adviser; implement any required invoice changes.
2. Security review: dependency audit (`npm audit`), code review of IPC handlers, Electron fuses and code signing for the installer.
3. Build the installer on Windows: `npm install && npm run dist`; sign it; install on the counter PC.
4. First launch with `SRMART_NO_DEMO=1` (or use *Start live operation*); set **new admin and cashier passwords**; disable unused accounts.
5. Enter the real store profile, receipt texts, payment methods; leave tax disabled until verified.
6. Configure backup folder on a USB/second disk; run *Back up now* and *Test restore*; schedule an off-site copy routine.
7. Test scanners, printers and labels on the real hardware and record results.
8. Import the real catalogue via CSV (dry run first), print labels, do a stock count with adjustments.
9. Train staff on voids/returns/approvals; keep a UPS on the counter PC and printer.

## Tests
`npm test` runs the backend regression suite against real file-backed SQLite databases, covering the acceptance criteria:
internal barcode generation, duplicate barcode rejection, sticker/shelf label rendering, scanning at current
price, mixed-item checkout totals/receipt/stock, atomic rollback on a simulated mid-transaction failure,
offline sale with network stubbed to fail + restart persistence, purchase receiving, controlled void/return
with audit and approver, historical prices after price change, backup + restore on a separate copy,
retention safety, cashier permission blocks, fiscal-year tagging and per-FY numbering, tax gate, CSV import,
demo seed/reset safeguards, mobile API auth/read-only, migrations/foreign keys, festival discounts (best offer,
date windows, no cashier-limit effect), lucky-draw coupons (consent required, issued atomically, voided sales
excluded, tamper-proof, fair draw without duplicates, rules locked after issue) and the HTTPS phone-scanner
server (single-use pairing, unpair, scan validation, admin pages not exposed).
