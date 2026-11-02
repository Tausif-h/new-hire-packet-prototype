"""
Packet Review web app: packet list, upload, processing, review, export.

Run:
    export ANTHROPIC_API_KEY="sk-ant-..."
    python app.py            # then open http://127.0.0.1:5050

Home (/) lists the packets: uploads registered in jobs/packets.json, plus the seeded example rows
in data/demo_packets.json. Each upload becomes a job in jobs/<job_id>/:
    packet.pdf        the uploaded PDF
    status.json       {"status": "running|done|error", "step", "done_steps", ...}
    extraction.json   written by extract.run_extraction
    pages/page-NN.png the rendered pages, shown as "View source" thumbnails
    decisions.json    the reviewer's decisions and an activity log
    email_draft.json  the last saved client email draft
    summary.json      the packet's status for the home screen, saved by the review page
    supplement-N.pdf  pages added later ("Add pages to this packet"); only these are extracted
"""
import datetime, json, re, threading, traceback, uuid
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, url_for
from werkzeug.utils import secure_filename

import shutil

from extract import CATALOG, RULE_KEYS, STEPS, NotAPacket, add_pages, canonical_date, run_extraction
from payload import CODES, SOURCES, build_payload

# Field formats from the catalog, for the review page's live checks (works for older jobs too).
FORMATS = {f["form"]: {x["field"]: x["format"] for x in f["fields"] if "format" in x} for f in CATALOG}
# Requirement rules from the catalog, so a rule fix applies to packets extracted before it too.
RULES = {f["form"]: {x["field"]: {k: x[k] for k in ("required", *RULE_KEYS) if k in x} for x in f["fields"]} for f in CATALOG}

ROOT = Path(__file__).resolve().parent
JOBS = ROOT / "jobs"
REGISTRY = JOBS / "packets.json"            # job ids shown on the home screen, newest last
DEMO_PACKETS = ROOT / "data" / "demo_packets.json"  # seeded example rows for the home screen
JOB_ID = re.compile(r"[0-9a-f]{32}")
PAGE_IMAGE = re.compile(r"page-\d{2,}\.png")

app = Flask(__name__)
NOT_A_PDF = "That file isn't a PDF. Please upload the new-hire packet as a PDF."


@app.context_processor
def upload_messages() -> dict:
    return {"not_a_pdf": NOT_A_PDF}
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB packets


def now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def job_path(job_id: str) -> Path:
    """The job's folder; 404 for anything that isn't an existing job id (no path tricks)."""
    if not JOB_ID.fullmatch(job_id) or not (JOBS / job_id).is_dir():
        abort(404)
    return JOBS / job_id


def read_status(job_dir: Path) -> dict:
    return json.loads((job_dir / "status.json").read_text())


def write_status(job_dir: Path, **updates) -> None:
    path = job_dir / "status.json"
    status = json.loads(path.read_text()) if path.exists() else {}
    status.update(updates)
    tmp = job_dir / "status.json.tmp"
    tmp.write_text(json.dumps(status, indent=2))
    tmp.replace(path)  # atomic, so a poll never reads a half-written file


# ---------------------------------------------------------------------------
# Review decisions: {"decisions": {item key: latest decision}, "activity": [entries, oldest first]}.
# A decision's "fields" lists the extracted fields it sets ({form, field, value}); the review page
# shows those as the reviewed values, and export applies them.
# ---------------------------------------------------------------------------
# accepted / edited resolve an item; confirmed_missing and unreadable mean the client must supply it
# (it goes in the email draft); clarify sends a conflict to the client to settle (also in the draft);
# skipped leaves it open; cleared undoes the item's decision.
# Saving the email draft marks its items status "requested" (awaiting client).
ACTIONS = {"accepted", "edited", "skipped", "confirmed_missing", "unreadable", "clarify", "cleared"}
decisions_lock = threading.Lock()


def read_decisions(job_dir: Path) -> dict:
    path = job_dir / "decisions.json"
    return json.loads(path.read_text()) if path.exists() else {"decisions": {}, "activity": []}


def clean_decision(body: dict) -> dict:
    """Validate a posted decision; 400 on anything malformed."""
    text = lambda v: v if isinstance(v, str) and len(v) <= 2000 else abort(400)
    if not isinstance(body, dict) or body.get("action") not in ACTIONS:
        abort(400)
    fields = body.get("fields") or []
    filled_from = body.get("filled_from") or []
    if not isinstance(fields, list) or len(fields) > 50 or not isinstance(filled_from, list) or len(filled_from) > 10:
        abort(400)
    return {
        "key": text(body.get("key")), "action": body["action"],
        "title": text(body.get("title", "")), "form": text(body.get("form", "")),
        "value": text(body.get("value", "")), "original": text(body.get("original", "")), "note": text(body.get("note", "")),
        "fields": [{"form": text(f.get("form")), "field": text(f.get("field")), "value": text(f.get("value", ""))}
                   for f in fields if isinstance(f, dict)],
        "time": now(),
        **({"filled_from": [text(x) for x in filled_from]} if filled_from else {}),  # cross-form quick-add
    }


@app.get("/api/decisions/<job_id>")
def get_decisions(job_id: str):
    return jsonify(read_decisions(job_path(job_id)))


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


def log(state: dict, decision: dict, action: str, **extra) -> None:
    """Append to the activity log (the Activity tab's timeline)."""
    entry = {**{k: decision.get(k, "") for k in ("time", "key", "title", "form", "original", "value", "note")}, "action": action, **extra}
    if decision.get("filled_from"):
        entry["filled_from"] = decision["filled_from"]
    state["activity"].append(entry)


@app.post("/api/decisions/<job_id>")
def post_decision(job_id: str):
    job_dir = job_path(job_id)
    decision = clean_decision(request.get_json(silent=True))
    with decisions_lock:
        state = read_decisions(job_dir)
        previous = state["decisions"].get(decision["key"])
        if decision["action"] == "cleared":  # Undo: back to how the item was before
            state["decisions"].pop(decision["key"], None)
            if previous:
                log(state, {**previous, "time": decision["time"]}, "undone", undid=previous["action"])
        else:
            if previous and previous.get("status") == "requested" and decision["action"] in ("accepted", "edited"):
                decision["received"] = True  # the client sent it after the email; now resolved
            state["decisions"][decision["key"]] = decision
            log(state, decision, "received" if decision.get("received") else decision["action"])
        write_json(job_dir / "decisions.json", state)
    return jsonify(state)


@app.post("/api/email/<job_id>")
def save_email(job_id: str):
    """Save the client email draft and mark every item in it "requested" (awaiting client).
    Nothing is sent."""
    job_dir = job_path(job_id)
    body = request.get_json(silent=True) or {}
    items = body.get("items") or []
    if not isinstance(items, list) or not all(isinstance(i, dict) and isinstance(i.get("key"), str) for i in items):
        abort(400)
    draft = {"subject": str(body.get("subject", ""))[:500], "body": str(body.get("body", ""))[:20000],
             "keys": [i["key"] for i in items], "saved": now()}
    with decisions_lock:
        state = read_decisions(job_dir)
        for i in items:
            # An item requested without an earlier decision keeps its own issue (missing, invalid, ...).
            decision = state["decisions"].get(i["key"]) or {
                "key": i["key"], "action": "requested", "title": str(i.get("title", "")), "form": str(i.get("form", "")),
                "value": "", "original": "", "fields": []}
            decision.update(status="requested", requested=draft["saved"], time=draft["saved"])
            state["decisions"][i["key"]] = decision
            log(state, decision, "requested", batch=draft["saved"])  # one email save = one batch
        write_json(job_dir / "decisions.json", state)
        write_json(job_dir / "email_draft.json", draft)
    return jsonify({**state, "emailDraft": draft})


@app.post("/api/email/<job_id>/sent")
def mark_email_sent(job_id: str):
    """The reviewer sent the saved draft (from their own email app): stamp the time on the draft and
    on every requested item in it that wasn't already sent."""
    job_dir = job_path(job_id)
    draft_path = job_dir / "email_draft.json"
    if not draft_path.exists():
        abort(400)
    draft = json.loads(draft_path.read_text())
    sent = now()
    with decisions_lock:
        state = read_decisions(job_dir)
        stamped = 0
        for key in draft.get("keys", []):
            d = state["decisions"].get(key)
            if d and d.get("status") == "requested" and not d.get("sent"):
                d["sent"] = sent
                stamped += 1
        draft["sent"] = sent
        log(state, {"time": sent, "key": "email", "title": draft.get("subject", "Client email"), "form": ""}, "email_sent", count=stamped)
        write_json(job_dir / "decisions.json", state)
        write_json(draft_path, draft)
    return jsonify({**state, "emailDraft": draft})


def reviewed_extraction(data: dict, decisions: dict) -> dict:
    """The extraction with the reviewer's decisions applied. Accepted / edited values replace what
    was read (flags cleared, the original kept); every reviewed field, conflict, form, and page gets a
    "review" record with its status; items still open or awaiting the client keep their flags."""
    out = json.loads(json.dumps(data))
    forms = {f["form"]: f for f in out["forms"]}
    is_date = lambda form, field: FORMATS.get(form, {}).get(field) == "date"
    for form in out["forms"]:  # dates in the canonical M/D/YYYY (packets read before that was the rule)
        for f in form["fields"]:
            canonical = is_date(form["form"], f["field"]) and canonical_date(f["value"])
            if canonical and canonical != f["value"]:
                f.setdefault("read_as", f["value"])
                f["value"] = canonical
    for c in out.get("conflicts", []):  # a date conflict's readings too
        if c.get("values") and all(canonical_date(v) for v in c["values"].values()):
            c["values"] = {k: canonical_date(v) for k, v in c["values"].items()}
            if c.get("majority"):
                c["majority"] = canonical_date(c["majority"]) or c["majority"]
    for d in decisions.values():
        status = ("awaiting_clarification" if d["action"] == "clarify"  # a conflict the client is asked to settle
                  else "requested" if d.get("status") == "requested"
                  else {"accepted": "verified", "edited": "adjusted", "confirmed_missing": "needs_client",
                        "unreadable": "unreadable", "skipped": "open"}.get(d["action"], d["action"]))
        record = {"status": status, "decided": d.get("time")}
        if d.get("requested"):
            record["requested"] = d["requested"]
        if d.get("received"):
            record["received"] = True  # the client's answer came in after the email
        targets = []
        kind, _, rest = d["key"].partition("::")
        if kind == "field":
            form, _, field = rest.partition("::")
            targets = [(form, field)]
        elif kind == "group":
            form, _, group = rest.partition("::")
            targets = [(form, f["field"]) for f in forms.get(form, {}).get("fields", []) if f.get("required_group") == group]
        elif kind == "conflict":
            for c in out.get("conflicts", []):
                if c["field"] == rest:
                    c["review"] = {**record, "value": canonical_date(d.get("value", "")) or d.get("value", "")}
        elif kind == "form" and rest in forms:
            forms[rest]["review"] = record
        elif kind == "page_missing":  # "<form>::<page>"
            form, _, page = rest.rpartition("::")
            for p in forms.get(form, {}).get("missing_pages", []):
                if str(p["page"]) == page:
                    p["review"] = {**record, "status": "page_present" if d["action"] == "accepted" else record["status"]}
        elif kind == "page":
            for pg in out.get("unrecognized_pages", []):
                if str(pg["page"]) == rest:
                    pg["review"] = record
        targets += [(o["form"], o["field"]) for o in d.get("fields", [])]
        overrides = {(o["form"], o["field"]): (is_date(o["form"], o["field"]) and canonical_date(o["value"])) or o["value"]
                     for o in d.get("fields", [])}
        for form, name in dict.fromkeys(targets):  # each field once (a field decision names it twice)
            f = next((x for x in forms.get(form, {}).get("fields", []) if x["field"] == name), None)
            if not f:
                continue
            rec = dict(record)
            if d.get("filled_from"):
                rec["status"], rec["filled_from"] = "cross_filled", d["filled_from"]
            if (form, name) in overrides and d["action"] in ("accepted", "edited"):
                rec["original"] = f["value"]
                if not d.get("filled_from"):
                    rec["status"] = "verified" if overrides[(form, name)] == f["value"] else "adjusted"
                f["value"] = overrides[(form, name)]
                if f.get("flags"):
                    rec["cleared_flags"] = f.pop("flags")
                    f.pop("flag", None)
            f["review"] = rec
    for f in out["forms"]:  # every "missing" page confirmed present: the form is complete after all
        if f.get("status") == "partial" and all(p.get("review", {}).get("status") == "page_present" for p in f.get("missing_pages", [])):
            f["status"] = "present"
    out["review"] = {"exported": now(), "decisions": len(decisions)}
    return out


@app.get("/api/export/<job_id>")
def export(job_id: str):
    job_dir = job_path(job_id)
    data = json.loads((job_dir / "extraction.json").read_text())
    reviewed = reviewed_extraction(data, read_decisions(job_dir)["decisions"])
    write_status(job_dir, exported=now())  # a packet ready to export becomes "Complete" on the home screen
    stem = Path(read_status(job_dir).get("filename", "packet.pdf")).stem
    response = jsonify(reviewed)
    response.headers["Content-Disposition"] = f'attachment; filename="reviewed-{secure_filename(stem) or "packet"}.json"'
    return response


def run_job(job_dir: Path) -> None:
    """Background thread: run the extraction, recording each step in status.json. The packet is
    listed on the home screen only once the relevance check says it is one."""
    def progress(step: str) -> None:
        write_status(job_dir, step=step, done_steps=STEPS[:STEPS.index(step)])

    def listed() -> None:
        with decisions_lock:
            write_json(REGISTRY, registered() + [job_dir.name])

    try:
        run_extraction(job_dir / "packet.pdf", job_dir, progress, on_packet=listed)
        write_status(job_dir, status="done", done_steps=STEPS, finished=now())
    except NotAPacket as exc:  # the wrong document: keep only what the error screen shows
        write_status(job_dir, status="rejected", detected=exc.pages, finished=now())
        (job_dir / "packet.pdf").unlink(missing_ok=True)
        shutil.rmtree(job_dir / "pages", ignore_errors=True)
    except Exception as exc:  # report any failure to the processing screen
        traceback.print_exc()
        message = f"{type(exc).__name__}: {exc}"
        # e.g. APIConnectionError just says "Connection error."; the cause (SSL, DNS, proxy) is the useful part.
        if exc.__cause__:
            message += f" Cause: {type(exc.__cause__).__name__}: {exc.__cause__}"
        write_status(job_dir, status="error", error=message, finished=now())


# ---------------------------------------------------------------------------
# Home: the packet list. Real packets are the uploads in the registry; their status comes from the
# summary the review page saves (summary.json). Demo rows are seeded examples.
# ---------------------------------------------------------------------------
EMP_FORM = "Employment Form (ProService)"


def employee_info(data: dict) -> tuple[str, str]:
    """(employee name, company) as written on the Employment Form."""
    form = next((f for f in data.get("forms", []) if f["form"] == EMP_FORM), None)
    fields = {x["field"]: x.get("value", "") for x in (form or {}).get("fields", [])}
    name = " ".join(v for v in (fields.get("Name: First", ""), fields.get("Name: Last", "")) if v).strip()
    return name.title() if name.isupper() else name, fields.get("Company", "")


def registered() -> list[str]:
    return json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []


def packet_row(job_id: str) -> dict | None:
    job_dir = JOBS / job_id
    if not (job_dir / "status.json").exists():
        return None
    status = read_status(job_dir)
    row = {"id": job_id, "employee": status.get("filename", "Packet"), "company": "", "pages": None,
           "processed": status.get("finished") or status.get("created"), "progress": 0, "detail": "",
           "url": url_for("review", job_id=job_id)}
    if status["status"] == "running":
        return {**row, "status": "Processing", "detail": status.get("step", ""), "url": url_for("processing", job_id=job_id)}
    if status["status"] == "error":
        return {**row, "status": "Failed", "detail": "extraction error", "url": url_for("processing", job_id=job_id)}
    data = json.loads((job_dir / "extraction.json").read_text())
    name, company = employee_info(data)
    row.update(employee=name or row["employee"], company=company, pages=len(data.get("pages", [])))
    summary = json.loads((job_dir / "summary.json").read_text()) if (job_dir / "summary.json").exists() else {}
    row.update(status=summary.get("status", "In triage"), detail=summary.get("detail", ""), progress=summary.get("progress", 0))
    if row["status"] == "Ready to export" and status.get("exported"):
        row.update(status="Complete", detail=f"exported {datetime.datetime.fromisoformat(status['exported']).strftime('%b %-d')}")
    return row


@app.get("/")
def home():
    rows = [r for r in map(packet_row, registered()) if r]
    demos = json.loads(DEMO_PACKETS.read_text()) if DEMO_PACKETS.exists() else []
    rows += [{**d, "demo": True, "url": url_for("demo_packet", demo_id=d["id"])} for d in demos]
    rows.sort(key=lambda r: r.get("processed") or "", reverse=True)
    for r in rows:
        r["processed_label"] = datetime.datetime.fromisoformat(r["processed"]).strftime("%b %-d, %Y · %-I:%M %p") if r.get("processed") else ""
    return render_template("home.html", rows=rows)


@app.get("/packets/demo/<demo_id>")
def demo_packet(demo_id: str):
    demos = json.loads(DEMO_PACKETS.read_text()) if DEMO_PACKETS.exists() else []
    demo = next((d for d in demos if d["id"] == demo_id), None) or abort(404)
    return render_template("demo.html", demo=demo, crumb=demo["employee"])


@app.post("/api/summary/<job_id>")
def save_summary(job_id: str):
    """The review page's packet status for the home screen: {status, detail, progress}."""
    job_dir = job_path(job_id)
    body = request.get_json(silent=True) or {}
    statuses = {"In triage", "In verification sweep", "Awaiting client", "Ready to export"}
    if body.get("status") not in statuses or not isinstance(body.get("progress"), (int, float)):
        abort(400)
    write_json(job_dir / "summary.json", {"status": body["status"], "detail": str(body.get("detail", ""))[:80],
                                          "progress": max(0, min(100, round(body["progress"])))})
    return jsonify(ok=True)


@app.get("/upload")
def upload_screen():
    return render_template("upload.html", crumb="Upload")


@app.post("/upload")
def upload():
    file = request.files.get("packet")
    if not file or not file.filename:
        return render_template("upload.html", crumb="Upload", error="Choose a PDF to upload."), 400
    if file.stream.read(5) != b"%PDF-":  # the file's signature, whatever its name says
        return render_template("upload.html", crumb="Upload", error=NOT_A_PDF), 400
    file.stream.seek(0)

    job_id = uuid.uuid4().hex
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True)
    file.save(job_dir / "packet.pdf")
    write_status(job_dir, status="running", step=STEPS[0], done_steps=[],
                 filename=secure_filename(file.filename) or "packet.pdf", created=now())
    threading.Thread(target=run_job, args=(job_dir,), daemon=True).start()
    return redirect(url_for("processing", job_id=job_id))


@app.get("/processing/<job_id>")
def processing(job_id: str):
    status = read_status(job_path(job_id))
    if status["status"] == "done":
        return redirect(url_for("review", job_id=job_id))
    if status["status"] == "rejected":
        return redirect(url_for("rejected", job_id=job_id))
    return render_template("processing.html", job_id=job_id, steps=STEPS, filename=status.get("filename", ""),
                           crumb=status.get("filename", "Processing"))


@app.get("/rejected/<job_id>")
def rejected(job_id: str):
    """The wrong-document screen: what the relevance check saw on each page."""
    status = read_status(job_path(job_id))
    if status["status"] != "rejected":
        return redirect(url_for("processing", job_id=job_id))
    return render_template("rejected.html", filename=status.get("filename", ""), detected=status.get("detected", []),
                           catalog_count=len(CATALOG), crumb="Upload")


@app.get("/api/status/<job_id>")
def api_status(job_id: str):
    status = read_status(job_path(job_id))
    body = {"step": status.get("step"), "done_steps": status.get("done_steps", []), "status": status["status"]}
    if status["status"] == "error":
        body["error"] = status.get("error", "")
    return jsonify(body)


@app.get("/review/<job_id>")
def review(job_id: str):
    job_dir = job_path(job_id)
    status = read_status(job_dir)
    if status["status"] != "done":
        return redirect(url_for("rejected" if status["status"] == "rejected" else "processing", job_id=job_id))
    data = json.loads((job_dir / "extraction.json").read_text())
    options = {
        # Page image paths in extraction.json ("pages/page-05.png") are relative to the job folder.
        "imageBase": f"{request.script_root}/jobs/{job_id}/",
        "filename": status.get("filename", "packet.pdf"),
        "processed": status.get("finished"),
        "summaryUrl": url_for("save_summary", job_id=job_id),
        "pagesUrl": url_for("upload_pages", job_id=job_id),
        "adding": status.get("adding"),
        "emailSentUrl": url_for("mark_email_sent", job_id=job_id),
        "formats": FORMATS,
        "codes": CODES,
        # Where each coded payload value is read from (first non-empty wins), as in payload.py.
        "codeSources": {"jobCode": SOURCES["position"], "locationCode": SOURCES["location"], "employeeType": SOURCES["status"]},
        "payloadUrl": url_for("payload_preview", job_id=job_id),
        "rules": RULES,
        "decisionsUrl": url_for("post_decision", job_id=job_id),
        "decisions": read_decisions(job_dir),
        "emailUrl": url_for("save_email", job_id=job_id),
        "exportUrl": url_for("export", job_id=job_id),
        "emailDraft": json.loads((job_dir / "email_draft.json").read_text()) if (job_dir / "email_draft.json").exists() else None,
    }
    name, _ = employee_info(data)
    return render_template("review.html", data=data, options=options, filename=options["filename"],
                           crumb=name or options["filename"], back=True)


# ---------------------------------------------------------------------------
# PrismHR: the importEmployees payload the reviewed packet would produce (demo: nothing is sent).
# Codes the reviewer picked for unmatched values are "code::<payload key>" decisions.
# ---------------------------------------------------------------------------
@app.get("/api/payload/<job_id>")
def payload_preview(job_id: str):
    job_dir = job_path(job_id)
    decisions = read_decisions(job_dir)["decisions"]
    reviewed = reviewed_extraction(json.loads((job_dir / "extraction.json").read_text()), decisions)
    choices = {k.split("::", 1)[1]: d["value"] for k, d in decisions.items()
               if k.startswith("code::") and d["action"] in ("accepted", "edited") and d.get("value")}
    return jsonify(build_payload(reviewed, choices))


# ---------------------------------------------------------------------------
# Add pages to a packet: a supplementary scan, extracted on its own and merged in.
# ---------------------------------------------------------------------------
def run_add_pages(job_dir: Path, pdf: Path) -> None:
    try:
        summary = add_pages(pdf, job_dir)
        write_status(job_dir, adding={"status": "done", "pages": summary["pages"], "changed": len(summary["changed"]), "finished": now()})
    except Exception as exc:
        traceback.print_exc()
        message = f"{type(exc).__name__}: {exc}" + (f" Cause: {type(exc.__cause__).__name__}: {exc.__cause__}" if exc.__cause__ else "")
        write_status(job_dir, adding={"status": "error", "error": message, "finished": now()})


@app.post("/api/pages/<job_id>")
def upload_pages(job_id: str):
    job_dir = job_path(job_id)
    if read_status(job_dir).get("adding", {}).get("status") == "running":
        return jsonify(error="Pages are already being added to this packet."), 409
    file = request.files.get("pages")
    if not file or not file.filename:
        return jsonify(error="Choose a PDF to add."), 400
    if file.stream.read(5) != b"%PDF-":
        return jsonify(error=NOT_A_PDF), 400
    file.stream.seek(0)
    pdf = job_dir / f"supplement-{len(list(job_dir.glob('supplement-*.pdf'))) + 1}.pdf"
    file.save(pdf)
    write_status(job_dir, adding={"status": "running", "file": secure_filename(file.filename) or pdf.name, "started": now()})
    threading.Thread(target=run_add_pages, args=(job_dir, pdf), daemon=True).start()
    return jsonify(ok=True)


@app.get("/api/pages/<job_id>")
def pages_status(job_id: str):
    return jsonify(read_status(job_path(job_id)).get("adding") or {})


@app.get("/jobs/<job_id>/pages/<name>")
def job_page(job_id: str, name: str):
    """Serve a job's rendered page images (page-NN.png) and nothing else."""
    job_dir = job_path(job_id)
    if not PAGE_IMAGE.fullmatch(name):
        abort(404)
    return send_from_directory(job_dir / "pages", name)


if __name__ == "__main__":
    app.run(debug=False, port=5050)  # not 5000: macOS uses it for AirPlay
