"""
New Hire Packet extractor: scans a paper packet PDF, identifies which catalog
form each page is, and extracts that form's catalog fields with Claude vision.

Setup:
    pip install anthropic pdf2image pillow
    export ANTHROPIC_API_KEY="sk-ant-..."   # the key from Tiffany's case doc
Run:
    python extract.py sample_packets/new-hire-taylor.pdf
    (or call run_extraction(pdf_path, job_dir, progress_callback); app.py does)
Output:
    output/new-hire-taylor/extraction.json and output/new-hire-taylor/pages/page-NN.png
      pages               every page, the form it was identified as, and its image
                          (path relative to the extraction.json folder)
      unrecognized_pages  page number + thumbnail of every "unidentified" page
      forms               one entry per catalog form, in catalog order, with status
                          "present", "partial" (a required page is missing: see
                          "missing_pages"), "missing" (required form not found) or
                          "not_applicable" (conditional form not found)
      conflicts           values that disagree across (or within) forms
      validation_errors   impossible values and badly formatted values; a badly
                          formatted value that matches another field type (e.g. an
                          SSN on a date line) gets a "suspected_type"
    Each extracted field has a "confidence" (high/medium/low), the "page" it was
    read from, and its "location" on the paper (form, section, field). Problems are put in
    "flags" (all of them) and "flag" (the most serious one).

Two passes, then checks:
  1. Classify: all pages go to Claude in one request; each page is labeled with
     one catalog form name or "unidentified".
  2. Extract: for each identified form, that form's pages go to Claude with the
     form's catalog field list; values come back keyed by catalog field name.
  3. Check: checkbox choices, cross-form conflicts, impossible values, formats,
     and forms signed with required fields still empty.
"""
import base64, datetime, io, json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from anthropic import Anthropic
from pdf2image import convert_from_path

ROOT = Path(__file__).resolve().parent
KEY_FILE = ROOT / "api_key.txt"


def api_key() -> str | None:
    """The Anthropic API key from ANTHROPIC_API_KEY, else from api_key.txt. Any whitespace is
    removed: a real key has none, but one copied from a wrapped email line gets a line break."""
    for raw in (os.environ.get("ANTHROPIC_API_KEY", ""), KEY_FILE.read_text() if KEY_FILE.exists() else ""):
        key = "".join(raw.split())
        if key:
            return key
    return None
CATALOG = json.loads((ROOT / "data" / "form_catalog.json").read_text())["forms"]
FORM_NAMES = [f["form"] for f in CATALOG]
# Where each field is on the paper, e.g. "Form I-9, Section 2, List C table \u2014 Expiration Date row".
for _form in CATALOG:
    for _field in _form["fields"]:
        _field["location"] = f"{_form['short_name']}, {_field['section']} \u2014 {_field['label']}"
UNIDENTIFIED = "unidentified"
MODEL = "claude-sonnet-5-5"
CONFIDENCE_LEVELS = ["high", "medium", "low"]
SIGNED = "[signed]"

# Flags, most serious first; a field's "flag" is the most serious of its "flags".
SCRIBBLE_FLAG = "illegible_scribble"
CONFLICT_FLAG = "conflicting"
INVALID_VALUE_FLAG = "invalid_value"
INVALID_FORMAT_FLAG = "invalid_format"
AMBIGUOUS_FLAG = "ambiguous_choice"
NO_CHOICE_FLAG = "missing"
FLAG_PRIORITY = [SCRIBBLE_FLAG, CONFLICT_FLAG, INVALID_VALUE_FLAG, INVALID_FORMAT_FLAG, AMBIGUOUS_FLAG, NO_CHOICE_FLAG]

CLASSIFY_PROMPT = """You are sorting the pages of a scanned New Hire Packet.
Each page image above is preceded by its page number.

For every page, decide which ONE of these known forms it belongs to:
{form_list}

Rules:
- A page belongs to a form if it is part of that form: its first page, a
  continuation page, its instructions, worksheets, or reference lists.
- If a page does not clearly belong to any form in the list, label it
  "unidentified". Do not guess, and do not pick the closest match for a
  document that is not on the list.
- Use the form name exactly as written in the list.
- "seen": a few words on what the page actually is (e.g. "W-4 page 1",
  "invoice from a supply company", "blank page").
- Return one entry per page, for every page."""

EXTRACT_PROMPT = """The page image(s) above are the "{form}" form from a scanned
New Hire Packet; each image is preceded by its page number. Transcribe the
value of each of these fields:
{field_list}

Rules:
- Transcribe exactly what is written or typed. Use "" if the field is blank.
- Read each field from its own line or box. If a value seems to belong to a
  different field (e.g. a number written on the wrong line), still report it
  where it is written; never move it to the field you think it belongs to.
- Checkboxes / choices: return the label of the option(s) that are checked,
  or "" if none is checked. For a single checkbox field, return "checked" if
  the box is marked in any way (check mark, X, filled in) and "" if it's empty;
  never "unchecked", "no", or "false".
- Signature fields: return "[signed]" if a signature is present, else "".
- Do not invent or infer data that is not on the page.
- Return one entry per field listed, using the field name exactly as written.
- "page": the page number (as labeled above the image) where the field is.

Checked options: for a field listed with checkbox options, put the label of
EVERY checked box in "checked_options", using the option labels given (list
several if several boxes are checked, none if no box is checked). For all other
fields, return an empty "checked_options". Look at each box on its own, including
small indented sub-boxes (e.g. 3a-3d under a main box): a sub-box with any mark in
it is checked, even when the main box above it is also checked.

Confidence: rate each field by how legible its handwriting is on the page.
- "high": clearly readable.
- "medium": readable but with some doubt (faint writing, cramped boxes).
- "low": barely legible or partially obscured.
For a blank field, rate how sure you are that it is blank.

Scribbles: if scribbles, cross-outs, or overwritten characters make a field's
value unreadable, do NOT guess. Set "scribble" to true, "value" to "", and
"confidence" to "low". If a crossed-out entry has a clearly readable
correction, transcribe the correction and set "scribble" to false."""


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
def render_pages(pdf_path: Path) -> list:
    return [img.convert("RGB") for img in convert_from_path(str(pdf_path), dpi=150)]


def png_b64(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.standard_b64encode(buf.getvalue()).decode()


def thumbnail_data_uri(img, width: int = 360) -> str:
    thumb = img.copy()
    thumb.thumbnail((width, width * 2))
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.standard_b64encode(buf.getvalue()).decode()


def image_block(b64: str) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}}


def ask_json(client: Anthropic, content: list, schema: dict) -> dict:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        messages=[{"role": "user", "content": content}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"Model stopped with stop_reason={msg.stop_reason}")
    return json.loads(next(b.text for b in msg.content if b.type == "text"))


def classify_pages(client: Anthropic, pages: list[str]) -> list[str]:
    """Return a form name (or "unidentified") for each page, in page order."""
    return classify_pages_detailed(client, pages)[0]


def classify_pages_detailed(client: Anthropic, pages: list[str]) -> tuple[list[str], list[str]]:
    """(form name or "unidentified", a few words on what the page is) for each page, in page order."""
    content = []
    for i, b64 in enumerate(pages, start=1):
        content.append({"type": "text", "text": f"Page {i}:"})
        content.append(image_block(b64))
    form_list = "\n".join(f"- {name}" for name in FORM_NAMES)
    content.append({"type": "text", "text": CLASSIFY_PROMPT.format(form_list=form_list)})

    schema = {
        "type": "object",
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "page": {"type": "integer"},
                        "form": {"type": "string", "enum": FORM_NAMES + [UNIDENTIFIED]},
                        "seen": {"type": "string"},
                    },
                    "required": ["page", "form", "seen"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["pages"],
        "additionalProperties": False,
    }
    result = ask_json(client, content, schema)
    labels = {p["page"]: p["form"] for p in result["pages"]}
    seen = {p["page"]: p.get("seen", "") for p in result["pages"]}
    # Any page the model skipped is treated as unidentified rather than guessed.
    numbers = range(1, len(pages) + 1)
    return [labels.get(i, UNIDENTIFIED) for i in numbers], [seen.get(i, "") for i in numbers]


# The relevance check run before the full extraction: a new-hire packet shows at least this many
# of the catalog forms. Fewer means the wrong document was uploaded.
MIN_PACKET_FORMS = 2


class NotAPacket(Exception):
    """The upload isn't a new-hire packet. .pages = [{page, form, seen}] for the error screen."""
    def __init__(self, pages: list[dict]):
        super().__init__("This doesn't look like a new-hire packet.")
        self.pages = pages


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------
def extract_form(client: Anthropic, form: dict, page_numbers: list[int], page_images: list[str]) -> dict:
    field_names = [f["field"] for f in form["fields"]]
    content = []
    for number, b64 in zip(page_numbers, page_images):
        content.append({"type": "text", "text": f"Page {number}:"})
        content.append(image_block(b64))
    field_list = "\n".join(
        f"- {f['field']}" + (f"  [checkbox options: {' | '.join(f['options'])}]" if f.get("options") else "")
        for f in form["fields"]
    )
    content.append({"type": "text", "text": EXTRACT_PROMPT.format(form=form["form"], field_list=field_list)})

    schema = {
        "type": "object",
        "properties": {
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "field": {"type": "string", "enum": field_names},
                        "value": {"type": "string"},
                        "checked_options": {"type": "array", "items": {"type": "string"}},
                        "confidence": {"type": "string", "enum": CONFIDENCE_LEVELS},
                        "scribble": {"type": "boolean"},
                        "page": {"type": "integer"},
                    },
                    "required": ["field", "value", "checked_options", "confidence", "scribble", "page"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["fields"],
        "additionalProperties": False,
    }
    result = ask_json(client, content, schema)
    readings = {f["field"]: f for f in result["fields"]}
    fields = []
    for f in form["fields"]:
        entry = read_field(f, readings.get(f["field"]))
        page = readings.get(f["field"], {}).get("page")
        # The page the field was read from; fall back to the form's first page.
        entry["page"] = page if page in page_numbers else page_numbers[0]
        fields.append(entry)
    return {"form": form["form"], "status": "present", "pages": page_numbers, "fields": fields}


def read_field(catalog_field: dict, reading: dict | None) -> dict:
    """Catalog field + the model's reading of it -> output field object."""
    if reading is None:  # model skipped the field: nothing was read
        return field_entry(catalog_field, "", confidence="low")
    if reading["scribble"]:  # unreadable scribble: never keep a guessed value
        entry = field_entry(catalog_field, "", confidence="low")
        add_flag(entry, SCRIBBLE_FLAG)
        return entry
    entry = field_entry(catalog_field, reading["value"], confidence=reading["confidence"])
    if catalog_field.get("format") == "date":  # "Mar 1 2026" is stored as "3/1/2026"; what was written is kept
        canonical = canonical_date(reading["value"])
        if canonical and canonical != reading["value"].strip():
            entry["value"], entry["read_as"] = canonical, reading["value"]
    if catalog_field.get("checkbox"):  # a single checkbox is "checked" or blank, whatever words came back
        entry["value"] = normalize_checkbox(reading["value"])
    if catalog_field.get("options"):  # single-choice checkbox field: which boxes were checked
        checked = reading["checked_options"] or ([reading["value"]] if reading["value"].strip() else [])
        entry["checked"] = checked
        entry["value"] = "; ".join(checked)  # the checked boxes are the value
    return entry


UNCHECKED = {"", "unchecked", "not checked", "no", "false", "empty", "blank", "none", "n/a", "\u2610", "[ ]", "off"}


def normalize_checkbox(value: str) -> str:
    return "" if value.strip().lower() in UNCHECKED else "checked"


def has_pages(form: dict) -> bool:
    """The form was found in the packet (all its pages, or some: "partial")."""
    return form["status"] in ("present", "partial")


def detect_missing_pages(forms: list[dict]) -> None:
    """A found form is "partial" when it has fewer pages than its required catalog pages, and the
    fields mapped to a required page are all empty (cross-check: that page really isn't there).
    Records missing_pages by label and marks the fields on them page_missing."""
    catalog = {f["form"]: f for f in CATALOG}
    for form in forms:
        if form["status"] != "present":
            continue
        expected = [p for p in catalog[form["form"]].get("pages", []) if p.get("required", True)]
        shortfall = len(expected) - len(form.get("pages", []))
        if shortfall <= 0:
            continue
        empty_pages = []
        for p in expected:
            on_page = [f for f in form["fields"] if f.get("form_page") == p["page"]]
            if on_page and not any(has_value(f) for f in on_page):
                empty_pages.append((p, on_page))
        if not empty_pages:
            continue  # fewer pages, but every page's fields were read: nothing to report
        form["status"] = "partial"
        form["missing_pages"] = []
        for p, on_page in empty_pages[:shortfall]:
            form["missing_pages"].append({"page": p["page"], "label": p["label"], "fields": len(on_page)})
            for f in on_page:
                f["page_missing"] = True


def absent_form(form: dict) -> dict:
    """A catalog form with no pages: "not_applicable" if the form is conditional, else "missing"."""
    entry = {"form": form["form"], "status": "not_applicable" if form.get("conditional") else "missing"}
    if form.get("conditional"):
        entry["note"] = form["conditional"]
    entry["fields"] = [field_entry(f, "") for f in form["fields"]]
    return entry


# Requirement rules copied from the catalog when a field has them:
#   required_group:      the group as a whole is required, satisfied by any one option
#   group_option:        members sharing an option must all have values (e.g. List B + List C);
#                        a member without one is an option by itself
#   required_if:         required only when the named field in the same form has a value
#   required_if_matches: ...and that value matches this regex (case-insensitive)
#   required_if_label:   short description of the condition, for display
#   optional_if_matches: ...unless that value matches this regex, then the field is optional
#   optional_if_label:   short description of that exemption, for display
#   required_with:       required only when any of these other fields has a value (a block that's
#                        all-or-nothing, e.g. direct deposit block 1); required_with_label for display
#   single_choice:       a checkbox group where exactly one box should be checked
RULE_KEYS = ("required_group", "group_option", "required_if", "required_if_matches", "required_if_label",
             "optional_if_matches", "optional_if_label", "required_with", "required_with_label", "single_choice")


def field_entry(catalog_field: dict, value: str, confidence: str | None = None) -> dict:
    entry = {"field": catalog_field["field"], "value": value, "required": catalog_field["required"],
             "location": catalog_field["location"], "form_page": catalog_field.get("page", 1)}
    if "format" in catalog_field:
        entry["format"] = catalog_field["format"]
    entry.update({k: catalog_field[k] for k in RULE_KEYS if k in catalog_field})
    if confidence:  # only extracted fields have one; fields of an absent form don't
        entry["confidence"] = confidence
    return entry


def add_flag(entry: dict, flag: str, low_confidence: bool = False) -> None:
    flags = entry.setdefault("flags", [])
    if flag not in flags:
        flags.append(flag)
    entry["flag"] = min(flags, key=FLAG_PRIORITY.index)
    if low_confidence:
        entry["confidence"] = "low"


def has_value(entry: dict) -> bool:
    return bool(entry["value"].strip())


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
# The six progress steps reported to progress_callback, in order.
STEPS = ["Identifying forms", "Extracting fields", "Checking confidence",
         "Validating formats", "Detecting conflicts", "Building review"]


def run_extraction(pdf_path: Path, job_dir: Path, progress_callback=None, on_packet=None) -> dict:
    """Extract a packet into job_dir: extraction.json plus pages/page-NN.png.
    progress_callback(step_name) is called as each of STEPS begins.
    Page image paths in the JSON are relative to job_dir.
    Relevance check first: if fewer than MIN_PACKET_FORMS catalog forms are found on the pages,
    raises NotAPacket before any field extraction. on_packet() is called once the check passes."""
    step = progress_callback or (lambda name: None)
    job_dir = Path(job_dir)
    (job_dir / "pages").mkdir(parents=True, exist_ok=True)
    client = Anthropic(api_key=api_key())

    step("Identifying forms")
    images = render_pages(pdf_path)
    pages = [png_b64(img) for img in images]
    image_paths = []
    for i, img in enumerate(images, start=1):
        img.save(job_dir / "pages" / f"page-{i:02d}.png")
        image_paths.append(f"pages/page-{i:02d}.png")
    labels, seen = classify_pages_detailed(client, pages)
    found = [form for form in CATALOG if form["form"] in labels]  # catalog (packet) order
    if len(found) < MIN_PACKET_FORMS:  # the wrong document: stop before extracting anything
        raise NotAPacket([{"page": i, "form": label, "seen": s} for i, (label, s) in enumerate(zip(labels, seen), start=1)])
    if on_packet:
        on_packet()

    step("Extracting fields")

    def run(form):
        numbers = [i for i, label in enumerate(labels, start=1) if label == form["form"]]
        return extract_form(client, form, numbers, [pages[i - 1] for i in numbers])

    with ThreadPoolExecutor(max_workers=4) as pool:
        extracted = dict(zip((f["form"] for f in found), pool.map(run, found)))
    result = {
        "pages": [{"page": i, "form": label, "image": path}
                  for i, (label, path) in enumerate(zip(labels, image_paths), start=1)],
        # Never drop a page silently: every unidentified page is kept with a thumbnail.
        "unrecognized_pages": [
            {"page": i, "thumbnail": thumbnail_data_uri(img)}
            for i, (img, label) in enumerate(zip(images, labels), start=1) if label == UNIDENTIFIED
        ],
        "forms": [extracted.get(form["form"]) or absent_form(form) for form in CATALOG],
    }
    forms = result["forms"]
    detect_missing_pages(forms)

    step("Checking confidence")
    check_choices(forms)  # scribbles were already flagged while reading each field

    step("Validating formats")
    result["validation_errors"] = validate_values(forms)

    step("Detecting conflicts")
    result["conflicts"] = detect_conflicts(forms)

    step("Building review")
    mark_not_applicable(forms)
    check_signed_incomplete(forms)
    (job_dir / "extraction.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    return result


# ---------------------------------------------------------------------------
# Checkbox choices: exactly one box per single-choice group
# ---------------------------------------------------------------------------
def check_choices(forms: list[dict]) -> None:
    for form in forms:
        if not has_pages(form):
            continue
        fields = form["fields"]
        # One field holding the whole group (I-9 citizenship status, W-4 filing status).
        for f in fields:
            if f.get("single_choice") and not f.get("required_group"):
                if (f.get("required_if") or f.get("required_with")) and _condition_state(f, fields) == "na":
                    continue  # its condition isn't met: not applicable, never "no box checked"
                checked = f.get("checked", [f["value"]] if has_value(f) else [])
                if not checked:
                    add_flag(f, NO_CHOICE_FLAG)
                elif len(checked) > 1:
                    f["value"] = "; ".join(checked)
                    add_flag(f, AMBIGUOUS_FLAG, low_confidence=True)
        # One field per box (HC-5 coverage boxes 1-5).
        groups = {f["required_group"] for f in fields if f.get("single_choice") and f.get("required_group")}
        for group in groups:
            boxes = [f for f in fields if f.get("required_group") == group]
            checked = [f for f in boxes if has_value(f)]
            if not checked:
                for f in boxes:
                    add_flag(f, NO_CHOICE_FLAG)
            elif len(checked) > 1:
                names = [f["field"] for f in checked]
                for f in checked:
                    f["checked"] = names
                    add_flag(f, AMBIGUOUS_FLAG, low_confidence=True)


# ---------------------------------------------------------------------------
# Conflict detection: the same logical value, read from several places.
# Each source is (form, [catalog fields]); multi-field sources are joined with
# spaces (e.g. first + middle initial + last). A form may list several sources
# for one logical value; they are then also checked against each other.
# ---------------------------------------------------------------------------
EMP = "Employment Form (ProService)"
AGR = "Employment Agreement"
I9 = "Form I-9 — Employment Eligibility Verification"
W4 = "Form W-4 — Employee's Withholding Certificate"
HW4 = "Form HW-4 — Employee's Withholding Allowance and Status Certificate"
DD = "Authorization for Direct Deposit & Electronic Pay Statements"
HB = "Acknowledgment of Employee Handbook"
HC5 = "Form HC-5 — Employee Notification to Employer (Hawaii DOL)"

CROSS_CHECKS = [
    {"field": "Address", "kind": "text", "sources": [
        (EMP, ["Residence Address (Including Room/Apt #)"]),
        (W4, ["Address (Step 1a)"]),
        (I9, ["Address (Street Number and Name)", "Apt. Number (if any)"]),
        (HW4, ["Home address — number and street or rural route (Section A, line 3)"]),
    ]},
    {"field": "Name", "kind": "name", "sources": [
        (EMP, ["Name: First", "Name: Middle Initial", "Name: Last"]),
        (AGR, ["Employee name (You)"]),
        (I9, ["First Name (Given Name)", "Middle Initial (if any)", "Last Name (Family Name)"]),
        (W4, ["First name and middle initial (Step 1a)", "Last name (Step 1a)"]),
        (HW4, ["Type or print your full name (Section A, line 1)"]),
        (DD, ["Employee Name — First", "Employee Name — MI", "Employee Name — Last"]),
        (HB, ["Print Name"]),
        (HC5, ["Print employee name"]),
    ]},
    {"field": "Date of birth", "kind": "date", "sources": [
        (EMP, ["Date of Birth"]),
        (I9, ["Date of Birth (mm/dd/yyyy)"]),
    ]},
    # An SSN mismatch blocks payroll and tax filing.
    {"field": "Social Security Number", "kind": "text", "severity": "critical", "sources": [
        (EMP, ["Social Security Number"]),
        (W4, ["Social security number (Step 1b)"]),
        (I9, ["U.S. Social Security Number"]),
        (HW4, ["Your social security number (Section A, line 2)"]),
    ]},
    {"field": "Start date", "kind": "date", "sources": [
        (EMP, ["Start Date with Company"]),
        (I9, ["First Day of Employment (mm/dd/yyyy)"]),
        (W4, ["First date of employment (Employers Only)"]),
    ]},
]

# The date written next to each signature. All signature dates on one form should match.
SIGNATURE_DATES = {
    EMP: ["Date (supervisor)"],
    AGR: ["Date"],
    I9: ["Today's Date (mm/dd/yyyy) — Section 1", "Today's Date (mm/dd/yyyy) — Section 2"],
    W4: ["Date (Step 5)"],
    HW4: ["Date (Section A)"],
    DD: ["Date"],
    HB: ["Date"],
    HC5: ["Date"],
}
CROSS_CHECKS += [
    {"field": f"Signature dates — {form}", "kind": "date", "sources": [(form, [name]) for name in names]}
    for form, names in SIGNATURE_DATES.items() if len(names) > 1
]
NICKNAME_FIELD = (EMP, "Other/Nicknames")

# Fail loudly if a catalog rename leaves a check pointing at nothing.
_CATALOG_FIELDS = {f["form"]: {x["field"] for x in f["fields"]} for f in CATALOG}
for _check in CROSS_CHECKS:
    for _form, _names in _check["sources"]:
        assert set(_names) <= _CATALOG_FIELDS[_form], f"{_check['field']}: unknown field in {_form}"
assert NICKNAME_FIELD[1] in _CATALOG_FIELDS[NICKNAME_FIELD[0]]

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def normalize_text(value: str) -> str:
    """Ignore case, spaces, and punctuation: "123 Main St." == "123 main st"."""
    return re.sub(r"[^0-9a-z]", "", value.lower())


def normalize_name(value: str) -> str:
    """Name words in any order, without middle initials: "Swift, Taylor A." == "taylor swift"."""
    words = re.sub(r"[^0-9a-z ]", " ", value.lower()).split()
    return " ".join(sorted(w for w in words if len(w) > 1))


# Two-digit years: 00-49 are 2000s, 50-99 are 1900s ("3-1-26" is 2026, "Sept 4, 85" is 1985).
TWO_DIGIT_PIVOT = 50


def parse_date(value: str) -> datetime.date | None:
    """Parse m/d/y (2- or 4-digit year), y-m-d, or "Mon d, y" / "Month d y"; None if it isn't a
    calendar date. Never guesses: "March 1/2" (no year) is None."""
    t = value.strip().lower()
    m = re.fullmatch(r"(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})", t)
    iso = re.fullmatch(r"(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})", t)
    if m:
        month, day, year = int(m[1]), int(m[2]), m[3]
    elif iso:
        year, month, day = iso[1], int(iso[2]), int(iso[3])
    else:
        m = re.fullmatch(r"([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[,/ ]\s*(\d{2}|\d{4})", t)
        if not m or m[1][:3] not in MONTHS:
            return None
        month, day, year = MONTHS[m[1][:3]], int(m[2]), m[3]
    if len(year) == 2:
        yy = int(year)
        year = str(2000 + yy if yy < TWO_DIGIT_PIVOT else 1900 + yy)
    try:
        return datetime.date(int(year), month, day)
    except ValueError:
        return None


def canonical_date(value: str) -> str | None:
    """The canonical way dates are stored and shown: M/D/YYYY, no leading zeros ("3/1/2026").
    None if the value isn't a date (it then stays as written, and validation flags it)."""
    parsed = parse_date(value)
    return f"{parsed.month}/{parsed.day}/{parsed.year}" if parsed else None


def normalize_date(value: str) -> str:
    parsed = parse_date(value)
    return parsed.isoformat() if parsed else normalize_text(value)


NORMALIZERS = {"text": normalize_text, "name": normalize_name, "date": normalize_date}

# Common short forms of first names; a nickname is not a different person.
NICKNAMES = [
    {"robert", "rob", "bob", "bobby"}, {"william", "will", "bill", "billy"}, {"james", "jim", "jimmy", "jamie"},
    {"michael", "mike", "mikey"}, {"elizabeth", "liz", "beth", "betty", "eliza"}, {"richard", "rick", "dick"},
    {"margaret", "maggie", "meg", "peggy"}, {"katherine", "catherine", "kate", "katie", "kathy", "cathy"},
    {"joseph", "joe", "joey"}, {"thomas", "tom", "tommy"}, {"charles", "charlie", "chuck"},
    {"edward", "ed", "eddie", "ted"}, {"jonathan", "john", "jon", "johnny"}, {"anthony", "tony"},
    {"lebron", "bron"},
]


def name_parts(raw: str) -> tuple[str, str]:
    """(first, last) of a written name; "Last, First" order is recognized by the comma."""
    if "," in raw:
        last, _, first = raw.partition(",")
        raw = f"{first} {last}"
    words = [w for w in re.sub(r"[^a-z ]", " ", raw.lower()).split() if len(w) > 1]
    return (words[0], words[-1]) if words else ("", "")


def same_first_name(a: str, b: str, nicknames: set[str]) -> bool:
    if a == b or a.startswith(b) or b.startswith(a):  # "Tay" / "Taylor"
        return True
    if a in nicknames or b in nicknames:  # the employee's own listed nicknames
        return True
    return any(a in group and b in group for group in NICKNAMES)


def name_is_material_mismatch(raws: list[str], nicknames: set[str]) -> bool:
    """True if any two readings have a different last name, or first names that aren't
    the same name, a prefix, or a known nickname (middle initials are already ignored)."""
    parts = [name_parts(r) for r in raws]
    return any(
        a_last != b_last or not same_first_name(a_first, b_first, nicknames)
        for i, (a_first, a_last) in enumerate(parts) for (b_first, b_last) in parts[i + 1:]
    )


def detect_conflicts(forms: list[dict]) -> list[dict]:
    """Flag every field involved in a disagreement and return the conflicts list.
    Blank (and scribbled-out) values are skipped: they can't disagree."""
    by_form = {f["form"]: {x["field"]: x for x in f["fields"]} for f in forms if has_pages(f)}
    nickname_field = by_form.get(NICKNAME_FIELD[0], {}).get(NICKNAME_FIELD[1])
    nicknames = set(re.sub(r"[^a-z ]", " ", nickname_field["value"].lower()).split()) if nickname_field else set()
    conflicts = []
    for check in CROSS_CHECKS:
        normalize = NORMALIZERS[check["kind"]]
        readings = []  # (label, raw value, normalized value, field objects)
        per_form = {}
        for form, names in check["sources"]:
            per_form[form] = per_form.get(form, 0) + 1
        for form, names in check["sources"]:
            fields = [by_form[form][n] for n in names] if form in by_form else []
            raw = " ".join(x["value"].strip() for x in fields if x["value"].strip())
            if not raw:
                continue
            # Key by form name; add the field name only when one form has several readings.
            label = form if per_form[form] == 1 else f"{form} — {names[0]}"
            readings.append((label, raw, normalize(raw), [x for x in fields if x["value"].strip()]))
        if len({r[2] for r in readings}) < 2:
            continue
        for _, _, _, fields in readings:
            for x in fields:
                add_flag(x, CONFLICT_FLAG, low_confidence=True)
        # The odd ones out: readings outside the single largest group of agreeing values.
        # With no clear majority (e.g. 1 vs 1, 2 vs 2) every reading is "differs".
        groups = {}
        for label, raw, norm, _ in readings:
            groups.setdefault(norm, []).append((label, raw))
        sizes = sorted((len(g) for g in groups.values()), reverse=True)
        majority = max(groups.values(), key=len) if sizes[0] > sizes[1] else None
        majority_labels = {label for label, _ in majority} if majority else set()
        conflict = {"field": check["field"], "values": {label: raw for label, raw, _, _ in readings},
                    "fields": {label: [x["field"] for x in fields] for label, _, _, fields in readings},
                    "majority": majority[0][1] if majority else None,
                    "differs": [label for label, _, _, _ in readings if label not in majority_labels],
                    "severity": check.get("severity", "warning")}
        # A different first or last name may mean another employee's form got mixed in.
        if check["kind"] == "name" and name_is_material_mismatch([r[1] for r in readings], nicknames):
            conflict.update(type="name_mismatch", severity="critical")
        conflicts.append(conflict)
    # Name mismatches first, then other critical conflicts, then the rest.
    conflicts.sort(key=lambda c: (c.get("type") != "name_mismatch", c["severity"] != "critical"))
    return conflicts


# ---------------------------------------------------------------------------
# Value checks: impossible dates and field formats (formats come from the catalog)
# ---------------------------------------------------------------------------
FORMAT_OF = {(form["form"], f["field"]): f["format"] for form in CATALOG for f in form["fields"] if "format" in f}
DOB_FIELDS = {(form, n) for c in CROSS_CHECKS if c["field"] == "Date of birth" for form, names in c["sources"] for n in names}
START_FIELDS = {(form, n) for c in CROSS_CHECKS if c["field"] == "Start date" for form, names in c["sources"] for n in names}
NO_DATE = re.compile(r"(n\s*/?\s*a|none|-+)", re.I)  # e.g. an expiration date written as "N/A"

FORMAT_RULES = {  # format -> (check on the value, reason)
    "ssn": (lambda d: re.fullmatch(r"\d{9}", d) is not None, "SSN must be 9 digits."),
    "phone": (lambda d: re.fullmatch(r"\d{10}", d) is not None, "Phone number must be 10 digits."),
    "zip": (lambda d: re.fullmatch(r"\d{5}(\d{4})?", d) is not None, "ZIP code must be 5 digits (optionally +4)."),
    "routing": (lambda d: re.fullmatch(r"\d{9}", d) is not None, "Routing number must be 9 digits."),
}
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}")


def format_ok(fmt: str, value: str) -> tuple[bool, str]:
    if fmt == "email":
        return EMAIL.fullmatch(value.strip()) is not None, "Not a valid email address."
    check, reason = FORMAT_RULES[fmt]
    if fmt == "zip" and not re.fullmatch(r"\s*\d{5}(\s*-\s*\d{4})?\s*", value):
        return False, reason  # only "XXXXX" or "XXXXX-XXXX"
    return check(re.sub(r"[\s()\-]", "", value)), reason


# What a value that failed its own format looks like instead, tested in this order.
# A bare 9-digit number is read as an SSN before a ZIP+4 (which is usually written with a dash).
TYPE_NAMES = {"ssn": "a Social Security Number", "phone": "a phone number", "zip": "a ZIP code",
              "date": "a date", "email": "an email address", "routing": "a routing number"}


def _digits_only(value: str) -> str | None:
    return re.sub(r"[\s()\-]", "", value) if re.fullmatch(r"[\d\s()\-]+", value.strip()) else None


TYPE_TESTS = [
    ("email", lambda v: EMAIL.fullmatch(v.strip()) is not None),
    ("date", lambda v: parse_date(v) is not None),
    ("ssn", lambda v: len(_digits_only(v) or "") == 9),
    ("phone", lambda v: len(_digits_only(v) or "") == 10),
    ("zip", lambda v: re.fullmatch(r"\s*\d{5}(\s*-\s*\d{4})?\s*", v) is not None),
]


def suspected_type(value: str, own_format: str) -> str | None:
    """The other field type a misformatted value matches, e.g. an SSN written on a date line."""
    return next((name for name, test in TYPE_TESTS if name != own_format and test(value)), None)


def validate_values(forms: list[dict]) -> list[dict]:
    errors = []

    def fail(form, f, flag, reason, fmt=None):
        add_flag(f, flag, low_confidence=True)
        # A format failure may be a value written on the wrong line: name what it looks like.
        guess = suspected_type(f["value"], fmt) if fmt else None
        if guess:
            reason = (f"Value looks like {TYPE_NAMES[guess]}, not {TYPE_NAMES[fmt]} \u2014 "
                      "it may have been written on the wrong line.")
        errors.append({"field": f["field"], "form": form["form"], "value": f["value"], "reason": reason,
                       "suspected_type": guess})

    present = [form for form in forms if has_pages(form)]
    today = datetime.date.today()
    dobs = [(form["form"], f, parse_date(f["value"])) for form in present for f in form["fields"]
            if (form["form"], f["field"]) in DOB_FIELDS and has_value(f)]
    for form in present:
        for f in form["fields"]:
            fmt = FORMAT_OF.get((form["form"], f["field"]))
            if not fmt or not has_value(f):
                continue
            if fmt != "date":
                ok, reason = format_ok(fmt, f["value"])
                if not ok:
                    fail(form, f, INVALID_FORMAT_FLAG, reason, fmt)
                continue
            if NO_DATE.fullmatch(f["value"].strip()):
                continue
            parsed = parse_date(f["value"])
            if parsed is None:
                fail(form, f, INVALID_VALUE_FLAG, "Not a parseable calendar date.", "date")
            elif (form["form"], f["field"]) in DOB_FIELDS and parsed > today:
                fail(form, f, INVALID_VALUE_FLAG, "Date of birth is in the future.")
            elif (form["form"], f["field"]) in START_FIELDS:
                for dob_form, dob_field, dob in dobs:
                    if dob and parsed < dob:
                        fail(form, f, INVALID_VALUE_FLAG,
                             f"Start date is before the date of birth ({dob_field['value']} on {dob_form}).")
    return errors


# ---------------------------------------------------------------------------
# Signed but incomplete: same requirement rules as review.html
# ---------------------------------------------------------------------------
def _option_of(f: dict) -> str:
    return f.get("group_option") or f["field"]


def _condition_state(f: dict, fields: list[dict]) -> str:
    if f.get("required_with"):  # required once any of the block's other fields is filled in
        return "required" if any(has_value(x) for x in fields if x["field"] in f["required_with"]) else "na"
    trigger = next((x for x in fields if x["field"] == f["required_if"]), None)
    if not trigger or not has_value(trigger):
        return "na"
    if f.get("required_if_matches") and not re.search(f["required_if_matches"], trigger["value"], re.I):
        return "na"
    if f.get("optional_if_matches") and re.search(f["optional_if_matches"], trigger["value"], re.I):
        return "optional"
    return "required"


def empty_required_count(fields: list[dict]) -> int:
    """Number of required items not satisfied (a group or a triggered condition counts once)."""
    missing, groups = 0, {}
    for f in fields:
        if f.get("required_group"):
            options = groups.setdefault(f["required_group"], {})
            options[_option_of(f)] = options.get(_option_of(f), True) and has_value(f)
        elif f.get("required_if") or f.get("required_with"):
            missing += _condition_state(f, fields) == "required" and not has_value(f)
        elif f["required"]:
            missing += not has_value(f)
    return missing + sum(not any(options.values()) for options in groups.values())


def mark_not_applicable(forms: list[dict]) -> None:
    """A field can only be missing when it was required and left blank. A conditional field whose
    condition isn't met (pay period with hourly pay, HC-5 3a-3d without box 3, the I-9 USCIS number
    without status box 4, List A fields when List B + C were used, direct deposit block 1 when
    nothing in it is filled in) is "not_applicable": no missing flag."""
    for form in forms:
        if not has_pages(form):
            continue
        for f in form["fields"]:
            if (f.get("required_if") or f.get("required_with")) and _condition_state(f, form["fields"]) == "na" and not has_value(f):
                f["not_applicable"] = True
                if NO_CHOICE_FLAG in f.get("flags", []):
                    f["flags"].remove(NO_CHOICE_FLAG)
                    if f["flags"]:
                        f["flag"] = min(f["flags"], key=FLAG_PRIORITY.index)
                    else:
                        del f["flags"], f["flag"]


def check_signed_incomplete(forms: list[dict]) -> None:
    for form in forms:
        if not has_pages(form) or not any(f["value"] == SIGNED for f in form["fields"]):
            continue
        empty = empty_required_count(form["fields"])
        if empty:
            form["status_detail"] = {"signed_incomplete": True, "empty_required": empty}


# ---------------------------------------------------------------------------
# Supplementary scans: pages added to a packet after its first extraction
# ---------------------------------------------------------------------------
RECHECK_FLAGS = (CONFLICT_FLAG, INVALID_VALUE_FLAG, INVALID_FORMAT_FLAG, AMBIGUOUS_FLAG, NO_CHOICE_FLAG)


def add_pages(pdf_path: Path, job_dir: Path) -> dict:
    """Extract ONLY the pages of a supplementary scan and merge them into job_dir/extraction.json.
    The original pages are never re-read. The new pages are numbered after the existing ones; a
    field the new pages fill in or change takes the new reading and records "supplement"
    ({added, previous, page}) so the review page can route it to Triage. Packet-level checks
    (choices, formats, conflicts, missing pages) are re-run on the merged result.
    Returns {"added", "pages", "changed": [{form, field, previous, value}]}."""
    job_dir = Path(job_dir)
    path = job_dir / "extraction.json"
    result = json.loads(path.read_text())
    client = Anthropic(api_key=api_key())
    added = datetime.datetime.now().isoformat(timespec="seconds")

    images = render_pages(pdf_path)
    b64 = [png_b64(img) for img in images]
    start = max([p["page"] for p in result["pages"]] or [0])
    numbers = list(range(start + 1, start + 1 + len(images)))
    labels = classify_pages(client, b64)  # labels for the new pages only
    for n, label, img in zip(numbers, labels, images):
        img.save(job_dir / "pages" / f"page-{n:02d}.png")
        result["pages"].append({"page": n, "form": label, "image": f"pages/page-{n:02d}.png", "added": added})
        if label == UNIDENTIFIED:
            result.setdefault("unrecognized_pages", []).append({"page": n, "thumbnail": thumbnail_data_uri(img), "added": added})

    forms = result["forms"]
    changed = []
    for catalog_form in CATALOG:
        nums = [n for n, label in zip(numbers, labels) if label == catalog_form["form"]]
        if not nums:
            continue
        new = extract_form(client, catalog_form, nums, [b64[n - start - 1] for n in nums])
        form = next(f for f in forms if f["form"] == catalog_form["form"])
        was_found = has_pages(form)
        form["pages"] = sorted(set(form.get("pages", [])) | set(nums))
        if not was_found:  # a form that wasn't in the packet: it's here now
            form["status"] = "present"
            form.pop("note", None)
        by_name = {f["field"]: i for i, f in enumerate(form["fields"])}
        for reading in new["fields"]:
            if not has_value(reading) and not reading.get("flags"):
                continue  # nothing for this field on the new pages
            i = by_name[reading["field"]]
            old = form["fields"][i]
            if has_value(old) and old["value"] == reading["value"]:
                continue
            reading["supplement"] = {"added": added, "previous": old["value"], "page": reading["page"]}
            form["fields"][i] = reading
            changed.append({"form": form["form"], "field": reading["field"], "previous": old["value"], "value": reading["value"]})
        # A missing page whose fields the new pages filled in is no longer missing.
        if form.get("missing_pages"):
            filled = {p["page"] for p in form["missing_pages"]
                      if any(has_value(f) for f in form["fields"] if f.get("form_page") == p["page"])}
            form["missing_pages"] = [p for p in form["missing_pages"] if p["page"] not in filled]
            for f in form["fields"]:
                if f.get("form_page") in filled:
                    f.pop("page_missing", None)
            if not form["missing_pages"]:
                form.pop("missing_pages")
                form["status"] = "present"

    # Re-run the packet-level checks on the merged forms (scribble flags came from reading).
    for form in forms:
        form.pop("status_detail", None)
        for f in form["fields"]:
            f.pop("not_applicable", None)
            if f.get("flags"):
                f["flags"] = [x for x in f["flags"] if x not in RECHECK_FLAGS]
                if f["flags"]:
                    f["flag"] = min(f["flags"], key=FLAG_PRIORITY.index)
                else:
                    del f["flags"], f["flag"]
    detect_missing_pages(forms)
    check_choices(forms)
    result["validation_errors"] = validate_values(forms)
    result["conflicts"] = detect_conflicts(forms)
    mark_not_applicable(forms)
    check_signed_incomplete(forms)
    result.setdefault("supplements", []).append({"added": added, "pages": numbers, "file": Path(pdf_path).name, "changed": len(changed)})
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    tmp.replace(path)
    return {"added": added, "pages": numbers, "changed": changed}


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract.py <packet.pdf>")
        sys.exit(1)
    pdf_path = Path(sys.argv[1])
    job_dir = ROOT / "output" / pdf_path.stem
    print(f"Processing {pdf_path.name}...")
    result = run_extraction(pdf_path, job_dir, lambda name: print(f"  {name}...", flush=True))
    print(f"Wrote {job_dir / 'extraction.json'}\n")
    print("Page -> form")
    for p in result["pages"]:
        print(f"  {p['page']:>3}  {p['form']}")


if __name__ == "__main__":
    main()
