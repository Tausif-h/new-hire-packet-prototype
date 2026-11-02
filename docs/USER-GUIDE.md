# Packet Review — User Guide

A friendly, start-to-finish walkthrough. By the end you'll have taken a scanned new-hire packet
from upload to a clean export, and you'll know what every button is for.

**What the app does, in one sentence:** you upload a scanned new-hire packet (a PDF of up to 9
forms), AI reads every field, and the app walks you through checking what it found: what's
missing, what's unclear, and where forms disagree. Then you email the client for anything you
can't fix yourself and export clean employee data.

**Contents**

0. [At a glance: what was built, the workflow, the journey, edge cases](#0-at-a-glance)
1. [Set up (one time)](#1-set-up-one-time)
2. [Start the app](#2-start-the-app)
3. [The home screen](#3-the-home-screen)
4. [Upload a packet](#4-upload-a-packet)
5. [Read the dashboard](#5-read-the-dashboard)
6. [Step 1 — Triage: work the flagged items](#6-step-1--triage-work-the-flagged-items)
7. [Working with the page in view (the viewer)](#7-working-with-the-page-in-view-the-viewer)
8. [All Forms: look things up](#8-all-forms-look-things-up)
9. [Step 2 — The verification sweep](#9-step-2--the-verification-sweep)
10. [Final step — Review & Export](#10-final-step--review--export)
11. [When the client replies](#11-when-the-client-replies)
12. [Activity: what happened, when](#12-activity-what-happened-when)
13. [Keyboard shortcuts](#13-keyboard-shortcuts)
14. [Troubleshooting](#14-troubleshooting)
15. [Glossary](#15-glossary)
16. [Edge cases: situations and mitigations](#16-edge-cases-situations-and-mitigations)

---

## 0. At a glance

### What was built

| Area | What it does |
|---|---|
| **Extraction** (`extract.py`) | Turns the PDF into page images, sorts each page into one of the 9 catalog forms (or "unidentified"), reads every catalog field with Claude vision, and records confidence, scribbles and checkboxes. Rejects files that aren't new-hire packets before reading anything. |
| **Checks** | Missing forms, pages and required fields; conditional rules; checkbox choices; formats (email, phone, SSN, ZIP, routing, dates); impossible dates; cross-form conflicts; values written on the wrong line; signed-but-incomplete forms. |
| **Form catalog** (`data/form_catalog.json`) | The 9 forms, their pages and every field's rules: required, one-of groups, conditional, options, format. |
| **Web app** (`app.py`) | Packet list, upload, processing screen, review page, saved decisions, client email, export, PrismHR payload preview, adding pages later. |
| **Review UI** (`static/review.js`) | Dashboard, Triage, page viewer, All Forms, verification sweep, Review & Export, Activity. ProService branding, severity colors, undo, keyboard shortcuts. |
| **PrismHR** (`payload.py`, `data/client_codes.json`) | Maps values to client 15650's codes (job, location, employee type, pay group) and lists what blocks the import. Demo only: nothing is sent. |
| **Docs** | This guide, `README.md` (setup) and `docs/PRODUCT-REFERENCE.md` (full feature and edge-case reference). |

### The workflow

1. **Upload** the PDF. The file's signature is checked (PDF only), then the pages are checked (is this a packet?).
2. **Extract.** The AI sorts the pages, reads every field, and runs every check.
3. **Dashboard.** Get the overview: forms complete, required %, items needing attention, confidence.
4. **Triage (Step 1).** Decide every flagged item.
5. **Verification sweep (Step 2).** Check every field, page by page.
6. **Client email.** Generate it, save it, send it from your email, mark it sent.
7. **Client replies.** Enter their values, or add the pages they send.
8. **Export.** Download the reviewed JSON and check the PrismHR payload.

### The user journey

```
Home ─► Upload ─► Processing ─► Dashboard ─► Triage ─► Sweep ─► Review & Export ─► Export
          │            │                        │                     │
          │            └─ wrong document ─► "Upload a different file"   ├─ Save draft ─► Mark as sent ─► (waiting N days) ─► Copy follow-up
          └─ not a PDF ─► fix on the drop zone                         │
                                                                       └─ Client replies ─► Save received value ─► resolved
                                                  Dashboard ─► Add pages ─► new/changed fields back in Triage
Any decision ─► Undo (5 s) or reopen the item later
```

### Edge cases accounted for

| Area | Handled |
|---|---|
| **Upload** | Non-PDF (also a PNG renamed .pdf) shows an inline error. A non-packet PDF (fewer than 2 forms) gets the wrong-document screen with what was seen on each page and creates no packet. A corrupt PDF shows an error on the processing screen. |
| **Forms and pages** | Missing form. Partial form (a required page missing, cross-checked against empty fields). Optional pages (I-9 lists, HW-4 worksheets) ignored. "Page is actually there" override. Conditional forms (Direct Deposit, HC-5) not applicable when absent. Unrecognized pages kept and listed. |
| **Required vs optional** | Only required blanks are "missing". Optional blanks show "blank". One-of groups (hourly or salary). Half-filled options (List B without List C). |
| **Conditional fields** | Pay period only with salary. HC-5 3a–3d only with box 3 (any one sub-box satisfies it). HC-5 date only with box 5. I-9 USCIS number only with status box 4. List A vs List B+C. Expiration date optional for documents without one. Direct deposit block all-or-nothing. Unmet conditions show "n/a" and never reach Triage or the email. |
| **Checkboxes** | Marks of any kind count as checked; "no", "unchecked", "N/A" count as empty. No box or two boxes on a one-box choice → "Needs choice". Sub-boxes read individually. |
| **Conflicts** | Address, name, date of birth, SSN (critical), start date, and I-9 signature dates. Values normalized before comparing. Blanks skipped. Majority or no-majority framing with a disclaimer. Another person's name → critical "name mismatch". Nicknames and "Last, First" order recognized. |
| **Formats** | Email; phone 10 digits; SSN 9 digits; ZIP 5 or ZIP+4 with a dash; routing 9 digits. A value that looks like another type ("looks like an SSN") is flagged as possibly on the wrong line. |
| **Dates** | "Mar 1 2026", "3/1/26", "2026-03-01" and others are all stored and shown as 3/1/2026. Two-digit years: 00–49 are 2000s, 50–99 are 1900s. "March 1/2" stays flagged invalid. Date of birth in the future and start date before date of birth are flagged. |
| **Readability** | Scribbles → value cleared and flagged. Low confidence needs attention. Medium is opt-in in Triage but listed in the sweep. |
| **Quick add** | Offered only when other forms agree on one valid value (with high confidence for low/medium items). Never when they disagree or are invalid. |
| **Editing** | Live format check, with Save disabled while invalid. An empty required value goes down the missing path. Typed values that later fail a check reopen in Triage. Values are HTML-escaped. Overlong values are rejected. Undo within 5 s. |
| **Client email** | Missing items plus "Please clarify" lines. Edits kept. Draft → sent → waiting N days → follow-up → received → resolved. Ask-the-client works for conflicts and unclear values. |
| **Added pages** | Only new pages are read. Changed fields return to Triage with the value they had before. Earlier decisions, email and activity are untouched. |
| **PrismHR codes** | A value with no matching code becomes a Triage item. The reviewer's pick is used unless the written value matches a code. Blockers are listed. |
| **Known gaps** | See "Unhandled edge cases" in `docs/PRODUCT-REFERENCE.md` (e.g. dotted phone numbers, "N/A" on any date, concurrent reviewers). |

---

## 1. Set up (one time)

Skip this section if someone already set the app up on your computer.

You need:

1. **Python 3.10 or newer.** Open Terminal and type `python3 --version`. If it prints 3.10 or
   higher, you're set. If not, install Python from https://www.python.org.
2. **poppler** (lets the app read PDFs).
   - Mac: `brew install poppler` (needs Homebrew from https://brew.sh)
   - Windows: download it from https://github.com/oschwartz10612/poppler-windows/releases,
     unzip it, and add its `bin` folder to your PATH
   - Linux: `sudo apt install poppler-utils`
3. **The app's Python packages.** In Terminal, go to the app folder and install them:
   ```
   cd ~/Downloads/new-hire-packet-prototype
   pip3 install -r requirements.txt
   ```
4. **An Anthropic API key.** Open `api_key.txt` in the app folder, paste the key in, and save.
   (Spaces or line breaks in the key don't matter; they're removed automatically.)
5. **Check it all works:**
   ```
   python3 check_connection.py
   ```
   You should see **"OK: connected to the API."** If not, it tells you what's wrong (see
   [Troubleshooting](#14-troubleshooting)).

> **Keep your key private.** Don't share or upload the folder with your key in `api_key.txt`.

---

## 2. Start the app

1. Open Terminal and run:
   ```
   cd ~/Downloads/new-hire-packet-prototype
   python3 app.py
   ```
2. Open **http://127.0.0.1:5050** in your browser (Chrome, Safari, or Edge).
3. Keep the Terminal window open while you work. When you're done, click the Terminal window
   and press **Ctrl+C** to stop the app.

Everything you do is saved as you go, so you can stop the app and come back later; your work
is still there.

---

## 3. The home screen

The home screen (**Packets**) lists every packet review:

| Column | What it tells you |
|---|---|
| Employee, Company | Who the packet is for |
| Pages, Processed | How big the scan is and when it was read |
| Status | Where the review stands (see below) |
| Progress | How much of the review is done |

**Statuses**, in the order a packet moves through them:

| Status | Meaning |
|---|---|
| **Processing** | The AI is still reading it |
| **In triage** (N items left) | Flagged items still need your decision |
| **In verification sweep** (X of Y) | Triage is done; the field-by-field check isn't |
| **Awaiting client** | Waiting for the client to answer your email |
| **Ready to export** | Everything is resolved |
| **Complete** | Exported |
| **Failed** | Something went wrong reading it (open it to see why) |

Rows marked **sample** are made-up examples to show what the list looks like; they don't
open a real packet.

Click any real row to open that packet. Click **Upload new packet** to start a new one.

---

## 4. Upload a packet

1. Click **Upload new packet** (top right).
2. Drag the PDF onto the drop zone, or click it to choose a file.
   Try `sample_packets/new-hire-lebron.pdf` for your first run; it has plenty to fix.
3. Click **Upload and review**.

**What you'll see next:** a processing screen ticks through *Identifying forms → Extracting
fields → Checking confidence → Validating formats → Detecting conflicts → Building review*.
It takes a minute or two, then the packet opens on its own.

**Two things can stop an upload:**

- **"That file isn't a PDF. Please upload the new-hire packet as a PDF."** You picked an image
  or another file type. Choose the PDF instead; the drop zone stays ready.
- **"Wrong document — This doesn't look like a new-hire packet."** The app checks the pages
  first and found fewer than 2 of the 9 packet forms (for example, you uploaded an invoice).
  Nothing is saved. Click **View what was detected** to see what it thought each page was, then
  **Upload a different file**.

---

## 5. Read the dashboard

The top of every packet page is the dashboard. Take ten seconds here before you start.

- **The stepper** along the top shows the journey: Upload ✓ → Extract ✓ → **Review** → Request
  info → Export.
- **The packet name** (the employee), the file name chip, and **+ Add pages to this packet**
  (for later, when the client sends missing pages; see [section 11](#11-when-the-client-replies)).
- **Four numbers:**
  - **Forms complete** (e.g. "7 of 9"), with any missing forms or pages listed right under it,
    e.g. *"⚠ Employment Agreement: signature page missing"*.
  - **Required fields complete** (a percentage).
  - **Items need attention**: your to-do count for Triage.
  - **Confidence split**: how much the AI read clearly (high) vs. with doubt (medium, low).
- **Show details** opens a table of all 9 forms with their status: **Present**, **Partial**
  (a page is missing), **Missing**, or **Not applicable** (an optional form that isn't needed).
- **Validation errors** lists values with the wrong format, like a phone number with too few
  digits. If a value looks like it belongs on a different line ("Looks like: SSN"), it says so.
- **Issues overview** is a donut of everything still open, by type, and a bar per form.

Below the dashboard are four tabs: **Triage**, **All Forms**, **Review & Export**, **Activity**.
Each one opens with a short header that tells you what that screen is for.

---

## 6. Step 1 — Triage: work the flagged items

This is where most of the work happens. **Triage only shows things that need your decision.**

### The layout

- **Filter pills** across the top: one per kind of issue, with a count. Click one to show only
  that kind; click again to clear it.
- **Form list** on the left: pick a form to see only its items.
- **The queue** in the middle: one card per item, color-coded by severity.
- **The detail panel** on the right: everything about the selected item, a thumbnail of the page
  it came from, and the buttons to decide.

### Colors and what they mean

| Color / tag | Kind | What it usually means |
|---|---|---|
| Orange **≠ conflict** | Conflict | Two forms disagree (e.g. different addresses) |
| Red **✕ invalid** | Validation error | Wrong format (phone, SSN, ZIP, email, routing number, date) |
| Purple **✎ scribble** | Scribble | Crossed out or unreadable |
| Amber **! low** | Low confidence | The AI could barely read it |
| Gold **~ medium** | Medium confidence | Readable but uncertain. Hidden unless you click its pill |
| Pink **○ missing** | Missing required | A required field is blank |
| Gray **? needs choice** | Needs choice | No box (or two boxes) checked where one is needed |
| Teal **# no code** | Code mismatch | A value doesn't match any PrismHR code |
| Blue **+ new page** | From added pages | A value that changed when the client sent new pages |

### Deciding an item

Click an item, look at the page thumbnail (click it to enlarge), and pick the button that fits.
The buttons change to suit each kind of item:

**A required field is blank** ("missing")
- The panel asks: **"Is this field blank on the scanned form?"**
- **Yes, it's blank** if it really is blank. It goes into the client email automatically.
- **Enter the value** if you can see it on the page (or know it). Type it and click **Save value**.

**Two forms disagree** (conflict)
- You'll see each form's value as an option. If most forms agree, it tells you the most common
  value, but remember: *the most common value isn't necessarily the correct one.* Check the
  page.
- Pick the right value (or choose **Enter another value** and type it), then **Save selection**.
- Can't tell from the scan? Click **Add to email** next to *"Can't tell from the scan — ask the
  client to clarify."*

**A value has the wrong format** (invalid)
- **Correct value**: type the right one.
- **Accept as-is**: keep it anyway (this is noted in the activity log).

**Scribbled or crossed out**
- **Enter value** if you can make it out, or **Mark unreadable** to ask the client.

**Low or medium confidence**
- **Confirm value** if the reading matches the page, or **Correct value** if it doesn't.

**A whole form or page is missing**
- **Yes, it's missing** / **Confirm page missing** to ask the client for it.
- **Page is actually there** if the page is in the scan after all. Its fields come back into
  the queue so you can check them.

**A value matches no PrismHR code** (e.g. a job title that isn't a known position)
- Pick the code to use from the list and click **Use this code**.

**Not sure yet?** Click **Skip**. The item stays open and moves after the others.

### Handy shortcuts while deciding

- **"AI found this on other forms"**: if the same value (an email, a phone number, an
  address) is written correctly on another form, a blue card offers it. Click **Quick add** to
  fill it in. The field gets a "filled from …" badge so you can see where it came from.
- **"Can't tell — ask the client to clarify"**: on unclear and invalid items, **Add to email**
  sends the question to the client instead of guessing.
- **Typing a value is checked as you type.** A bad email, a 9-digit phone, or an impossible date
  shows a red message and the Save button stays off until it's right. Dates you type are
  tidied up automatically, e.g. "January 5 2026" is saved as **1/5/2026**.

### What happens after you decide

- A message pops up at the bottom (e.g. *"Marked missing — added to the client email draft"*)
  with an **Undo** button for 5 seconds.
- The next item opens on its own.
- The item you finished turns gray with a green ✓ and a "Done — …" label. Click it anytime to
  change your decision.

**You're finished with Triage** when the queue header says **0 to do**.

---

## 7. Working with the page in view (the viewer)

Clicking a page thumbnail in Triage opens the **viewer**: the page on the left, the item and
its buttons on the right. It's often the fastest way to work through a batch.

- Zoom with **−** and **+**, or **Fit width**; drag the page to move around it.
- The right side shows the item, its buttons, and every field of that form, so you can compare.
- The top shows **"Item 2 of 5 · 4 remaining"**. Decide each item and the next one opens.
- When you've handled them all, you'll see **"All 5 items addressed"** with a summary (e.g.
  *"2 values entered · 3 confirmed missing"*), and you're taken back to Triage.
- **Back** on the first item, the **✕**, or **Esc** closes the viewer.

**Tip:** filter first (e.g. click **Missing required** and pick one form), then open the
viewer to blitz through just those items.

---

## 8. All Forms: look things up

**All Forms** is read-only: a reference view of the whole packet, form by form.

- Pick a form on the left. You'll see its fields in a table, with the scanned pages beside it.
- Rows needing attention are tinted in their severity color and have **Review in triage →**,
  which takes you straight to that item.
- A banner tells you if one of the form's pages is missing.
- Nothing can be changed here. That keeps decisions in one place (Triage and the sweep).

The **Start verification sweep** card at the top is the way into Step 2.

---

## 9. Step 2 — The verification sweep

Triage covers what the AI flagged. The **sweep** is a final pass over **every** field,
including the ones the AI was confident about, one page at a time.

Open it with **Start verification sweep** (on All Forms or Review & Export). It fills the
screen:

- **Left:** the forms, with progress; the current form lists its pages.
- **Middle:** the scanned page at 100% (use −, +, **Fit width**, or drag to move).
- **Right:** every field on that page, in two groups:
  - **⚠ Needs attention** (orange box): anything flagged. Same buttons as Triage. Conflicts
    open with **Resolve conflict ▾**. When everything in it is handled, the header turns green:
    *"Needs attention — all handled."*
  - **✓ Looks good** (green box): confident readings. Click **✓ Verify** on each, or
    **Verify all** once you've checked them against the page.
- **Verify page** at the bottom:
  - If something still needs attention, it lists what's left so you can **Review them** (or
    **Verify page anyway**).
  - If everything's handled, confirm and the page gets a green ✓ in the sidebar.
- **Next →** moves to the next page. **Exit** (or **Esc**) leaves the sweep; your progress is
  saved.

---

## 10. Final step — Review & Export

**Review & Export** is the finish line. Work down the page:

1. **Triage status**: *"0 items left ✓"* or a list of what's still open (with **Go to item**).
2. **Sweep status**: *"Sweep complete: 146 of 146 ✓"* or a button to continue it.
3. **Awaiting client** (left) and **Client email** (right), side by side.
4. **Export reviewed JSON**.
5. **PrismHR payload preview**.
6. **Field checklist**: every field's final status, form by form.

### Sending the client email

The app writes the email for you from everything that needs the client:

- **MISSING ITEMS**: blank fields, missing forms and pages, unreadable values, wrong formats.
- **PLEASE CLARIFY**: anything you sent with "Add to email", e.g. *"Date on Form HC-5 reads
  'March 1/2', which is not a valid date. Please provide the correct date."*

Steps:

1. Read the draft and edit anything you like; your edits are kept.
2. Click **Save draft**. Everything in it moves to **Awaiting client**.
3. Send it from your own email: **Copy to clipboard** or **Open in email app**.
   (The app never sends email itself.)
4. Click **Mark as sent**. The dashboard now shows a blue banner: *"Client email sent Oct 8 —
   awaiting reply for N days · M items still awaiting client."*

**Client gone quiet?** In **Awaiting client**, click **Copy follow-up email** for a short nudge
listing only what's still outstanding.

### Exporting

- **Export reviewed JSON** downloads the packet's data with all your decisions applied (dates
  are in M/D/YYYY). You can export anytime; anything still open is marked as open.
- The **PrismHR payload preview** shows exactly what would be sent to PrismHR to create the
  employee: client 15650, job code, location, employee type, pay group, and so on, with a
  **Ready to import** or **Not ready** label and the list of what's blocking it.
  This is a demo: **nothing is actually sent to PrismHR.**

---

## 11. When the client replies

**They sent the missing information:**

1. In **Awaiting client**, click **Go to item** next to the field.
2. The value box is ready. Type what they sent and click **Save received value**.
   (For a conflict, pick the value they confirmed and click **Save selection**.)
3. It's marked received in the activity log. When nothing is left waiting, the dashboard
   banner turns green: **"All client items resolved."**

**They sent missing pages (a new scan):**

1. On the dashboard, click **+ Add pages to this packet** and choose the new PDF.
2. A blue banner shows *"Reading the added pages…"*. Only the new pages are read; nothing you
   already did is touched.
3. The page reloads with a message like *"Added page 9 — 2 fields new or changed, now in
   Triage."*
4. In Triage, check the items tagged **+ new page**: **Confirm value** or **Correct value**.

---

## 12. Activity: what happened, when

The **Activity** tab is a timeline of every decision on the packet, newest first: confirmed
values, edits (shown as *old → new*), values filled from other forms, items sent to the
client, emails saved and sent, replies received, and undos. Use it to answer "who changed
this, and what was it before?"

---

## 13. Keyboard shortcuts

| Where | Key | Does |
|---|---|---|
| Triage | ← / → | Previous / next item |
| Triage | Enter | The main button (or save what you typed) |
| Viewer | ← / → | Previous / next page of the item |
| Viewer, sweep, popups | Esc | Close |
| Sweep | Enter | The main button of the selected row (or save an edit) |
| Sweep | ← / → | Previous / next page |

---

## 14. Troubleshooting

| What you see | What to do |
|---|---|
| The browser can't reach 127.0.0.1:5050 | The app isn't running. Start it (section 2) and keep Terminal open. |
| "Address already in use" when starting | It's already running in another Terminal window. Use that one, or press Ctrl+C there first. |
| "Extraction failed: …" on the processing screen | Often the API key or connection. Run `python3 check_connection.py` and follow what it says. A damaged PDF also causes this; try re-scanning it. |
| `check_connection.py` says the key was rejected | Re-paste the full key into `api_key.txt` and save. |
| `check_connection.py` mentions certificates (SSL) | Run `pip3 install certifi`, then `export SSL_CERT_FILE="$(python3 -m certifi)"`, and try again. |
| "ModuleNotFoundError" when starting | Run `pip3 install -r requirements.txt`. |
| An error mentioning poppler or "pdftoppm" | Install poppler (section 1, step 2). |
| A value won't save | Read the red message under the box; the format needs fixing first. |
| I made a wrong decision | Click **Undo** in the pop-up message (5 seconds), or just open the item again and choose differently. |

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **Packet** | One employee's scanned set of new-hire forms (up to 9) |
| **Catalog** | The list of the 9 forms and every field the app knows how to read |
| **Triage** | Step 1: deciding every item the AI flagged |
| **Verification sweep** | Step 2: checking every field, page by page |
| **Conflict** | Two or more forms show different values for the same thing |
| **Majority** | The value most forms agree on (a hint, not the answer) |
| **Confidence** | How clearly the AI could read a value: high, medium, or low |
| **Scribble** | A crossed-out or unreadable value |
| **Partial form** | A form with a page missing from the scan |
| **Not applicable (n/a)** | A field or form that doesn't apply (e.g. pay period when paid hourly) |
| **Quick add** | Filling a blank from the same value on another form |
| **Awaiting client** | Items requested in the client email and not yet answered |
| **PrismHR payload** | The data that would create the employee in PrismHR (preview only) |

For the full technical detail of every feature and rule, see `docs/PRODUCT-REFERENCE.md`.

---

## 16. Edge cases: situations and mitigations

Every edge case the app handles today: the situation, an example, and what the app does about it.

### Upload and files

| Situation | Example | Mitigation |
|---|---|---|
| File isn't a PDF | A PNG photo | File signature checked in the browser and on the server; inline "That file isn't a PDF…" on the drop zone; Upload stays off; pick another file |
| Non-PDF renamed `.pdf` | `photo.png` → `packet.pdf` | Signature check, not the name: same error |
| No file chosen | Upload clicked empty | "Choose a PDF to upload." |
| Wrong document | An invoice PDF | Pages sorted first; fewer than 2 of the 9 forms → "Wrong document" screen with what each page looked like; no fields read; no packet created; files deleted |
| Corrupt PDF | Truncated download | Rendering fails → "Extraction failed: … Go back and try again." on the processing screen |
| Blank or unrelated pages inside a packet | A cover letter, a blank page | Kept as **unrecognized pages** with thumbnails; Triage item "Confirm page reviewed" |
| AI skips a page or a field | No label for page 4 | Page treated as unrecognized; field left blank with low confidence (never guessed) |
| AI refuses or the reply is cut off | Model stop | Job fails with the reason instead of saving partial data |
| API key missing or network down | No key / VPN | Job error with the cause; `check_connection.py` diagnoses key, network and SSL |

### Forms and pages

| Situation | Example | Mitigation |
|---|---|---|
| Required form missing | No Handbook page | Form "Missing"; Triage "Is this form missing from the scan?"; email asks the client to complete and sign it; PrismHR import blocked |
| Optional form absent | No Direct Deposit or HC-5 | "Not applicable" (gray); never missing |
| Page missing from a form | Agreement signature page | Detected when the form is short a required page **and** that page's fields are all blank → "Partial", banner, Triage item; email asks to resend that page |
| Fewer pages but nothing blank | Two pages scanned on one sheet | Not reported missing (cross-check passed) |
| Optional pages absent | I-9 document lists, HW-4 worksheets | Never make a form partial |
| "Missing" page is actually there | Misclassified page | **Page is actually there** → page cleared; its fields return to the queue for checking |
| Cover checklist | Present or not | Read but kept out of the review |
| Client sends missing pages later | A new scan of page 2 | **Add pages**: only new pages read; missing page cleared; form becomes present |

### Required, optional and conditional fields

| Situation | Example | Mitigation |
|---|---|---|
| Required field blank | Job Title | "missing" (red); Triage asks "Is this field blank?" |
| Optional field blank | Employee ID# | "blank" (gray); not counted, not in Triage or the email |
| Whitespace typed as a value | "   " | Trimmed: required → missing path; optional → saved blank |
| One-of requirement | Hourly or Salary | Satisfied by either; the other shows "not used"; both blank → one group item |
| Half-filled option | List B without List C | The missing half stays "missing" |
| Pay period with hourly pay | Hourly $30 | "n/a"; never missing |
| Pay period with salary | Salary given, no box | Required → missing item |
| HC-5 sub-boxes without box 3 | Box 3 empty | "n/a" |
| HC-5 box 3 with a sub-box | Sub-box b checked | Satisfied (sub-boxes read one by one; several allowed) |
| HC-5 box 3, no sub-box | Box 3 only | Missing item |
| HC-5 effective date | Box 5 checked, no date | Missing; otherwise "n/a" |
| I-9 USCIS number | Status box 1 vs box 4 | "n/a" unless box 4 is checked |
| I-9 List A vs List B + C | Passport (List A) | List A details required; B and C "not used" (and vice versa) |
| Document without an expiration | Social Security card | Expiration "optional: document has no expiration" |
| Direct deposit block | All blank / partly filled | All blank → "n/a"; any filled → the whole block required |
| Packet read before a rule change | Older job | Current catalog rules re-applied when it opens |

### Checkboxes

| Situation | Example | Mitigation |
|---|---|---|
| Any mark in a box | X, ✓, filled, partial mark | Counted as checked |
| AI says "no" in words | "unchecked", "No", "N/A", "☐" | Counted as empty |
| No box on a one-box choice | W-4 filing status blank | "Needs choice" item; email "no box is checked" |
| Two boxes on a one-box choice | Two filing statuses | "Needs choice", confidence lowered, both shown |
| Sub-boxes under a main box | HC-5 3a–3d | Each sub-box read on its own |

### Conflicts between values

| Situation | Example | Mitigation |
|---|---|---|
| Forms disagree, clear majority | Address 2 vs 1 | Conflict item naming the most common value, plus "the most common value isn't necessarily the correct one" |
| No majority | DOB 1 vs 1 | Every value shown as differing; check each against the scan |
| Same value written differently | "Sept 4, 85" vs "09/04/1985" | Normalized first: no conflict |
| Blank on one form | DOB blank on I-9 | Blanks never conflict (the blank is handled as missing) |
| SSN mismatch | …3452 vs …3425 | Critical conflict; blocks the PrismHR import |
| A different person's name | "Taylor Swift" vs "Travis Kelce" | Critical "name mismatch", listed first (possible mixed-up packet) |
| Nickname or name order | "Bron" vs "Lebron"; "Swift, Taylor" | Nicknames and "Last, First" recognized (nickname still shown as a warning) |
| Two dates on one form disagree | I-9 Section 1 vs Section 2 | "Signature dates" conflict |
| Misread vs real disagreement | "123A" vs "173A" | Shown side by side with the page; reviewer decides or asks the client |
| Reviewer can't tell | Either could be right | **Add to email** → "Please clarify" line with each form's value |

### Formats and values

| Situation | Example | Mitigation |
|---|---|---|
| Bad email | "lebron@" | "Not a valid email address." |
| Phone not 10 digits | "Ø", "808 853 962" | "Phone number must be 10 digits." |
| SSN not 9 digits | "98-331-345" | "SSN must be 9 digits." |
| ZIP wrong shape | "9670", "967011234" | "ZIP code must be 5 digits (optionally +4)." (ZIP+4 needs the dash) |
| Routing not 9 digits | "37138031" | "Routing number must be 9 digits." |
| Value on the wrong line | SSN in the phone box | "Looks like a Social Security Number… may have been written on the wrong line" |
| Value is fine but flagged | Unusual but correct | **Accept as-is** (logged with the reason) |

### Dates

| Situation | Example | Mitigation |
|---|---|---|
| Different date styles | "Mar 1 2026", "3-1-26", "2026-03-01" | All stored and shown as **3/1/2026** (what was written is kept) |
| Two-digit year | "1/5/49" / "1/5/50" | 2049 / 1950 (00–49 → 2000s, 50–99 → 1900s) |
| Not a real date | "March 1/2", "2/30/2026" | Kept as written and flagged invalid; typing one shows an error and blocks Save |
| Date typed by the reviewer | "January 5 2026" | Saved as 1/5/2026; the message confirms "Saved as 1/5/2026" |
| Date of birth in the future | 1/1/2030 | Flagged invalid |
| Start date before date of birth | 3/15/1980 | Flagged invalid |
| "N/A" on an expiration date | "N/A" | Accepted (not flagged) |

### Readability and confidence

| Situation | Example | Mitigation |
|---|---|---|
| Scribbled or crossed out | Overwritten SSN | Value cleared (never guessed), flagged; **Enter value** or **Mark unreadable** (→ email) |
| Crossed out with a clear correction | Corrected digit | The correction is read; not flagged |
| Barely legible | Faint writing | "Low confidence" item: Confirm or Correct |
| Some doubt | Cramped box | "Medium confidence": opt-in filter in Triage; listed in the sweep |

### Filling in and editing

| Situation | Example | Mitigation |
|---|---|---|
| Blank here, written on another form | Email only on the I-9 | **Quick add** card; fills it with a "filled from I-9" badge |
| Other forms disagree | Two different phones | No quick add (handled as a conflict) |
| Other form's value is invalid | Phone "Ø" elsewhere | Ignored for quick add |
| Invalid here, valid elsewhere | HC-5 phone "Ø", I-9 phone valid | Quick add offered |
| Typed value invalid | "lebron@" | Red message; Save disabled until fixed |
| Saved value later fails a check | Edited earlier | Reopened in Triage as invalid |
| Special characters | `<`, `&`, quotes | Saved as typed, shown safely |
| Extremely long value | Over 2,000 characters | Rejected by the server ("Saving failed") |
| Wrong decision | Wrong button | **Undo** for 5 seconds, or reopen the item any time |
| Not ready to decide | Unsure | **Skip**: stays open, moves after the others |

### Client email and replies

| Situation | Example | Mitigation |
|---|---|---|
| Things the client must supply | Blanks, missing pages, unreadable values | Collected into the draft automatically ("MISSING ITEMS") |
| Things to confirm | Conflicts, unclear values | "PLEASE CLARIFY" lines with the exact values |
| Reviewer edits the draft | Reworded text | Edits kept until **Reset** |
| Draft saved but not sent | — | Items show "draft saved, not yet sent" |
| Email sent | **Mark as sent** | Items stamped; dashboard banner with days waiting |
| Client is slow to answer | 5 days | Days counted; **Copy follow-up email** lists only what's still owed |
| Client answers | Sends a value | **Go to item** → **Save received value** → resolved and logged |
| Everything answered | — | Banner turns green: "All client items resolved." |
| More items after sending | New blanks found | Re-save the draft; new items "not yet sent"; Mark as sent again |

### Added pages

| Situation | Example | Mitigation |
|---|---|---|
| New pages fill blanks | Signature page arrives | Fields filled; tagged **+ new page** for a quick confirm |
| New pages change a value | Corrected address | New reading kept with the old value shown; reopens even if decided before |
| Same value as before | Re-sent page | No change |
| Unrelated page included | A note | Listed as an unrecognized page |
| Added twice at once | Second upload while reading | Refused: "Pages are already being added…" |
| Reading the new pages fails | Bad file | Error banner; packet unchanged |

### PrismHR codes and export

| Situation | Example | Mitigation |
|---|---|---|
| Job title matches no code | "Surf Coach" | Triage item listing IN / OW / RW → **Use this code** |
| Title corrected after picking | Fixed to "Retail Worker" | The written match wins |
| Blocking problems | Missing form, critical conflict | Payload shows "Not ready" with each blocker |
| Export before finishing | Items still open | Allowed; open items keep their flags in the file |
| Sensitive data on screen | SSN | Masked in the payload preview (•••-••-3452) |

### Known gaps (not handled yet)

| Situation | Workaround |
|---|---|
| Phone written with dots ("808.853.9621") is flagged at reading but accepted when typed | Accept as-is, or retype with dashes |
| "N/A" accepted on any date field, including date of birth | Check required dates in the sweep |
| SSN checked for 9 digits only (no area-number rule) | Compare against the I-9 documents |
| Uploads over 50 MB show a raw error page | Compress or split the scan |
| Unrecognized pages can't be assigned to a form | Use **Add pages** with a clean scan of that page |
| An optional form that is actually needed (e.g. direct deposit wanted) shows "not applicable" | Check the employee's choices; ask the client |
| Two reviewers on one packet at once | One reviewer per packet |
| Email saving/sending, Verify all, and Add pages can't be undone | Correct items individually |

Full detail on each rule: `docs/PRODUCT-REFERENCE.md`.
