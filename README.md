# New Hire Packet Prototype — Setup & Run Guide

Prototype for the ProService APM case study: scan a paper New Hire Packet PDF,
identify each form in it, extract every catalog field with Claude vision,
check the values (completeness, formats, cross-form conflicts), review the
result in a browser, and build the PrismHR `importEmployees` payload.

## What to download/install

Steps 1–2 are only needed to keep developing the prototype with Claude Code; to run it, start at step 3.

1. **Node.js 18+** (for Claude Code) — from https://nodejs.org or:
   ```
   winget install OpenJS.NodeJS.LTS      # Windows
   brew install node                      # macOS
   ```
2. **Claude Code** (the AI coding tool Mikaela's team uses):
   ```
   npm install -g @anthropic-ai/claude-code
   ```
   Then in the project folder run `claude` and sign in.
3. **Python 3.10+** (already on most machines; check with `python3 --version`)
4. **poppler** (needed by pdf2image to read PDFs):
   - Windows: download https://github.com/oschwartz10612/poppler-windows/releases → unzip → add `bin` to PATH
   - macOS: `brew install poppler`
   - Ubuntu: `sudo apt install poppler-utils`
5. **Python packages:**
   ```
   pip install -r requirements.txt
   ```

## API key

The case email from Tiffany includes an Anthropic API key. The easiest way to
set it: paste it into `api_key.txt` in this folder and save. Line breaks or
spaces (e.g. from a key that wrapped in the email) are removed automatically.

Or set it for one terminal session (this takes priority over the file):
```
export ANTHROPIC_API_KEY="sk-ant-..."   # macOS/Linux
setx ANTHROPIC_API_KEY "sk-ant-..."     # Windows (new terminal after)
```

Check it works with `python3 check_connection.py`.

## Step-by-step run

1. `cd` into this folder.
2. Install deps: `pip install -r requirements.txt` (and poppler per above).
3. Set the API key (above).

### Web app (packet list → upload → processing → review)

4. Start it: `python app.py`, then open http://127.0.0.1:5050 (not port 5000:
   macOS uses that for AirPlay). The home screen lists packet reviews with their
   status; the rows marked "sample" are seeded examples (`data/demo_packets.json`).
5. Click **Upload new packet**, drop a packet PDF (try `sample_packets/new-hire-lebron.pdf`)
   and click **Upload and review**. The processing screen shows each step as it
   runs, then opens the packet's dashboard; "← All packets" goes back to the list.
6. After the client email: send the saved draft from your email app and click
   **Mark as sent** (the dashboard then shows how long the client has had it, and
   **Copy follow-up email** builds a nudge for what's still owed). When the client
   sends missing pages, **Add pages to this packet** on the dashboard extracts only
   the new pages and merges them in; fields they fill in or change go to Triage
   ("From added pages"), and every earlier decision and the email history stay.

Each upload is a job in `jobs/<job_id>/`: `packet.pdf`, `status.json`,
`extraction.json`, and `pages/page-NN.png`. Reviewer decisions are saved in
`decisions.json` (with an activity log), the saved client email in
`email_draft.json`, the status shown on the home screen in `summary.json`
(uploads are listed in `jobs/packets.json`), and "Export reviewed JSON" downloads the extraction with
the decisions applied.

### Command line

4. Extract one packet: `python extract.py sample_packets/new-hire-taylor.pdf`.
   This writes `output/new-hire-taylor/extraction.json` and the page images in
   `output/new-hire-taylor/pages/`, and prints which form each page was
   identified as (one Claude call to sort the pages, then one per form).
5. See the would-be import: `python payload.py output/new-hire-taylor/extraction.json`
   (prints the `importEmployees` payload; no credentials were provided, so it
   does not call PrismHR — say this in your demo).

## What `extract.py` does

1. **Sorts the pages.** All page images go to Claude in one request. Each page
   is labeled with one of the 9 forms in `data/form_catalog.json`, or
   "unidentified" if it isn't one of them. Unidentified pages are never
   dropped: they're kept with a thumbnail.
2. **Extracts each form.** For every form found, that form's pages go to Claude
   with the form's field list from the catalog. Each field comes back with:
   - the value as written (`""` if blank; `"[signed]"` for a signature),
   - a **confidence** of `high`, `medium`, or `low` (how legible it was),
   - for single-choice checkbox groups, which boxes were checked.

   A field made unreadable by scribbles or cross-outs is left empty and flagged
   `illegible_scribble`; the model is told never to guess.
3. **Checks the values** (no further Claude calls):
   - **Forms:** each catalog form is `present`, `missing` (a required form with
     no pages), or `not_applicable` (a conditional form, Direct Deposit or HC-5,
     with no pages).
   - **Checkboxes:** I-9 citizenship status, W-4 filing status, and HC-5
     coverage boxes must have exactly one box checked: none is flagged
     `missing`, more than one `ambiguous_choice`.
   - **Conflicts:** the same value read in several places must agree: address,
     name, date of birth, SSN, start date, and signature dates within one form.
     Case, spaces, and punctuation are ignored; names ignore word order and
     middle initials; dates are compared as dates. A different first or last
     name (not a nickname) is a critical `name_mismatch`; an SSN mismatch is
     also critical.
   - **Impossible values:** a date that isn't a calendar date, a date of birth
     in the future, a start date before the date of birth (`invalid_value`).
   - **Formats:** SSN (9 digits), phone (10 digits), ZIP (5 or 5+4), email,
     routing number (9 digits) (`invalid_format`). A value that fails its own
     format but matches another one is reported as possibly written on the
     wrong line.
   - **Signed but incomplete:** a form with a signature but empty required
     fields.

   Any flagged field gets confidence `low`.

## Output format (`extraction.json`)

| Key | What's in it |
|---|---|
| `pages` | Every page, the form it was identified as, and its saved image (`pages/page-NN.png`, relative to the `extraction.json` folder) |
| `unrecognized_pages` | Page number and thumbnail of each unidentified page |
| `forms` | All 9 catalog forms, in catalog order: `form`, `status`, optional `status_detail` (signed but incomplete) or `note` (why a form is not applicable), and `fields` |
| `conflicts` | Values that disagree: `field`, `values` (by form), `severity` (`critical` or `warning`), the most common value, and which forms differ from it |
| `validation_errors` | Impossible and badly formatted values: `field`, `form`, `value`, `reason`, and `suspected_type` (`ssn`, `phone`, `zip`, `date`, `email`, or null) when the value looks like a different kind of field, e.g. an SSN written on a date line |

Each field has `field`, `value`, `required`, `confidence`, the `page` it was read from, its
`location` on the paper (e.g. "Form I-9, Section 2, List C table — Expiration Date row"), and any
requirement rules from the catalog. Problems are in `flags` (all of them) and
`flag` (the most serious one). A conditional field whose condition isn't met (pay
period with hourly pay, HC-5 3a-3d without box 3, the I-9 USCIS number without
status box 4, List A fields when List B + C were used, direct deposit block 1 left
empty) has `not_applicable: true` and is never flagged missing: a field is only
missing when it was required and left blank.

## Using the app

See **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** for a step-by-step walkthrough (upload,
dashboard, Triage, the verification sweep, the client email, adding pages, export), and
**[docs/PRODUCT-REFERENCE.md](docs/PRODUCT-REFERENCE.md)** for every feature, rule, and edge case.

## Building the payload (`payload.py`)

Reads the extraction JSON and builds the `importEmployees` payload:
- Name, SSN, email, and hire date come from the Employment Form, falling back
  to the I-9 when blank.
- PrismHR codes are mapped from the written values using
  `data/client_codes.json`: job code from Position Title, location from
  Organization Level 2, employee type from Status (Relief → CA), benefit group
  OWNER for owners and PRIMARY otherwise, status always A.
- `ready_to_import` is false while any `blockers` remain: a critical conflict,
  a missing required form, a flagged value the payload uses, a value that maps
  to no code, or no name, SSN, or hire date.

## Changing forms and rules

`data/form_catalog.json` defines the 9 forms in packet order and every field
in appearance order. Besides `field` and `required`, a field can have:

| Key | Meaning |
|---|---|
| `required_group` | One of the group's fields is required, not each one (e.g. hourly or salary) |
| `group_option` | Group members that must be filled together (List B + List C) |
| `required_if` / `required_if_matches` | Required only when another field is filled (and matches a pattern) |
| `optional_if_matches` | ...but optional when that field matches this pattern (documents with no expiration) |
| `required_if_label`, `optional_if_label` | Short text for the review page badges |
| `required_with`, `required_with_label` | Required only once any of these other fields is filled in (an all-or-nothing block, e.g. direct deposit block 1) |
| `options` | The checkbox labels; the checked ones become the value (several allowed, e.g. HC-5 sub-boxes 3a-3d) |
| `single_choice` | With `options`: exactly one box should be checked |
| `checkbox` | A single checkbox: extracted as "checked" or blank, never "unchecked" / "no" |
| `format` | `date`, `ssn`, `phone`, `zip`, `email`, or `routing`, for the value checks |
| `section`, `label` | Where the field is on the paper, for the review page captions (each form also has a `short_name`) |

Each form also lists its `pages` (`page`, `label`, and `required: false` for
pages a packet may leave out, like reference lists and worksheets), and each
field has the `page` it sits on. A found form with fewer pages than its required
pages, where every field on a required page came back empty, is reported as
`partial` with `missing_pages`.

A form with `conditional` is reported as not applicable (rather than missing)
when it's absent. The cross-form conflict checks and signature dates are
listed in `extract.py` (`CROSS_CHECKS`, `SIGNATURE_DATES`); the script stops
with an error if a catalog rename leaves one pointing at a field that doesn't
exist.

## How to keep coding with Claude Code

From this folder, run `claude` and ask it to extend the prototype, e.g.:
- "Add OCR fallback with tesseract when the vision call fails"
- "Generate the missing-info email draft from the validation errors using the client's template"
- "Add the I-9 Supplements form to the catalog"

## Files

| File | Purpose |
|---|---|
| `app.py` | Flask web app: upload, processing screen, review page |
| `extract.py` | PDF → page images → Claude vision → checked JSON (`run_extraction`) |
| `templates/` | The web app's pages (upload, processing, review) |
| `static/review.js`, `static/review.css` | The review page renderer and styles |
| `payload.py` | Stub: builds the `importEmployees` payload and lists blockers (no live call) |
| `data/form_catalog.json` | The 9 forms, their fields, and the requirement and format rules |
| `data/client_codes.json` | Valid PrismHR codes for Jordan's Surf Shack (from the case doc) |
| `sample_packets/` | The two mock packets from Tiffany's email |
| `output/` | Command-line extraction results land here |
| `jobs/` | Web app uploads and their results land here |
