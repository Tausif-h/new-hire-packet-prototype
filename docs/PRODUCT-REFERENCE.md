# Packet Review — Product Reference

An audit of what the prototype actually does, written from the code as of Oct 8, 2026. Every
feature below cites where it lives. Nothing is described that the code doesn't do; where the
behavior was checked by running the real functions, it says so (see **§6 Verification**).

**Code map**

| File | Role |
|---|---|
| `extract.py` | Extraction pipeline: render PDF pages, classify pages into forms, read fields with Claude (`claude-sonnet-5-5`, structured JSON output), checks (choices, formats, dates, conflicts, missing pages, not-applicable), date normalization, add-pages merge. Also a CLI. |
| `app.py` | Flask web app (port 5050): home list, upload, processing, review page, decisions/email/export/payload/add-pages APIs, job storage under `jobs/<id>/`. |
| `payload.py` | Builds the PrismHR `importEmployees` payload (demo, nothing sent) with code mapping and blockers. Also a CLI. |
| `static/review.js` | The whole review UI (one renderer): dashboard, Triage, All Forms, viewer, sweep, Review & Export, Activity, email, payload card. |
| `static/review.css` | Styling (ProService theme, severity colors). |
| `templates/*.html` | `base` (top bar), `home`, `upload`, `processing`, `review`, `demo`. |
| `data/form_catalog.json` | The 9 forms, their pages, every field and its rules (required, groups, conditions, options, formats). |
| `data/client_codes.json` | PrismHR codes for client 15650 (Jordan's Surf Shack). |
| `data/demo_packets.json` | Six seeded example rows for the home list. |
| `check_connection.py` | Checks the API key and connectivity. |

**Job folder** (`jobs/<32-hex id>/`): `packet.pdf`, `status.json`, `extraction.json`,
`pages/page-NN.png`, `decisions.json` (decisions + activity log), `email_draft.json`,
`summary.json` (home-list status), `supplement-N.pdf` (added pages). Uploads are listed in
`jobs/packets.json`.

---

## 1. Feature inventory

### 1.1 Screens and navigation

| Feature | What it does | Where | Trigger |
|---|---|---|---|
| Top bar | Navy bar on every page: "Packet Review" (links home), breadcrumb "Packets / <name>", "← All packets" on a packet. | `templates/base.html` | Every page |
| Home (packet list) | Table of packet reviews: Employee, Company, Pages, Processed, Status pill + detail, Progress bar. Rows click through. Uploads from `jobs/packets.json` plus 6 seeded rows tagged "sample", newest first. | `app.py:343` `home`, `packet_row` (`app.py:321`), `templates/home.html` | `GET /` |
| Home statuses | Processing · Failed · In triage (N items left) · In verification sweep (X of N) · Awaiting client (email sent / not sent yet) · Ready to export · Complete (exported). Status comes from `summary.json`, which the review page posts whenever it changes; "Ready to export" + an export becomes "Complete". | `packetSummary` `review.js:1915`, `save_summary` `app.py:362` | Any review-page redraw |
| Sample packet page | Seeded rows open a details page (no scans) saying it's a sample. | `app.py:355`, `templates/demo.html` | Click a sample row |
| Upload | Drop zone / file picker, "Upload and review". Server checks a filename ending `.pdf` and the `%PDF-` magic bytes; max 50 MB. | `app.py:375`, `app.py:380`, `templates/upload.html` | `GET/POST /upload` |
| Processing | Step list (Identifying forms → Extracting fields → Checking confidence → Validating formats → Detecting conflicts → Building review), polls status every second, reveals finished steps one by one, redirects to the review page; shows the error text on failure. | `app.py:401`, `app.py:410`, `templates/processing.html` | After upload |
| Page headers | Kicker + title + one sentence on every screen. | `TAB_HEADERS` `review.js:1891`, templates | Always |
| Stage banners | One dismissible line per tab (Triage, All Forms, Review & Export); dismissal stored in localStorage. | `STAGE_BANNERS` `review.js:1901` | Tab render / ✕ |
| Tabs + URL hash | Triage · All Forms · Review & Export · Activity, with counts; `#triage/<item>` and `#forms/<form>` deep links. | `renderTabs` `review.js:986`, `readHash`/`writeHash` `review.js:1980` | Click / hash change |
| Scroll preservation | Inner scroll areas, page scroll, sweep list and viewer sidebar keep their position across re-renders. | `draw` `review.js:1933`, `renderSweep` | Every action |

### 1.2 Dashboard (top of the packet page)

| Feature | What it does | Where |
|---|---|---|
| Stepper | Upload ✓ · Extract ✓ (N fields found) · Review (N need attention) · Request info · Export. | `renderHeader` `review.js:718` |
| Packet header | Name, pink file chip (filename · pages), company · processed date. | `renderHeader` |
| Add pages to this packet | Upload a supplementary PDF; see §1.9. | `review.js:795`, `app.py:479` |
| Email status banner | After the email is marked sent: "Client email sent <date> — awaiting reply for N days · M items still awaiting client." Green "All client items resolved." with ✕ when none remain. Clicking jumps to Awaiting client. | `emailBanner` `review.js:770` |
| Adding-pages banner | Spinner while added pages are read; error text if it fails. | `addingBanner` `review.js:788` |
| KPIs | Forms complete (X of 9, lists incomplete forms: missing pages, missing forms) · Required fields complete % · Items need attention · Confidence split bar. | `renderDashboard` `review.js:816`, `incompleteForms` |
| Details table | Per form: status pill (Present / Partial + which page / Missing / Not applicable), required and optional completion. | `renderDashboard` (Show details) |
| Validation errors card | Collapsible table of format/date errors with a "looks like" hint for values on the wrong line and View source. | `renderErrors` `review.js:971` |
| Issues overview card | Donut of open issues by category + per-form breakdown bars (good / issues / missing). | `renderIssuesOverview` `review.js:931` |

### 1.3 Triage (Step 1)

| Feature | What it does | Where |
|---|---|---|
| Queue | Only items needing attention; medium-confidence fields only when their filter pill is on. Sorted open → skipped → waiting on client → resolved, then by issue group. | `triageScope`/`triageQueue` `review.js:1009` |
| Filter pills | One per category present, with live counts, severity-colored; combinable. | `renderTriage` `review.js:1068` |
| Form list | "All forms" + each form with open-issue count. | `renderFormList` `review.js:995` |
| Item kinds | `conflict`, `field`, `group` (one-of-many requirement), `missing_form`, `missing_page`, `unrecognized` (page), `code` (PrismHR code mismatch). | `buildItems` `review.js:588`, `codeItems` `review.js:569` |
| Categories (severity order) | From added pages (+) · Conflicts (≠) · Validation errors (✕) · Scribbles (✎) · Low confidence (!) · Medium confidence (~) · Missing required (○) · Needs choice (?) · Code mismatches (#) · Unrecognized pages. An item with several issues sits in its most specific group. | `CATEGORIES` `review.js:511`, `MOST_SPECIFIC_FIRST` |
| Detail panel | Title, decision status line, value block (badges, adjusted note), item body (conflict options / code options / group members / suggestion / clarify row), page thumbnail, contextual actions, Back/Next. | `renderDetail`, `itemBody` `review.js:1449`, `actionButtons` `review.js:1412` |
| Contextual actions | See table below. Skip on every item. | `actionsFor` `review.js:1376` |
| Done look | Addressed items: grey card, green ✓, "Done — confirmed missing · in client email" / "Done — value entered" / "Done — resolved" / "Done — filled from other forms" / "Done — requested · awaiting client"; still clickable. Header shows "N to do · M done". | `doneBadge` `review.js:1041` |
| Toast + Undo | Every decision shows a toast for 5 s with Undo (posts a `cleared` decision). | `showToast` `review.js:1653`, `undoDecision` `review.js:1669` |
| Auto-advance | After a decision, the next open, unskipped item in the queue. | `performAction` `review.js:1576` |
| Keyboard | ←/→ move, Enter = primary action (or save the typed value). | `onKey` `review.js:2092`, `enterAction` |

**Contextual actions** (`actionsFor`):

| Item | Question | Primary | Secondary |
|---|---|---|---|
| Missing field | "Is this field blank on the scanned form?" | Yes, it's blank → confirmed missing (email) | Enter the value |
| Missing group (one-of) | "Are all of these blank on the scanned form?" | Yes, they're blank | — |
| Missing form | "Is this form missing from the scan?" | Yes, it's missing | — |
| Missing page | "Is page N (label) missing from the scan?" | Confirm page missing | Page is actually there |
| Conflict | — | Save selection (after picking or typing) | (clarify row) |
| Code mismatch | — | Use this code | — |
| Invalid | — | Correct value | Accept as-is (logged "Accepted as-is despite invalid format/value warning") |
| Scribble | — | Enter value | Mark unreadable (→ email) |
| Low / medium / choice / from added pages | — | Confirm value | Correct value |
| Requested (awaiting client) field | — | Save received value (value box open) | — |
| Requested non-field | — | Mark received | — |
| Unrecognized page | — | Confirm page reviewed | — |

### 1.4 Shared item features

| Feature | What it does | Where |
|---|---|---|
| Live format validation | Every value box checks as you type (email, phone 10, SSN 9, ZIP 5/9, routing 9, date); red message under the box; Save disabled while invalid. Empty required → missing flow; empty optional → saved blank. | `validateInputs` `review.js:1192`, `formatError` |
| Re-check on load | Values the reviewer typed or quick-added that now fail their format are reopened in Triage as invalid. | `draw` (`invalidKeys`) |
| Date normalization | Typed dates saved as M/D/YYYY; toast shows "Saved as 1/5/2026". | `normalizeTyped`, `canonicalDate` `review.js:1233` |
| "Found on other forms" quick add | Card "AI found this on other forms: Found on <forms>: '<value>'" + Quick add, for missing, invalid, scribble, low/medium items (rules in §4.11). Quick add fills the value, badge "filled from <forms>", Activity entry, toast, advance. | `itemSuggestion` `review.js:1280`, `quickAdd` `review.js:1634` |
| Ask the client | "Can't tell (from the scan) — ask the client to clarify" + Add to email on conflicts and on invalid, scribble, low, medium, choice fields. | `clarifyRow` `review.js:1342` |
| Conflict panel | Forms involved, majority / no-majority sentence, disclaimer "The most common value is not necessarily the correct one.", one radio per form's reading, "Enter another value" box, clarify row. | `itemBody`, `conflictOptions` `review.js:1115` |
| Rules from the catalog | The web app sends the catalog's current requirement rules; they replace those stored with older extractions. | `applyRules` `review.js:2851` |

### 1.5 Source viewer (two-pane)

| Feature | What it does | Where |
|---|---|---|
| Viewer | Page image left (−/+/Fit width, drag to pan, page arrows), sidebar right: breadcrumb, title, item body, actions, every field of the form with severity tints. | `ensureViewer` `review.js:197`, `renderViewerSidebar` `review.js:453` |
| Session | Opened from Triage: the open items of the queue at that moment. "Item i of N · R remaining". Back from item 1 exits to Triage; Next disabled on the last. | `openViewer` `review.js:313`, `viewerStepItem` `review.js:376` |
| Completion screen | After the last item: "All N items addressed" + breakdown ("2 values entered · 3 confirmed missing"; "· K skipped" if any), toast "Queue complete — X of N addressed", auto-exit after 3 s or Back to triage. | `viewerAdvance`, `viewerComplete` `review.js:396–406` |
| Read-only viewer | From All Forms: zoom, pan, arrows, close only; no actions. | `openViewer(..., readOnly)` |

### 1.6 All Forms (reference)

| Feature | What it does | Where |
|---|---|---|
| Form list + form view | One form at a time: page banners for missing pages, one alert strip (counts link into Triage), "X of Y fields have values", inner-scroll field table with sticky headers, severity row tints, pills (required/optional/conditional badge, confidence, flags, adjusted/filled), conflict notes, "Review in triage →" on every flagged row, page column always visible. | `renderAllForms` `review.js:1742`, `renderFormView` `review.js:1778`, `formAlertStrip` |
| Sweep entry card | "Step 2 — Final pass: verify every field, page by page." + Start/Continue/Open button. | `sweepEntryCard` `review.js:2152` |

### 1.7 Verification sweep (Step 2, full screen)

| Feature | What it does | Where |
|---|---|---|
| Layout | Navy header (kicker, title, sentence, overall "i of N pages · X of M fields verified", Exit). Left: forms with progress; current form lists its pages (✓ green when verified). Middle: page at 100% with −/+/Fit width, pan. Right: all fields on the page. | `renderSweep` `review.js:2318` |
| Pages | Every scanned page with fields, form by form; a form's fields on a missing page form one extra "Missing page" (no image). | `sweepPages` `review.js:2165` |
| Groups | "⚠ Needs attention" (orange container; flips to "✓ Needs attention — all handled") and "✓ Looks good" (green container, Verify all). | `renderSweep` |
| Row actions | Same as Triage per field (Confirm/Correct, Yes it's blank / Enter the value, Enter value / Mark unreadable, Correct value / Accept as-is, quick add, clarify); conflicts expand inline ("Resolve conflict ▾"). Looks-good rows: ✓ Verify / Edit. | `sweepRowHtml` `review.js:2435`, `sweepAct` `review.js:2495` |
| Verify page | Popup: open items listed with flags → Review them / Verify page anyway; else "All N fields on this page are verified. Mark page complete?" (verifying also verifies remaining looks-good fields). Page gets a green check; button becomes "Page verified — next page →". | `openPageModal` `review.js:2558`, `verifyPage` `review.js:2580` |
| Keyboard | Enter = focused row's primary (or save edit), ←/→ pages, Esc closes popup then sweep. | `openSweep` keydown |

### 1.8 Review & Export (final step)

In order: Triage status card (N still open, with Go to item links / "0 items left ✓") → Sweep
status card → **Awaiting client** table (Tag | Field | Form | Go to item; "Email sent <date> ·
waiting N days" / "draft saved, not yet sent"; Copy follow-up email) beside **Client email**
(subject/body editable, status chip, Save draft, Copy, Open in email app, Mark as sent, Reset) →
Export reviewed JSON → **PrismHR payload preview** → Field checklist.
`renderReview` `review.js:2619`, `emailSection` `review.js:2785`, `fillPayloadCard` `review.js:2681`.

| Feature | What it does | Where |
|---|---|---|
| Email draft | Generated from open missing/invalid items, confirmed-missing/unreadable items, clarifications and requested items: "MISSING ITEMS" by form, "PLEASE CLARIFY" lines. Reviewer edits are kept across redraws until Reset/Regenerate. | `emailItems` `review.js:2712`, `emailDraft` |
| Save draft | Saves `email_draft.json`; every included item gets status `requested` (new items get a `requested` decision). | `app.py:146` |
| Mark as sent | Stamps `sent` on the draft and every requested, unsent item in it; Activity "Sent client email". | `app.py:172`, `markEmailSent` |
| Copy follow-up email | Nudge listing only sent, still-awaiting items. | `followUpEmail` `review.js:2824` |
| Export | Downloads `reviewed-<file>.json`: extraction with decisions applied, canonical dates, a `review` record per decided field/conflict/form/page; marks the packet exported. | `export` `app.py:274`, `reviewed_extraction` `app.py:196` |
| Payload preview | importEmployees payload with codes and meanings, masked SSN, Ready / Not ready + blockers, raw JSON; "Demo payload, nothing is sent". | `payload_preview` `app.py:456`, `build_payload` `payload.py:78` |
| Field checklist | Per form: counts (need attention / need client / awaiting / adjusted / verified) and a per-field status table. | `renderReview` |

### 1.9 Add pages to a packet

Upload a PDF on the dashboard → `POST /api/pages/<id>` (PDF check, 409 if one is running) →
background `add_pages` (`extract.py:834`): renders only the new pages, numbers them after the
existing ones, classifies them, extracts only the forms found on them, merges: a field the new
pages fill in or change takes the new reading with `supplement {added, previous, page}`; filled
missing pages are cleared; an absent form becomes present; all packet checks re-run;
`supplements` log appended. The page polls `GET /api/pages/<id>`, reloads, and toasts "Added
page 9 — 2 fields new or changed, now in Triage". Changed fields get the "From added pages"
tag and reopen even if decided earlier.

### 1.10 Activity

Timeline newest first, grouped by day: time, colored verb, field, form, detail (old → new for
edits, "Filled X on Y from A, B: value", "Accepted as-is despite … warning: value", "Chose …",
"Undid 'Edited'", email batches as one entry, "Sent client email"). Go to item for items still
needing attention. `renderActivity` `review.js:1857`, `log` `app.py:117`.

### 1.11 Backend and CLIs

| Feature | Where |
|---|---|
| `python extract.py <pdf>` → `output/<stem>/extraction.json` | `extract.py:918` |
| `python payload.py <extraction.json>` → payload JSON | `payload.py` `__main__` |
| `python check_connection.py` → key/connectivity/SSL diagnosis | `check_connection.py` |
| API key from `ANTHROPIC_API_KEY` or `api_key.txt`, all whitespace removed | `api_key` `extract.py:47` |
| Decision API with validation (`clean_decision`: known action, strings ≤ 2000 chars, ≤ 50 fields, ≤ 10 filled_from) | `app.py:86`, `app.py:125` |
| Job id format check and page-image name check (no path traversal) | `job_path` `app.py:48`, `job_page` `app.py:502` |
| Atomic JSON writes (temp file + rename) | `write_json`, `write_status` |

---

## 2. Use cases

| # | Actor | Goal | Outcome |
|---|---|---|---|
| U1 | Reviewer | Start a review of a scanned packet | Packet extracted; dashboard opens; packet listed on home |
| U2 | Reviewer | See where every packet stands | Home list with status, detail, progress |
| U3 | Reviewer | Get an at-a-glance picture of one packet | Dashboard KPIs, incomplete forms, errors card, issues donut |
| U4 | Reviewer | Confirm a missing field is truly blank | "Yes, it's blank" → confirmed missing, goes in the client email |
| U5 | Reviewer | Enter a value the AI missed | "Enter the value" → typed (validated, dates normalized) → resolved, "adjusted" |
| U6 | Reviewer | Fill a blank from other forms | Quick add → value filled, "filled from …" badge, logged |
| U7 | Reviewer | Resolve a cross-form conflict | Pick a reading or type one → Save selection → all single-field readings set to it |
| U8 | Reviewer | Fix a value on the wrong line / invalid format | Correct value (live checks) or Accept as-is (logged) |
| U9 | Reviewer | Handle an unreadable scribble | Enter value, or Mark unreadable (→ email) |
| U10 | Reviewer | Double-check an uncertain reading | Confirm value / Correct value on low/medium items |
| U11 | Reviewer | Ask the client about something they can't decide | Add to email → "awaiting clarification", PLEASE CLARIFY line |
| U12 | Reviewer | Confirm a whole form or page is missing | "Yes, it's missing" / "Confirm page missing" → email asks for it |
| U13 | Reviewer | Say a "missing" page is actually there | "Page is actually there" → page present, its fields back in the queue |
| U14 | Reviewer | Map a value to a PrismHR code | Code mismatch item → Use this code → payload uses it |
| U15 | Reviewer | Work through items with the page in view | Viewer session with completion screen |
| U16 | Reviewer | Verify every field, page by page | Sweep: per-row actions, Verify all, Verify page |
| U17 | Reviewer | Browse the packet without changing it | All Forms + read-only viewer |
| U18 | Reviewer | Send one email for everything missing | Save draft → send from their email app → Mark as sent |
| U19 | Reviewer | Nudge an unresponsive client | Copy follow-up email (still-awaiting items only); banner shows days waiting |
| U20 | Reviewer | Record the client's answer | Go to item → Save received value / pick the confirmed value → resolved (received) |
| U21 | Reviewer | Add pages the client sent later | Add pages → only new pages read → changed fields in Triage |
| U22 | Reviewer | Undo a mistake | Toast Undo (5 s) |
| U23 | Reviewer | Export clean data | Export reviewed JSON; PrismHR payload preview with blockers |
| U24 | Reviewer / auditor | See who decided what, when | Activity timeline |

---

## 3. User flows

### 3.1 Main journey

1. **Home** (`/`) — Upload new packet.
2. **Upload** (`/upload`) — drop/choose PDF → Upload and review. Non-PDF (by signature) → inline drop-zone error. Over 50 MB → Flask's 413 page (see §5).
   The relevance check runs first: fewer than 2 catalog forms → wrong-document screen; the packet is only listed on home once it passes.
3. **Processing** (`/processing/<id>`) — steps tick off; on error "Extraction failed: <error>. Go back and try again."; on success → review page.
4. **Dashboard** (top of `/review/<id>`) — KPIs; optionally expand details.
5. **Triage** (default tab) — work items with contextual actions; filter by category/form; open the viewer for a session; each decision toasts with Undo and auto-advances. Items handled = done look.
6. **Verification sweep** (from All Forms or Review & Export) — page by page; Needs attention rows, Looks good rows (Verify all), Verify page → green check; Next page.
7. **Review & Export** — triage card says 0 left, sweep complete, Awaiting client empty or waiting; Save draft → Mark as sent; Export reviewed JSON; check payload preview.

### 3.2 Alternate paths

| Path | Steps | Result |
|---|---|---|
| Client email | Items confirmed missing / unreadable / clarify + open missing and invalid items → email draft → Save draft (items "requested") → send from own email app → Mark as sent | Rows "Email sent <date> · waiting N days"; dashboard banner |
| Client replies with answers | Awaiting client → Go to item (value box focused) → type → Save received value; conflicts: pick the confirmed value → Save selection | Decision resolved, `received: true`, Activity "Received from client"; banner count drops; green when none left |
| Client sends new pages | Dashboard → Add pages → PDF → reading banner → reload toast | New page(s) appended, changed fields tagged "From added pages" in Triage, missing pages cleared, prior decisions untouched |
| Follow-up nudge | Awaiting client → Copy follow-up email | Clipboard text listing only still-awaiting sent items |
| Undo | Toast Undo within 5 s | Decision removed, Activity "Undid '<verb>'", item reopens |
| Reopen a done item | Click a done card → act again | New decision replaces the old (logged) |
| Skip | Skip | Item stays open, sorted after unskipped ones; not addressed in completion counts |
| Export early | Export anytime | Open items keep their flags; status "open" records where skipped |
| Re-save draft after more items | Save draft again | New items "draft saved, not yet sent"; Mark as sent becomes available again; earlier items keep their sent date |

---

## 4. Edge case catalog

Format: **scenario** — example input → exact behavior. "✔ traced" marks cases run through the
real code during this audit (§6).

### 4.1 Forms and pages

| Scenario | Example | Behavior |
|---|---|---|
| Form missing (required form) | No Handbook page in the scan | `absent_form` status `missing` (`extract.py:310`); `missing_form` item "Is this form missing from the scan?"; email "This form is missing from the packet. Please have <name> complete and sign it."; payload blocker "Required form missing: …" |
| Form not applicable (conditional) | No Direct Deposit or HC-5 page | Status `not_applicable` with note ("Required only if …"); never missing; gray "Not applicable" |
| Form partial (missing page) | Employment Agreement page 2 absent | `detect_missing_pages` (`extract.py:283`): fewer pages than required catalog pages **and** all fields of that page empty → status `partial`, `missing_pages [{page, label, fields}]`, fields `page_missing`; dashboard "⚠ Employment Agreement: signature page missing"; banner "Page 2 (Signature page) appears to be missing from the scan — N fields couldn't be extracted…"; item with "Confirm page missing" / "Page is actually there"; email "Please resend the signature page (page 2)"; payload blocker |
| Fewer pages but fields were read | Page count short, every page's fields have values | Not partial (cross-check) |
| Optional catalog pages | I-9 lists page, HW-4 worksheets (`required: false`) | Their absence never makes the form partial |
| "Page is actually there" | Reviewer overrides the missing page | Page cleared in the UI and export (`page_present`; form `present` when all its pages are present); its empty fields become normal missing items |
| Unrecognized page | A page from no catalog form | Classified `unidentified`; kept with a thumbnail; item "Confirm page reviewed"; never dropped |
| Page the model skipped in classification | Model returns no label for page 4 | Treated as `unidentified` (`classify_pages`) |
| Field the model skipped | No reading for a field | Value "", confidence low (`read_field`) |
| Cover checklist | Cover page present or not | Extracted but hidden from review (`reviewedForms`) |

### 4.2 Missing required vs optional

| Scenario | Example | Behavior |
|---|---|---|
| Required field blank | Employment Form "Job Title" "" | Red "missing", `missing` tag, Missing required item, counts toward required % |
| Optional field blank | "Employee ID#" "" | Gray "blank"; no item; not in counts or email |
| One-of group unsatisfied | Hourly and Salary both blank | Members "missing", one `group` item "Are all of these blank…" |
| One-of group satisfied | Hourly $30 | Salary shows "not used" |
| Partly filled option | List B given, List C blank | List C still "missing" (option needs both halves) |
| Whitespace-only extracted value | Model returns "   " | Python treats it as empty (missing/required counts); **the UI treats it as a value** — see §5 |
| Typed blank | Reviewer saves "   " | Trimmed to empty: required → missing flow (confirmed missing); optional → saved blank |

### 4.3 Conditional fields (catalog rules)

| Scenario | Example | Behavior |
|---|---|---|
| Pay period with hourly | Hourly $30, Salary blank, Pay period blank | `required_if` Salary not met → gray "n/a", `not_applicable: true`, no flag/item/email |
| Pay period with salary | Salary 40.000, Year checked | Required, satisfied |
| Pay period with salary, no box | Salary set, no box | Required → missing item |
| HC-5 3a–3d without box 3 | Box 3 empty | n/a |
| HC-5 3a–3d with box 3 and sub-box b | "b. covered as a dependent…" | Requirement met (options field, several allowed) |
| HC-5 box 3 with no sub-box | Box 3 checked, 3a–3d empty | Missing item "required: checkbox 3 selected" |
| HC-5 checkbox 5 effective date | Box 5 checked, date blank | Missing; otherwise n/a |
| I-9 USCIS number | Status box 1 | n/a; box 4 ("authorized to work" / leading "4") → required |
| I-9 List A vs B+C | Passport in List A | List A Issuing Authority / Number required; B and C "not used". B+C given → List A fields n/a |
| I-9 expiration not required | List C document "Social Security card" | `optional_if_matches` → "optional: document has no expiration", n/a |
| Direct deposit block 1 | All five blank | n/a (`required_with`); any one filled → all five required |
| Stale extraction rules | Packet read before a rule change | Catalog rules re-applied on load (`applyRules`); stale "no box checked" flags ignored when n/a |

### 4.4 Checkboxes

| Scenario | Example (model output) | Behavior |
|---|---|---|
| Single checkbox marked | "X", "✓", "checked", "partially marked" | `normalize_checkbox` → "checked" (anything not in the unchecked set) ✔ traced |
| Single checkbox empty | "", "unchecked", "No", "false", "N/A", "☐", "[ ]", "off" | "" ✔ traced |
| Option field | Pay period, W-4 filing status, I-9 status, 3a–3d | `checked_options` labels joined "; " as the value |
| Single-choice with none checked | W-4 filing status blank | `missing` flag → "Needs choice" item; email "no box is checked" |
| Single-choice with two checked | Two filing statuses | `ambiguous_choice`, confidence low, value lists both |
| One-box-per-field group (HC-5 1–5) | None / two checked | none → all boxes flagged; two → `ambiguous_choice` on both |
| Ambiguous single checkbox (faint mark) | — | No ambiguity state for single checkboxes: model's call becomes checked/blank; confidence carries the doubt |

### 4.5 Conflicts

Checks (`CROSS_CHECKS`): Address, Name, Date of birth, SSN (critical), Start date, and I-9's
two signature dates (the only form with two). Values normalized before comparing: text =
lowercase without spaces/punctuation, names = sorted words longer than one letter, dates =
parsed date. Blank values never conflict.

| Scenario | Example | Behavior |
|---|---|---|
| Majority | Address: 2 forms "45-123A Waikalua Rd", HW-4 "45-173A" | Majority = "45-123A Waikalua Rd", HW-4 "differs"; "The most common value is '…'." ✔ traced |
| No majority | DOB "Sept 4, 85" vs "09/04/1983" (1 vs 1) | `majority: null`, every reading "differs"; "No majority: the values disagree with each other…" ✔ traced |
| Same value written differently | DOB "Sept 4, 85" vs "09/04/1985" | No conflict ✔ traced |
| SSN mismatch | 983-31-3452 vs 983-31-3425 | Severity `critical`; payload blocker ✔ traced |
| Different person's name | "Taylor Swift" vs "Travis Kelce" | `type: name_mismatch`, critical, sorted first ✔ traced |
| Nickname | "Lebron James" vs "Bron James" | Still a conflict (warning), not critical; also prefixes ("Tay") and the employee's listed nicknames ✔ traced |
| "Last, First" order / middle initial | "Swift, Taylor" vs "Taylor A Swift" | Same name (no conflict) |
| Within-form dates | I-9 Section 1 2/28/2026 vs Section 2 3/1/2026 | Conflict "Signature dates — Form I-9 …" (warning) ✔ traced |
| OCR misread vs genuine disagreement | "123A" vs "173A" | Not distinguished: both are conflicts; majority framing + disclaimer leave the call to the reviewer |
| Resolution | Pick a reading / type one | Value applied to every single-field reading; multi-field readings (e.g. I-9 street + apt) are left as read |

### 4.6 Formats (`extract.py:691`, `review.js:1162`)

Separators `\s ( ) -` are removed before digit checks (the UI also removes `.`).

| Type | Rule | Valid | Invalid → message |
|---|---|---|---|
| Email | `[^@\s]+@[^@\s]+\.[A-Za-z]{2,}` | ljames@gmail.com | "lebron@", "a@b.c", "x y@z.com" → "Not a valid email address." ✔ traced |
| Phone | 10 digits | 808-853-9621, (808) 853 9621 | "Ø", "808 853 962" → "Phone number must be 10 digits." ✔ traced |
| SSN | 9 digits | 983-31-3452, 983313452 | "98-331-345" → "SSN must be 9 digits." No area-number rule (removed by request): 000-00-0000 passes ✔ traced |
| ZIP | `\s*\d{5}(\s*-\s*\d{4})?\s*` | 96701, 96701-1234 | "967011234" (ZIP+4 without dash), "9670" → "ZIP code must be 5 digits (optionally +4)." ✔ traced |
| Routing | 9 digits | 371380315 | "37138031" → "Routing number must be 9 digits." |
| Wrong line | A failing value that matches another type (order: email, date, SSN, phone, ZIP) | — | "Value looks like a Social Security Number, not a phone number — it may have been written on the wrong line." + `suspected_type`; email line "this looks like it was written on the wrong line" ✔ traced |

### 4.7 Dates

Parser accepts m/d/y (2- or 4-digit year), y-m-d, "Mon d, y", "Month d y" (ordinal suffixes
allowed). Two-digit years: 00–49 → 2000s, 50–99 → 1900s. Output M/D/YYYY, no leading zeros.

| Input | Output |
|---|---|
| "Mar 1 2026", "March 1, 2026", "03/01/2026", "3-1-26", "2026-03-01" | 3/1/2026 ✔ traced |
| "Sept 4, 85" | 9/4/1985 ✔ traced |
| "1/5/49" / "1/5/50" | 1/5/2049 / 1/5/1950 ✔ traced |
| "March 1/2", "13/45/2026", "2/30/2026" | Not a date: kept as written, `invalid_value` "Not a parseable calendar date."; email "the date is incomplete or unclear"; typing it shows "Not a valid date — use a format like 3/15/2026." ✔ traced |
| "N/A", "none", "--" | Not validated (allowed on any date field) — see §5 ✔ traced |
| DOB in the future | 1/1/2030 | "Date of birth is in the future." ✔ traced |
| Start date before DOB | 3/15/1980 vs 1/1/1990 | "Start date is before the date of birth (… on …)." — one error per DOB reading ✔ traced |
| Where applied | Extraction (`read_as` keeps what was written), typed edits, display of older packets, conflicts, errors, email, Activity, export | — |

### 4.8 Scribbles and confidence

| Scenario | Behavior |
|---|---|
| Scribble / cross-out unreadable | Value "", confidence low, `illegible_scribble`; Scribble item: Enter value / Mark unreadable; email "we couldn't read it (crossed out or unclear)" |
| Crossed out with readable correction | Correction transcribed, no scribble flag |
| Low confidence | "Low confidence" item (needs attention): Confirm / Correct |
| Medium confidence | Not counted as needing attention; shown only with the Medium filter; sweep lists it under Needs attention |
| Flagged fields | Conflict/invalid/ambiguous flags force confidence low |

### 4.9 Cross-form quick add (`itemSuggestion` `review.js:1280`)

| Scenario | Example | Behavior |
|---|---|---|
| Missing, one valid value elsewhere | Email blank on Employment Form, I-9 has it | Card "Found on Form I-9: '…'" + Quick add |
| Missing, forms disagree | Two different phones elsewhere | No card (conflict path) |
| Missing, other value invalid | Other form's phone "Ø" | Ignored; no card |
| Invalid, valid different value elsewhere | HC-5 phone "Ø", I-9 8088339621 | Card shown; Quick add fills; note "AI read: Ø → filled with …" |
| Invalid, same value elsewhere | — | No card |
| Low/medium | Other forms agree with high confidence (or reviewer-settled) | Card shown |
| Scribble | One valid agreed value elsewhere | Card shown |
| Multi-part sources | City+State+ZIP from Employment Form | Joined only when every part is filled |

### 4.10 Client email lifecycle

| Stage | Behavior |
|---|---|
| Draft | Items included automatically; reviewer edits kept; "Draft saved, not yet sent" after save |
| Sent | Mark as sent stamps time; rows "Email sent … · waiting since today / N days" |
| Awaiting | Items state `requested`; done look "requested · awaiting client"; home "Awaiting client · email sent · waiting N days" |
| Resolved | Received value / chosen value → `received: true`; Activity "Received from client"; banner green when none left; dismissible |
| Unresponsive client | Banner day count grows; Copy follow-up email lists the remaining items. No reminders, deadlines, or escalation (§5) |
| Clarifications | Invalid: "<Field> on <Form> reads '<value>', which is not a valid <type>. Please provide the correct <field>." · Low/scribble: "… could not be read clearly (AI read: '<value>'). Please confirm the correct <field>." · Conflict: "<Field>: A shows 'x' and B shows 'y'. Please confirm the correct <field>." |

### 4.11 Add pages

| Scenario | Behavior |
|---|---|
| Missing page supplied | Page appended (e.g. page 9), fields filled, missing page cleared, form present, toast with counts |
| Value changed by new page | Field takes new reading, keeps `previous`; tagged "From added pages"; decisions made before the upload no longer settle it (reopened) |
| Same value as before | Skipped (no change) |
| Unrecognized new page | Added to unrecognized pages → item |
| Previously absent form arrives | Form becomes present with the new reading |
| Upload while another is running | 409 "Pages are already being added to this packet." |
| Non-PDF | 400 "That file isn't a PDF. Please upload the new-hire packet as a PDF." |
| Extraction error | Banner "Adding pages failed: <error>" |
| Prior decisions, email, activity | Untouched (verified byte-for-byte in testing) |

### 4.12 PrismHR codes (`CODE_CHECKS` `review.js:561`, `payload.py`)

| Scenario | Example | Behavior |
|---|---|---|
| Job title matches | "Retail Worker" | RW |
| Job title matches nothing | "Surf Coach" | Code mismatch item listing IN/OW/RW → Use this code → payload uses it; payload blocker "No job code matches …" until then |
| Location | "Retail" / "dept = beach" | First word of a code description in the value → 1 / 2 |
| Employee type | "Full-Time" / "Relief" | FT / CA (Relief alias) |
| Pick then correct the title | Pick IN, later correct to "Retail Worker" | Written match wins (RW); pick ignored |
| Source blank | No position | No code item (missing-field flow covers it); payload `jobCode: null` + blocker |

### 4.13 Input and file edge cases

| Scenario | Behavior |
|---|---|
| Corrupt PDF (right header, broken body) | Passes the magic-byte check; rendering raises `PDFPageCountError` → processing shows "Extraction failed: PDFPageCountError: Unable to get page count. … Go back and try again." ✔ traced (truncated LeBron PDF) |
| Not a PDF (checked by the file signature `%PDF-`, not the name; in the browser before upload and again on the server) | Inline on the drop zone: "That file isn't a PDF. Please upload the new-hire packet as a PDF."; Upload stays disabled; drop zone stays active. A PNG renamed `.pdf` is rejected too |
| Wrong document (fewer than 2 of the 9 catalog forms found) | After the page classification only (no field extraction): `/rejected/<id>` "Wrong document — This doesn't look like a new-hire packet. Please check the file and upload the correct PDF.", Upload a different file, and "View what was detected" (page, matched form, what the page looks like). Not added to the packet list; the PDF and page images are deleted |
| No file chosen | 400 "Choose a PDF to upload." |
| Over 50 MB | Flask's default 413 page (§5) |
| Blank packet (pages with no forms) | Every page unidentified (thumbnails + items); 6 required forms missing; Direct Deposit and HC-5 not applicable |
| Model refusal / output cut off | `RuntimeError` → job error with the reason |
| No API key / network failure | Job error with cause (`check_connection.py` diagnoses) |
| Invalid typed value | Save disabled with red message; Enter blocked |
| Typed value saved, later invalid | Reopened on load as invalid |
| Special characters | Stored as typed; HTML-escaped on screen; URL-encoded in mailto |
| Overlong value (> 2000 chars) | Server rejects (400) → alert "Saving failed (400)"; no input length limit in the UI |
| Undo | 5-second toast only; restores "no decision" (not the previous decision) |
| Back from item 1 in the viewer | Exits to Triage |

---

## 5. Unhandled edge cases

Reachable today with no handling (or inconsistent handling):

1. **Dotted phone numbers disagree between extractor and UI.** Python strips `\s()-` but not `.`, so "808.853.9621" is flagged invalid at extraction; the UI strips `.` too, so the same value passes live validation and the reload re-check. ✔ traced
2. **Whitespace-only extracted values.** Python `has_value` strips (" " = empty → missing, required counts); the UI's `hasValue` doesn't (shown as a value, no missing item). ✔ traced
3. **"N/A" on any date field passes.** `NO_DATE` is meant for expiration dates but applies to every date field, so DOB "N/A" is neither invalid nor missing. ✔ traced
4. **SSN plausibility.** Only the digit count is checked; 000-00-0000 or 9xx area numbers pass (area rule removed by request).
5. **Uploads over 50 MB** get Flask's raw 413 page, not the upload screen's error box.
6. **Zero-page or encrypted PDFs** — not tested; would surface as a generic extraction error.
7. **Unrecognized pages can't be assigned** to a form; "Confirm page reviewed" is the only action.
8. **A conditional form that should be there** (employee wants direct deposit or is waiving coverage, but the form is absent) is silently "not applicable".
9. **Single-checkbox ambiguity** — a faint or partial mark becomes "checked"; there is no "unclear mark" state.
10. **OCR misread vs genuine disagreement** isn't distinguished; both are conflicts.
11. **Multi-field conflict readings** (e.g. I-9 street + apartment) aren't updated when the conflict is resolved.
12. **Duplicate start-date errors** — one error per DOB reading when several DOBs exist.
13. **Unresponsive client** — no reminders, deadlines, or escalation; just the day count and manual follow-up.
14. **Undo is short and shallow** — 5 seconds; restores "no decision" instead of the previous decision; email save, Mark as sent and Verify all can't be undone.
15. **Concurrent reviewers** — no locking or refresh; the last write per item wins and other screens are stale until reload.
16. **Re-uploading the same packet** creates a second job; no duplicate detection.
17. **Overlong values** are only caught by the server (400 alert), not limited in the input.
18. **Sent email history** — re-saving the draft overwrites `email_draft.json`; only per-item `sent` dates survive.
19. **No real sending** — email and PrismHR import are drafts/previews; nothing confirms delivery.
20. **Add-pages can't be undone**; a wrongly added page stays (its changes can be corrected field by field).

---

## 6. Verification

Five cases picked from the catalog (plus extras) and run through the real code, Oct 8:

| Case | How it was checked | Result |
|---|---|---|
| Date "March 1/2" (§4.7) | `extract.canonical_date` and `validate_values` | `None` → "Not a parseable calendar date."; the UI showed the invalid-date message and disabled Save in browser testing — **matches** |
| Checkbox "partially marked" / "unchecked" (§4.4) | `extract.normalize_checkbox` | "checked" / "" — **matches** |
| Address 2 vs 1 (§4.5) | `detect_conflicts` on a built packet | majority "45-123A Waikalua Rd", warning — **matches** |
| Nickname "Bron" (§4.5) | `detect_conflicts` | conflict, severity warning, no `name_mismatch` — **matches** |
| ZIP "967011234" (§4.6) | `format_ok("zip", …)`, `suspected_type` | invalid; suspected SSN (9 digits) → "Value looks like a Social Security Number, not a ZIP code…" — **matches** |
| Extra: dotted phone, whitespace value, DOB "N/A" (§5 items 1–3) | Python functions + the UI's own regex/`hasValue` in Node | Inconsistencies confirmed as documented |
| Extra: DOB future / start before DOB, wrong-line detection, SSN critical, name mismatch, signature dates, blank skipped | `validate_values`, `detect_conflicts` | All as documented; the duplicate start-date error (§5 item 12) was found this way |
