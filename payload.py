"""
Stub: build a PrismHR importEmployees payload from an extraction JSON
(output/<packet>/extraction.json or jobs/<job_id>/extraction.json).

The case study gives no PrismHR credentials, so this produces the payload
that WOULD be POSTed to importEmployees, and prints it instead of sending.
Relevant API calls from the case doc: getClientCodes, importEmployees,
commitEmployees, updateW4, updateDirectDeposit.

Each payload value is read from a list of (form, field) sources, first
non-empty wins. PrismHR codes are mapped from the written values using
data/client_codes.json. Anything that should stop the import (a critical
conflict, a missing required form, an invalid or unreadable value the payload
uses, a value that maps to no code) is listed under "blockers", and
"ready_to_import" is false while any remain.

Run:
    python payload.py output/new-hire-taylor/extraction.json
"""
import json, re, sys
from pathlib import Path

from extract import EMP, I9, parse_date

ROOT = Path(__file__).resolve().parent
CODES = json.loads((ROOT / "data" / "client_codes.json").read_text())

# Payload value -> where to read it, in order of preference.
SOURCES = {
    "firstName": [(EMP, "Name: First"), (I9, "First Name (Given Name)")],
    "lastName": [(EMP, "Name: Last"), (I9, "Last Name (Family Name)")],
    "ssn": [(EMP, "Social Security Number"), (I9, "U.S. Social Security Number")],
    "email": [(EMP, "Email Address"), (I9, "Employee's Email Address")],
    "hireDate": [(EMP, "Start Date with Company"), (I9, "First Day of Employment (mm/dd/yyyy)")],
    "position": [(EMP, "Position Title"), (EMP, "Job Title")],
    "location": [(EMP, "Organization Level 2"), (EMP, "Organization Level 1")],
    "status": [(EMP, "Status (Full-Time/Part-Time/Relief)")],
}
# The case doc maps Casual *or Relief* to CA; the form prints "Relief".
EMPLOYEE_TYPE_ALIASES = {"relief": "CA"}


def squash(value: str) -> str:
    return re.sub(r"[^0-9a-z]", "", value.lower())


def read(extraction: dict, key: str) -> tuple[str, dict | None, str | None]:
    """(value, field object, form name) from the first source with a value."""
    by_form = {f["form"]: (f, {x["field"]: x for x in f["fields"]}) for f in extraction["forms"]
               if f["status"] in ("present", "partial")}
    for form, field in SOURCES[key]:
        if form in by_form and by_form[form][1][field]["value"].strip():
            entry = by_form[form][1][field]
            return entry["value"].strip(), entry, form
    return "", None, None


def match_code(value: str, codes: dict, aliases: dict | None = None) -> str | None:
    """Code whose description matches the written value (case, spaces, punctuation ignored)."""
    v = squash(value)
    for alias, code in (aliases or {}).items():
        if alias in v:
            return code
    return next((code for code, desc in codes.items() if squash(desc) == v), None)


def match_location(value: str) -> str | None:
    """"dept = beach" -> the "beach location" code: the description's first word appears in the value."""
    v = value.lower()
    return next((code for code, desc in CODES["location_codes"].items() if desc.split()[0] in v), None)


def format_ssn(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    return f"{digits[:3]}-{digits[3:5]}-{digits[5:]}" if len(digits) == 9 else value


def build_payload(extraction: dict, code_choices: dict | None = None) -> dict:
    """code_choices: codes the reviewer picked where the written value matched none
    ({"jobCode": "RW", "locationCode": "1", "employeeType": "FT"})."""
    code_choices = code_choices or {}
    blockers = []
    values, used = {}, []
    for key in SOURCES:
        value, entry, form = read(extraction, key)
        values[key] = value
        if entry:
            used.append((form, entry))

    # Fields the payload relies on must not be flagged as invalid, conflicting, or unreadable.
    for form, entry in used:
        for flag in entry.get("flags", []):
            if flag in ("invalid_value", "invalid_format", "conflicting", "illegible_scribble"):
                blockers.append(f'{entry["field"]} ({form}): flagged {flag} — value "{entry["value"]}"')
    for key in ("firstName", "lastName", "ssn", "hireDate"):
        if not values[key]:
            blockers.append(f"No value for {key}.")

    for c in extraction.get("conflicts", []):
        if c["severity"] == "critical":
            blockers.append(f'Critical conflict: {c["field"]} — ' + "; ".join(f"{k}: {v}" for k, v in c["values"].items()))
    for f in extraction["forms"]:
        if f["status"] == "missing":
            blockers.append(f'Required form missing: {f["form"]}')
        for page in f.get("missing_pages", []):
            blockers.append(f'Page missing: {f["form"]}, page {page["page"]} ({page["label"]})')

    # A written value that matches a code wins; the reviewer's pick only fills in where none matches.
    job_code = match_code(values["position"], CODES["job_codes"]) or code_choices.get("jobCode")
    location_code = match_location(values["location"]) or code_choices.get("locationCode")
    employee_type = match_code(values["status"], CODES["employee_types"], EMPLOYEE_TYPE_ALIASES) or code_choices.get("employeeType")
    for label, code, written in (("job code", job_code, values["position"]),
                                 ("location code", location_code, values["location"]),
                                 ("employee type", employee_type, values["status"])):
        if not code:
            blockers.append(f'No {label} matches "{written}".')

    hire = parse_date(values["hireDate"]) if values["hireDate"] else None
    if values["hireDate"] and not hire:
        blockers.append(f'Hire date "{values["hireDate"]}" is not a calendar date.')

    return {
        "api": "importEmployees",
        "client_id": CODES["client"]["client_id"],
        "employee": {
            "firstName": values["firstName"],
            "lastName": values["lastName"],
            "ssn": format_ssn(values["ssn"]),
            "email": values["email"],
            "hireDate": hire.isoformat() if hire else values["hireDate"],
            "jobCode": job_code,
            "benefitGroup": "OWNER" if job_code == "OW" else "PRIMARY",
            "locationCode": location_code,
            "employeeType": employee_type,
            "employeeStatus": "A",  # all new hires are Active
            "payGroup": CODES["client"]["pay_group_code"],
        },
        "ready_to_import": not blockers,
        "blockers": blockers,
        "note": "Demo payload only; no credentials provided for this exercise.",
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python payload.py output/<packet>/extraction.json")
        sys.exit(1)
    extraction = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(build_payload(extraction), indent=2, ensure_ascii=False))
