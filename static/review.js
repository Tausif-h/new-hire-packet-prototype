// Packet Review page, rendered by templates/review.html (Flask app).
// Entry point: PacketReview.render(container, data, options)
//   data:    extraction.json from extract.py
//   options: {imageBase, filename, processed (ISO time), summaryUrl,
//             decisionsUrl + decisions (web app only: Accept / Edit / Skip are saved there)}
(function () {
  const SIGNED = "[signed]";
  // The assembler's checklist cover page isn't new-hire data, so it isn't reviewed (unless it's missing).
  const COVER_FORM = "New Hire Employment Packet — Cover / Document Checklist";
  const EMP = "Employment Form (ProService)";
  const AGR = "Employment Agreement";
  const I9 = "Form I-9 — Employment Eligibility Verification";
  const W4 = "Form W-4 — Employee's Withholding Certificate";
  const HW4 = "Form HW-4 — Employee's Withholding Allowance and Status Certificate";
  const DD = "Authorization for Direct Deposit & Electronic Pay Statements";
  const HB = "Acknowledgment of Employee Handbook";
  const HC5 = "Form HC-5 — Employee Notification to Employer (Hawaii DOL)";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  }
  const hasValue = f => f.value !== "" && f.value != null;
  const flagsOf = f => f.flags || (f.flag ? [f.flag] : []);
  // "A", "A and B", "A, B, and C"
  const listNames = names => names.length < 3 ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;

  // ===========================================================================
  // Requirement rules from the catalog (see extract.py field_entry):
  //   required_group:      the group counts as ONE required item, satisfied by any one option
  //   group_option:        members sharing an option must all have values (List B + List C);
  //                        a member without one is an option by itself
  //   required_if:         required only when the named field in the same form has a value
  //   required_if_matches: ...and that value matches this regex
  //   optional_if_matches: ...unless that value matches this regex, then it's optional
  // ===========================================================================
  const optionOf = f => f.group_option || f.field;

  function groupSatisfied(group, fields) {
    const options = new Map();
    for (const f of fields.filter(x => x.required_group === group)) {
      options.set(optionOf(f), (options.get(optionOf(f)) ?? true) && hasValue(f));
    }
    return [...options.values()].some(Boolean);
  }

  // For a required_if / required_with field: "required", "optional" (exempted), or "na" (condition not met).
  //   required_with: required once any of the listed fields has a value (an all-or-nothing block)
  function conditionState(f, fields) {
    if (f.required_with) return fields.some(x => f.required_with.includes(x.field) && hasValue(x)) ? "required" : "na";
    const trigger = fields.find(x => x.field === f.required_if);
    if (!trigger || !hasValue(trigger)) return "na";
    if (f.required_if_matches && !new RegExp(f.required_if_matches, "i").test(trigger.value)) return "na";
    if (f.optional_if_matches && new RegExp(f.optional_if_matches, "i").test(trigger.value)) return "optional";
    return "required";
  }

  function requirementItems(fields) {
    const required = [], optional = [], groups = new Set();
    for (const f of fields) {
      if (f.required_group) groups.add(f.required_group);
      else if (f.required_if || f.required_with) {
        const state = conditionState(f, fields);
        if (state !== "na") (state === "required" ? required : optional).push(hasValue(f));
      }
      else (f.required ? required : optional).push(hasValue(f));
    }
    for (const g of groups) required.push(groupSatisfied(g, fields));
    return {required, optional};
  }

  // Badge and empty-value state for one field, given the rest of its form.
  // Empty states: "missing" (red), "not used" (another option was used), "n/a" (condition not met).
  // A field is only "missing" when it's required and blank; an optional one left empty is just "blank".
  const MISSING = ["missing", "v-missing"], NOT_USED = ["not used", "v-notused"], NA = ["n/a", "v-na"], BLANK = ["blank", "v-blank"];
  function fieldRule(f, fields) {
    if (f.required_group) {
      const satisfied = groupSatisfied(f.required_group, fields);
      const optionUsed = fields.some(x => x.required_group === f.required_group && optionOf(x) === optionOf(f) && hasValue(x));
      return {badge: f.group_option ? `required: ${f.group_option}` : "required: pick one", cls: "required",
              title: `${f.required_group}: one option is required`,
              // A partly filled option (e.g. List B without List C) still needs its other half.
              empty: satisfied && !optionUsed ? NOT_USED : MISSING};
    }
    if (f.required_if || f.required_with) {
      const state = conditionState(f, fields);
      const label = f.required_with_label || f.required_if_label || `"${f.required_if}" filled`;
      if (state === "optional") {
        return {badge: `optional: ${f.optional_if_label}`, cls: "optional", title: `Not required because ${f.optional_if_label}`, empty: NA};
      }
      const on = state === "required";
      return {badge: on ? `required: ${label}` : `required if ${label}`, cls: on ? "required" : "optional",
              title: `Required only if ${label}${f.required_if ? ` ("${f.required_if}")` : ""}`, empty: on ? MISSING : NA};
    }
    return {badge: f.required ? "required" : "optional", cls: f.required ? "required" : "optional", title: "", empty: f.required ? MISSING : BLANK};
  }

  const CONFIDENCE_TITLES = {
    high: "Clearly readable",
    medium: "Readable but with some doubt (faint writing, cramped boxes)",
    low: "Barely legible or partially obscured",
  };

  // ===========================================================================
  // Decisions (web app): applied on top of the extraction. A decision's "fields" sets reviewed
  // values; a field whose reviewed value differs from what the AI read is "adjusted".
  // ===========================================================================
  const RESOLVED = new Set(["accepted", "edited"]);
  const fieldKey = (form, field) => `${form}::${field}`;

  // A copy of the data with reviewed values in place; each overridden field gets
  // review = {original, value, adjusted}.
  function effectiveData(data, decisions) {
    const copy = JSON.parse(JSON.stringify(data));
    const index = new Map();
    for (const form of copy.forms || []) for (const f of form.fields) index.set(fieldKey(form.form, f.field), f);
    for (const form of copy.forms || []) {
      const back = (form.missing_pages || []).filter(p => (decisions[pageKey(form.form, p.page)] || {}).action === "accepted");
      if (!back.length) continue;
      for (const f of form.fields) if (back.some(p => p.page === f.form_page)) f.page_missing = false;
      form.missing_pages = form.missing_pages.filter(p => !back.includes(p));
      if (!form.missing_pages.length) form.status = "present";
    }
    for (const d of Object.values(decisions)) {
      if (!RESOLVED.has(d.action)) continue;
      for (const o of d.fields || []) {
        const f = index.get(fieldKey(o.form, o.field));
        if (!f) continue;
        const original = f.review ? f.review.original : f.value;
        f.review = {original, value: o.value, adjusted: o.value !== original, filledFrom: d.filled_from || null};
        f.value = o.value;
      }
    }
    return copy;
  }

  // ===========================================================================
  // Source pages and the two-pane source viewer. Every page image on the site opens the same
  // viewer: the page on the left (zoomable), and on the right a sidebar with the field's context
  // and, for review items, the controls to resolve it. Arrows step through the other pages in the
  // group (e.g. one conflict's pages); the sidebar follows the page shown.
  // ctx.groups: group name -> list of entries {image, caption, note, highlight, page, form, field,
  //                                            itemKey, sourceIndex (which reading of a conflict)}
  // ===========================================================================
  function addSource(ctx, group, entry) {
    if (!ctx.groups.has(group)) ctx.groups.set(group, []);
    ctx.groups.get(group).push(entry);
    return ctx.groups.get(group).length - 1;
  }

  // The page a field was read from: full image URL, location caption, short form name, section.
  function fieldSource(ctx, formName, fieldName) {
    const form = (ctx.data.forms || []).find(f => f.form === formName);
    const field = form && form.fields.find(x => x.field === fieldName);
    const info = field && (ctx.data.pages || []).find(p => p.page === field.page);
    if (!info || !info.image) return null;
    const location = field.location || `${formName} — ${fieldName}`;
    // "Form I-9, Section 2, List C table — Expiration Date row": short "Form I-9", section "Section 2, List C table".
    const [place, label] = location.split(" — ");
    const parts = place.split(", ");
    return {image: ctx.imageBase + info.image, caption: `${location} (page ${field.page})`, page: field.page,
            short: parts[0], section: parts[1], fullSection: parts.slice(1).join(", "), label: label || fieldName};
  }

  // The review item a field belongs to (for the viewer sidebar and "Review in triage" links):
  // its own flagged item, else the conflict or required group it's part of, else its plain item.
  function itemFor(ctx, formName, fieldName) {
    const own = ctx.items.find(i => i.kind === "field" && i.form.form === formName && i.field.field === fieldName);
    if (own && own.tags.length) return {item: own};
    for (const i of ctx.items.filter(i => i.kind === "conflict")) {
      const sourceIndex = i.sources.findIndex(s => s.form === formName && s.fields.includes(fieldName));
      if (sourceIndex >= 0) return {item: i, sourceIndex};
    }
    const group = ctx.items.find(i => i.kind === "group" && i.tags.length && i.form.form === formName && i.members.some(m => m.field === fieldName));
    return group ? {item: group} : own ? {item: own} : {};
  }

  // A viewer entry for one field's page.
  function fieldEntry(ctx, formName, fieldName, extra = {}) {
    const src = fieldSource(ctx, formName, fieldName);
    if (!src) return null;
    const {item, sourceIndex} = itemFor(ctx, formName, fieldName);
    return {image: src.image, caption: src.caption, page: src.page, form: formName, field: fieldName,
            itemKey: item && item.key, sourceIndex, highlight: true, ...extra};
  }

  // A "View source" button (no preview); opens the viewer on the field's page.
  function sourceButton(ctx, group, formName, fieldName, note) {
    const entry = fieldEntry(ctx, formName, fieldName, {note});
    if (!entry) return "";
    const index = addSource(ctx, group, entry);
    return `<button type="button" class="btn small source-open" data-group="${esc(group)}" data-index="${index}"
      title="${esc(entry.caption)}">View source</button>`;
  }

  function ensureViewer() {
    let modal = document.getElementById("source-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "source-modal";
    modal.innerHTML = `
      <div class="sm-dialog" role="dialog" aria-modal="true" aria-labelledby="sm-caption">
        <header class="sm-head">
          <div class="sm-titles"><div class="sm-caption" id="sm-caption"></div><span class="sm-pos"></span></div>
          <div class="sm-item-nav">
            <button type="button" class="btn small" data-item-step="-1" aria-label="Previous item">&#8249; Back</button>
            <span class="sm-item-pos"></span>
            <button type="button" class="btn small" data-item-step="1" aria-label="Next item">Next &#8250;</button>
          </div>
          <button type="button" class="sm-close" aria-label="Close">&#10005;</button>
        </header>
        <div class="sm-main">
          <div class="sm-image-pane">
            <div class="sm-zoom" role="group" aria-label="Zoom">
              <button type="button" data-zoom="-1" aria-label="Zoom out">&#8722;</button>
              <span class="sm-zoom-level">100%</span>
              <button type="button" data-zoom="1" aria-label="Zoom in">+</button>
              <button type="button" data-zoom="fit">Fit width</button>
            </div>
            <div class="sm-body"><img alt=""><p class="sm-noimage" hidden></p></div>
            <button type="button" class="sm-nav sm-prev" aria-label="Previous page">&#8249;</button>
            <button type="button" class="sm-nav sm-next" aria-label="Next page">&#8250;</button>
          </div>
          <aside class="sm-sidebar"></aside>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector(".sm-close").addEventListener("click", closeViewer);
    modal.addEventListener("click", e => {
      if (e.target === modal) return closeViewer();  // backdrop
      const zoom = e.target.closest("[data-zoom]");
      if (zoom) return setZoom(zoom.dataset.zoom);
      const step = e.target.closest("[data-item-step]");
      if (step) return viewerStepItem(+step.dataset.itemStep);
      const act = e.target.closest("[data-act]");
      if (act) return viewerAct(act);
    });
    modal.querySelector(".sm-prev").addEventListener("click", () => showEntry(modal._index - 1));
    modal.querySelector(".sm-next").addEventListener("click", () => showEntry(modal._index + 1));
    // Remember the reviewer's choice while they flip pages, and enable "Save selection" once they pick.
    const bar = modal.querySelector(".sm-sidebar");
    for (const type of ["input", "change"]) bar.addEventListener(type, e => { syncConflictChoice(bar, e); rememberChoice(modal); });
    document.addEventListener("keydown", e => {
      if (!modal.classList.contains("open")) return;
      if (e.key === "Escape") return closeViewer();
      if (e.target.tagName === "INPUT" && e.key === "Enter" && !modal._readOnly) return enterAction(bar, modal._container._ctx);
      if (e.target.tagName === "INPUT") return;  // typing in the sidebar
      if (e.key === "ArrowLeft") showEntry(modal._index - 1);
      else if (e.key === "ArrowRight") showEntry(modal._index + 1);
    });
    modal.querySelector(".sm-body img").addEventListener("load", () => setZoom(modal._zoom || 1));
    // Drag the page to pan when it's zoomed past the pane.
    const body = modal.querySelector(".sm-body");
    body.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.tagName !== "IMG") return;
      const start = {x: e.clientX, y: e.clientY, left: body.scrollLeft, top: body.scrollTop};
      body.classList.add("panning");
      const move = ev => { body.scrollLeft = start.left - (ev.clientX - start.x); body.scrollTop = start.top - (ev.clientY - start.y); };
      const up = () => { body.classList.remove("panning"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      e.preventDefault();
    });
    return modal;
  }

  // Zoom: a fraction of the page's natural (150 dpi) width, or "fit" to the pane's width.
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  function setZoom(step) {
    const modal = document.getElementById("source-modal"), img = modal.querySelector(".sm-body img");
    const fit = modal.querySelector(".sm-body").clientWidth - 32;
    let zoom = modal._zoom || 1;
    if (step === "fit") zoom = img.naturalWidth ? fit / img.naturalWidth : 1;
    else if (step === "-1" || step === "1") {
      const i = ZOOMS.findIndex(z => z >= zoom - 0.001);
      zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + (+step)))];
    } else zoom = +step;
    modal._zoom = zoom;
    if (img.naturalWidth) img.style.width = `${Math.round(img.naturalWidth * zoom)}px`;
    modal.querySelector(".sm-zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  }

  function showEntry(index) {
    const modal = document.getElementById("source-modal"), entries = modal._entries;
    if (index < 0 || index >= entries.length) return;
    rememberChoice(modal);
    modal._index = index;
    const entry = entries[index], img = modal.querySelector(".sm-body img"), none = modal.querySelector(".sm-noimage");
    modal.querySelector(".sm-caption").textContent = entry.caption;
    modal.querySelector(".sm-pos").textContent = entries.length > 1 ? `Page ${index + 1} of ${entries.length}` : "";
    img.hidden = !entry.image;
    none.hidden = !!entry.image;
    none.textContent = entry.image ? "" : "No page to show: this item isn't in the packet's pages.";
    if (entry.image) img.src = entry.image;
    modal.querySelector(".sm-body").scrollTop = 0;
    modal.querySelector(".sm-prev").disabled = index === 0;
    modal.querySelector(".sm-next").disabled = index === entries.length - 1;
    modal.classList.toggle("single", entries.length === 1);  // no page arrows for a lone page
    // Item position in the session (or the triage queue), for Back / Next.
    const ctx = modal._container._ctx, session = viewerSession(modal);
    const pos = session.findIndex(i => i.key === entry.itemKey);
    const remaining = session.filter(i => itemState(ctx, i) === "open").length;
    modal.querySelector(".sm-item-pos").textContent = pos >= 0
      ? `Item ${pos + 1} of ${session.length}${modal._session ? ` · ${remaining} remaining` : ""}` : "";
    const [back, next] = modal.querySelectorAll("[data-item-step]");
    back.disabled = !session.length;  // Back from the first item closes the viewer
    next.disabled = !session.length || pos >= session.length - 1;
    renderViewerSidebar(modal);
  }

  // readOnly (All Forms): the page and the form's fields only: zoom, pan, page arrows, close; no decisions.
  function openViewer(container, entries, index, readOnly = false) {
    const modal = ensureViewer();
    modal._container = container;
    modal._entries = entries;
    // Working through the queue in the viewer: its open items at this moment are the session.
    const ctx = container._ctx, first = entries[index] && entries[index].itemKey;
    modal._session = null;
    modal.classList.remove("complete");
    const done = modal.querySelector(".sm-complete");
    if (done) done.remove();
    if (!readOnly && first && ctx.state.tab === "triage") {
      const keys = triageQueue(ctx).filter(i => itemState(ctx, i) === "open").map(i => i.key);
      modal._session = keys.includes(first) ? keys : [first, ...keys];
    }
    modal._readOnly = readOnly;
    modal.classList.toggle("read-only", readOnly);
    modal._choices = {};  // itemKey -> {radio, other, edit}
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
    showEntry(index);
    modal.querySelector(".sm-close").focus();
  }
  function closeViewer() {
    const modal = document.getElementById("source-modal");
    clearTimeout(modal._exitTimer);
    const done = modal.querySelector(".sm-complete");
    if (done) done.remove();
    modal.classList.remove("open", "complete");
    document.body.style.overflow = "";
  }

  // The viewer pages for one review item (its sources), each tagged with the item.
  function itemEntries(ctx, item) {
    let entries = [];
    if (item.kind === "conflict") {
      entries = item.sources.map((s, i) => s.src && {...fieldEntry(ctx, s.form, s.fields[0]), sourceIndex: i}).filter(Boolean);
    } else if (item.kind === "field") {
      entries = [fieldEntry(ctx, item.form.form, item.field.field)].filter(Boolean);
    } else if (item.kind === "group") {
      entries = [fieldEntry(ctx, item.form.form, item.members[0].field)].filter(Boolean);
    } else if (item.kind === "code") {
      entries = [fieldEntry(ctx, item.from.form, item.from.field)].filter(Boolean);
    } else if (item.kind === "unrecognized") {
      const info = (ctx.data.pages || []).find(p => p.page === item.page.page);
      entries = [{image: info && info.image ? ctx.imageBase + info.image : item.page.thumbnail, page: item.page.page,
                  caption: `Page ${item.page.page} — not recognized as any form in the catalog`}];
    } else if (item.kind === "missing_page") {
      // The pages of the form that are in the scan, for context.
      entries = (item.form.pages || []).map(n => (ctx.data.pages || []).find(p => p.page === n)).filter(p => p && p.image)
        .map(p => ({image: ctx.imageBase + p.image, page: p.page, form: item.form.form,
                    caption: `${item.form.form} — the page that is in the scan (page ${item.page.page} is missing)`}));
    }
    if (!entries.length) entries = [{image: null, caption: item.title}];
    return entries.map(e => ({...e, itemKey: item.key}));
  }

  // The items Back / Next walk through: the session (opened from Triage), else the triage queue.
  function viewerSession(modal) {
    const ctx = modal._container._ctx;
    return modal._session ? modal._session.map(k => ctx.items.find(i => i.key === k)).filter(Boolean) : triageQueue(ctx);
  }
  // Viewer Back / Next: the previous / next item, page and sidebar together. Back from the first
  // item closes the viewer (no wrapping round to the end).
  function viewerStepItem(step) {
    const modal = document.getElementById("source-modal"), container = modal._container;
    const list = viewerSession(modal);
    if (!list.length) return;
    const pos = list.findIndex(i => i.key === modal._entries[modal._index].itemKey);
    const to = pos < 0 ? 0 : pos + step;
    if (to < 0) return exitViewerToTriage(container);
    if (to >= list.length) return;
    showItemInViewer(container, list[to]);
  }
  function exitViewerToTriage(container) {
    const modal = document.getElementById("source-modal");
    clearTimeout(modal._exitTimer);
    closeViewer();
    const ctx = container._ctx;
    ctx.state.tab = "triage";
    writeHash(ctx);
    draw(container);
  }
  // After an action in the viewer: the next open item of the session, or the completion screen.
  function viewerAdvance(container, item) {
    const modal = document.getElementById("source-modal"), ctx = container._ctx;
    const list = viewerSession(modal), at = list.findIndex(i => i.key === item.key);
    const order = [...list.slice(at + 1), ...list.slice(0, Math.max(0, at))];
    const next = order.find(i => itemState(ctx, i) === "open" && (decisionOf(ctx, i) || {}).action !== "skipped");
    if (next) return showItemInViewer(container, next);
    if (!modal._session) return showItemInViewer(container, item);
    viewerComplete(container);
  }
  // "All 7 items addressed · 5 confirmed missing · 2 values entered" + Back to triage; auto-exits.
  function viewerComplete(container) {
    const modal = document.getElementById("source-modal"), ctx = container._ctx, list = viewerSession(modal);
    const addressed = list.filter(i => itemState(ctx, i) !== "open");
    const kinds = {};
    const kindOf = i => {
      const d = decisionOf(ctx, i);
      if (d.received) return ["value received", "values received"];
      if (d.filled_from) return ["value filled from other forms", "values filled from other forms"];
      return ({confirmed_missing: ["confirmed missing", "confirmed missing"], unreadable: ["marked unreadable", "marked unreadable"],
               clarify: ["sent to the client to clarify", "sent to the client to clarify"], edited: ["value entered", "values entered"],
               accepted: ["confirmed", "confirmed"], requested: ["requested from client", "requested from client"]})[d.action] || ["resolved", "resolved"];
    };
    for (const i of addressed) { const [one, many] = kindOf(i); kinds[one] = kinds[one] || {n: 0, many}; kinds[one].n++; }
    const breakdown = Object.entries(kinds).map(([one, {n, many}]) => `${n} ${n === 1 ? one : many}`).join(" · ");
    const skipped = list.length - addressed.length;
    const title = skipped ? `${addressed.length} of ${list.length} items addressed` : `All ${list.length} item${list.length === 1 ? "" : "s"} addressed`;
    const panel = document.createElement("div");
    panel.className = "sm-complete";
    panel.innerHTML = `<div class="sm-complete-card" role="status"><div class="sm-complete-icon" aria-hidden="true">&#10003;</div>
      <h2>${esc(title)}</h2><p>${esc(breakdown)}${skipped ? ` · ${skipped} skipped` : ""}</p>
      <button type="button" class="btn primary" data-complete="exit">Back to triage</button></div>`;
    panel.querySelector("[data-complete]").addEventListener("click", () => exitViewerToTriage(container));
    modal.querySelector(".sm-dialog").appendChild(panel);
    modal.classList.add("complete");
    showToast(container, `Queue complete — ${addressed.length} of ${list.length} addressed`);
    modal._exitTimer = setTimeout(() => { if (modal.classList.contains("open")) exitViewerToTriage(container); }, 3000);
    panel.querySelector("button").focus();
  }
  function showItemInViewer(container, item) {
    const modal = document.getElementById("source-modal"), ctx = container._ctx;
    modal._entries = itemEntries(ctx, item);
    ctx.state.selected = item.key;  // keep the triage selection in step
    writeHash(ctx);
    draw(container);
    showEntry(0);
  }

  function rememberChoice(modal) {
    const bar = modal.querySelector(".sm-sidebar"), key = bar.dataset.key;
    if (!key) return;
    const radio = bar.querySelector('input[type="radio"]:checked');
    modal._choices[key] = {radio: radio ? radio.value : null, other: (bar.querySelector(".other-value") || {}).value,
                           edit: (bar.querySelector(".edit-value") || {}).value};
  }

  // Sidebar: breadcrumb (Form · Section · Page N), the field name largest, then the value, badges,
  // and the item's contextual actions; then every field of the form to check against the scan.
  function renderViewerSidebar(modal) {
    const ctx = modal._container._ctx, entry = modal._entries[modal._index];
    const bar = modal.querySelector(".sm-sidebar");
    const keepTop = bar.dataset.key && bar.dataset.key === (entry.itemKey || "") ? bar.scrollTop : 0;
    requestAnimationFrame(() => { bar.scrollTop = keepTop; });  // same item: stay put; another item: start at the top
    const item = entry.itemKey && ctx.items.find(i => i.key === entry.itemKey);
    const src = entry.form && entry.field && fieldSource(ctx, entry.form, entry.field);
    const crumbs = [src ? src.short : entry.form && shortName(entry.form), src && src.fullSection, entry.page && `Page ${entry.page}`].filter(Boolean);
    const head = `<div class="sm-crumbs">${crumbs.map(esc).join(" · ")}</div>
      <h3 class="sm-title">${esc(item ? item.title : src ? src.label : entry.caption)}</h3>`;
    bar.dataset.key = item ? item.key : "";
    if (!item || modal._readOnly) {
      bar.innerHTML = head + (entry.note ? `<p class="sm-note${entry.highlight ? " highlight" : ""}">${esc(entry.note)}</p>` : "") +
        viewerFieldList(ctx, entry);
      return;
    }
    const saved = modal._choices[item.key] || {};
    bar.innerHTML = `${head}<div class="sm-item">${itemBody(ctx, item, {where: "viewer", entry, saved})}
      ${actionButtons(ctx, item, "viewer", saved)}</div>${viewerFieldList(ctx, entry)}`;
    syncConflictChoice(bar);
    validateInputs(bar);
  }

  // Every field of the shown form, to check against the scan: name, value, badges, severity tint.
  // The field being viewed is marked; fields read from another page say which.
  function viewerFieldList(ctx, entry) {
    const form = entry.form && (ctx.effective.forms || []).find(f => f.form === entry.form);
    if (!form || !hasPages(form)) return "";
    const rows = form.fields.map(f => {
      const rule = fieldRule(f, form.fields), cat = fieldCategory(ctx, form.form, f.field);
      const current = f.field === entry.field;
      const elsewhere = entry.page && f.page && f.page !== entry.page ? `<span class="sm-other-page">page ${f.page}</span>` : "";
      return `<li class="sm-field${cat ? ` row-cat cat-${cat}` : ""}${current ? " current" : ""}${f.review && f.review.adjusted ? " adjusted" : ""}"${current ? ' aria-current="true"' : ""}>
        <div class="sm-field-name">${esc(f.field)}${elsewhere}</div>
        <div class="sm-field-value">${fieldValueHtml(f, rule)}</div>
        <div class="field-pills">${fieldPills(f, rule)}</div></li>`;
    }).join("");
    return `<section class="sm-fields"><div class="mini-label">${esc(shortName(form.form))} — all fields (${form.fields.length})</div><ul>${rows}</ul></section>`;
  }

  function viewerAct(button) {
    const modal = document.getElementById("source-modal"), container = modal._container, ctx = container._ctx;
    const bar = modal.querySelector(".sm-sidebar");
    const item = ctx.items.find(i => i.key === bar.dataset.key);
    if (item) performAction(container, item, button.dataset.act, bar, "viewer");
  }

  // ===========================================================================
  // Review items: everything the reviewer may need to act on, built from the raw extraction.
  //   kinds: conflict, field, group (unsatisfied required group), missing_form, unrecognized
  //   tags (the filter pills): low, conflict, scribble, missing, validation, choice, unrecognized
  //   severity (left strip): critical (red), missing (red), warning (orange), low (yellow),
  //                          info (gray: medium confidence), ok (green)
  // ===========================================================================
  const SEVERITY_ORDER = {critical: 0, missing: 1, warning: 2, low: 3, info: 4, ok: 5};
  // Issue categories in severity order. Pills, queue tiles, overview bars, and per-form summaries all
  // use this list (and the matching .cat-<tag> colors), so they always agree. Which categories
  // appear, and their counts, come from the packet data.
  const CATEGORIES = [
    {tag: "new", label: "From added pages", one: "field from added pages", many: "fields from added pages", badge: "new page", icon: "+"},
    {tag: "conflict", label: "Conflicts", one: "conflict", many: "conflicts", badge: "conflict", icon: "\u2260"},
    {tag: "validation", label: "Validation errors", one: "validation error", many: "validation errors", badge: "invalid", icon: "\u2715"},
    {tag: "scribble", label: "Scribbles", one: "scribble", many: "scribbles", badge: "scribble", icon: "\u270E"},
    {tag: "low", label: "Low confidence", one: "low-confidence", many: "low-confidence", badge: "low", icon: "!"},
    {tag: "medium", label: "Medium confidence", one: "medium-confidence", many: "medium-confidence", badge: "medium", icon: "~"},
    {tag: "missing", label: "Missing required", one: "missing required", many: "missing required", badge: "missing", icon: "\u25CB"},
    {tag: "choice", label: "Needs choice", one: "needs choice", many: "need choice", badge: "needs choice", icon: "?"},
    {tag: "code", label: "Code mismatches", one: "code mismatch", many: "code mismatches", badge: "no code", icon: "#"},
    {tag: "unrecognized", label: "Unrecognized pages", one: "unrecognized page", many: "unrecognized pages", badge: "unrecognized", icon: "\u25A2"},
  ];
  const CATEGORY = Object.fromEntries(CATEGORIES.map(c => [c.tag, c]));
  const categoryBadge = tag => `<span class="badge cat-badge cat-${tag}">${CATEGORY[tag].icon} ${CATEGORY[tag].badge}</span>`;

  const reviewedForms = data => (data.forms || []).filter(f => f.form !== COVER_FORM);
  // Found in the packet: all its pages ("present") or some ("partial": a required page is missing).
  const hasPages = form => form.status === "present" || form.status === "partial";
  const pageKey = (formName, page) => `page_missing::${formName}::${page}`;
  const shortForm = label => label.split(" — ")[0];
  const formOfLabel = (data, label) =>
    (data.forms || []).map(f => f.form).find(name => label === name || label.startsWith(name + " — "));

  function conflictSources(ctx, c) {
    const sources = Object.entries(c.values).map(([label, value]) => {
      const formName = formOfLabel(ctx.data, label);
      const names = (c.fields || {})[label] || [];
      const src = fieldSource(ctx, formName, names[0]);
      return {label, value, form: formName, fields: names, src,
              differs: c.majority != null && (c.differs || []).includes(label), name: src ? src.short : shortForm(label)};
    });
    // Two readings from one form (e.g. I-9 Section 1 and Section 2 dates): name them by section.
    const counts = sources.reduce((m, s) => m.set(s.name, (m.get(s.name) || 0) + 1), new Map());
    for (const s of sources) if (counts.get(s.name) > 1 && s.src && s.src.section) s.name += ` ${s.src.section}`;
    return sources;
  }

  // "Employment Form and Form W-4 show a different address from Form I-9 and Form HW-4."
  const conflictNoun = c => c.field.startsWith("Signature dates") ? "signature date"
                          : c.field === "Social Security Number" ? c.field : c.field.toLowerCase();
  function conflictHeadline(c, sources) {
    const noun = conflictNoun(c);
    if (c.majority == null) return `${listNames(sources.map(s => s.name))} disagree on the ${noun}.`;
    const odd = sources.filter(s => s.differs).map(s => s.name), rest = sources.filter(s => !s.differs).map(s => s.name);
    return `${listNames(odd)} ${odd.length === 1 ? "shows" : "show"} a different ${noun} from ${listNames(rest)}.`;
  }

  // PrismHR codes: the written job title, location, and status must each map to one of the client's
  // codes (same matching as payload.py); a value that maps to none is a Triage item.
  const squashCode = v => (v || "").toLowerCase().replace(/[^0-9a-z]/g, "");
  const CODE_CHECKS = [
    {key: "jobCode", table: "job_codes", noun: "Job title", label: "job code",
     match: (v, codes) => Object.keys(codes).find(c => squashCode(codes[c]) === squashCode(v))},
    {key: "locationCode", table: "location_codes", noun: "Location", label: "location code",  // "dept = beach" → the "beach location"
     match: (v, codes) => Object.keys(codes).find(c => v.toLowerCase().includes(codes[c].split(" ")[0].toLowerCase()))},
    {key: "employeeType", table: "employee_types", noun: "Employee type", label: "employee type",  // "Relief" counts as Casual (CA)
     match: (v, codes) => squashCode(v).includes("relief") && codes.CA ? "CA" : Object.keys(codes).find(c => squashCode(codes[c]) === squashCode(v))},
  ];
  function codeItems(ctx) {
    const {codes, codeSources} = ctx.options;
    if (!codes || !codeSources) return [];
    const eff = effectiveData(ctx.data, ctx.decisions), out = [];
    for (const check of CODE_CHECKS) {
      let value = "", from = null;
      for (const [form, field] of codeSources[check.key] || []) {
        const f = ((eff.forms || []).find(x => x.form === form && hasPages(x)) || {fields: []}).fields.find(x => x.field === field);
        if (f && hasValue(f)) { value = f.value.trim(); from = {form, field}; break; }
      }
      if (!value || check.match(value, codes[check.table] || {})) continue;  // blank: the missing-field flow covers it
      const form = ctx.data.forms.find(x => x.form === from.form);
      out.push({key: `code::${check.key}`, kind: "code", check, value, from, form, choices: codes[check.table] || {},
                title: `${check.noun} — no matching PrismHR ${check.label}`, subtitle: `${shortName(from.form)}: "${value}"`,
                forms: [from.form], tags: ["code"], severity: "warning", formIndex: reviewedForms(ctx.data).indexOf(form)});
    }
    return out;
  }

  function buildItems(ctx) {
    const data = ctx.data, items = [...codeItems(ctx)];
    const inConflict = new Set();
    // Conflicts: one item each, covering every field involved.
    for (const c of data.conflicts || []) {
      const sources = conflictSources(ctx, c);
      for (const s of sources) for (const n of s.fields) inConflict.add(fieldKey(s.form, n));
      const critical = c.severity === "critical";
      items.push({
        key: `conflict::${c.field}`, kind: "conflict", conflict: c, sources,
        title: c.type === "name_mismatch" ? `${c.field} — name mismatch` : c.field,
        subtitle: listNames([...new Set(sources.map(s => s.name))]),
        forms: [...new Set(sources.map(s => s.form))],
        tags: ["conflict"], severity: critical ? "critical" : "warning",
        summary: conflictHeadline(c, sources),
      });
    }
    reviewedForms(data).forEach((form, formIndex) => {
      if (form.status === "missing") {
        items.push({key: `form::${form.form}`, kind: "missing_form", title: form.form, subtitle: "Required form not in this packet",
                    forms: [form.form], tags: ["missing"], severity: "critical", formIndex});
        return;
      }
      if (!hasPages(form)) return;
      const fields = form.fields;
      // A missing page is one item; its fields are covered by it (unless the reviewer says the page is there).
      const pageBack = p => (ctx.decisions[pageKey(form.form, p.page)] || {}).action === "accepted";
      const absent = (form.missing_pages || []).filter(p => !pageBack(p));
      for (const p of form.missing_pages || []) {
        items.push({key: pageKey(form.form, p.page), kind: "missing_page", form, page: p, formIndex,
                    title: `${shortName(form.form)} — ${p.label.toLowerCase()} missing`, subtitle: `Page ${p.page} of ${form.form}`,
                    forms: [form.form], tags: ["missing"], severity: "critical"});
      }
      for (const f of fields) {
        if (f.required_group) continue;  // groups are one item, below
        if (absent.some(p => p.page === f.form_page)) continue;  // covered by the missing-page item
        const flags = flagsOf(f), tags = [];
        const rule = fieldRule(f, fields);
        if (flags.includes("invalid_value") || flags.includes("invalid_format") ||
            (ctx.invalidKeys && ctx.invalidKeys.has(`field::${fieldKey(form.form, f.field)}`))) tags.push("validation");
        if (flags.includes("illegible_scribble")) tags.push("scribble");
        if (f.supplement) tags.push("new");  // filled in or changed by pages added later: review it
        // "No box checked" only counts where a box is required (not when its condition isn't met).
        if (flags.includes("ambiguous_choice") || (flags.includes("missing") && rule.empty === MISSING)) tags.push("choice");
        // Missing = blank where the rules make it required (plain required, or a condition that applies).
        if (!hasValue(f) && rule.cls === "required" && rule.empty === MISSING) tags.push("missing");
        // Conflicting fields are covered by their conflict item unless something else is wrong too.
        const coveredByConflict = inConflict.has(fieldKey(form.form, f.field)) && !tags.length;
        if (f.confidence === "low" && !coveredByConflict) tags.push("low");
        if (f.confidence === "medium" && !coveredByConflict) tags.push("medium");
        const severity = tags.includes("missing") ? "missing"
          : tags.some(t => ["validation", "scribble", "choice"].includes(t)) ? "warning"
          : tags.includes("low") ? "low" : f.confidence === "medium" ? "info" : "ok";
        items.push({key: `field::${fieldKey(form.form, f.field)}`, kind: "field", form, field: f, rule,
                    title: f.field, subtitle: form.form, forms: [form.form], tags, severity, formIndex});
      }
      for (const group of new Set(fields.filter(f => f.required_group).map(f => f.required_group))) {
        const members = fields.filter(f => f.required_group === group);
        const satisfied = groupSatisfied(group, fields);
        items.push({key: `group::${form.form}::${group}`, kind: "group", form, members, title: group, subtitle: form.form,
                    forms: [form.form], tags: satisfied ? [] : ["missing"], severity: satisfied ? "ok" : "missing", formIndex});
      }
    });
    for (const p of data.unrecognized_pages || []) {
      items.push({key: `page::${p.page}`, kind: "unrecognized", page: p, title: `Page ${p.page}`,
                  subtitle: "Not recognized as any form in the catalog", forms: [], tags: ["unrecognized"], severity: "warning"});
    }
    return items;
  }

  // Medium confidence alone is worth a look but doesn't count as needing attention.
  const needsAttention = item => item.tags.some(t => t !== "medium");
  const decisionOf = (ctx, item) => ctx.decisions[item.key];
  // An item's review state:
  //   open          no decision yet, or skipped
  //   needs_client  confirmed missing / marked unreadable: goes in the client email
  //   requested     in a saved client email ("awaiting client")
  //   resolved      confirmed or corrected (a requested item becomes resolved when its value arrives)
  const CLIENT_ACTIONS = new Set(["confirmed_missing", "unreadable", "clarify"]);  // clarify: a conflict the client must settle
  // What a client-bound decision is waiting for, in a word or two.
  const clientLabel = d => ({unreadable: "unreadable", clarify: "awaiting clarification"})[d.action] || "confirmed missing";
  const isClarify = (ctx, item) => (decisionOf(ctx, item) || {}).action === "clarify";
  function itemState(ctx, item) {
    const d = decisionOf(ctx, item);
    if (!d || (ctx.invalidKeys && ctx.invalidKeys.has(item.key))) return "open";  // a saved value failing its format
    // A field the added pages filled in or changed: a decision from before them doesn't settle it.
    if (item.kind === "field" && item.field.supplement && (d.time || "") < item.field.supplement.added) return "open";
    if (RESOLVED.has(d.action)) return "resolved";
    if (d.status === "requested") return "requested";
    return CLIENT_ACTIONS.has(d.action) ? "needs_client" : "open";
  }
  // Handled = out of the "needs attention" count (resolved, or waiting on the client).
  const isResolved = (ctx, item) => itemState(ctx, item) !== "open";
  const unresolvedItems = ctx => ctx.items.filter(i => needsAttention(i) && !isResolved(ctx, i));

  // ===========================================================================
  // Header, stepper, dashboard
  // ===========================================================================
  function packetStats(ctx) {
    const data = ctx.effective;
    const forms = reviewedForms(data), present = forms.filter(hasPages);
    let reqDone = 0, reqTotal = 0, filled = 0;
    const conf = {high: 0, medium: 0, low: 0};
    for (const form of present) {
      const {required} = requirementItems(form.fields);
      reqDone += required.filter(Boolean).length;
      reqTotal += required.length;
      for (const f of form.fields) {
        if (conf[f.confidence] != null) conf[f.confidence]++;
        if (hasValue(f)) filled++;
      }
    }
    return {
      formsPresent: (data.forms || []).filter(f => f.status === "present").length,  // complete: every required page
      formsTotal: (data.forms || []).length,
      requiredPct: reqTotal ? Math.round(100 * reqDone / reqTotal) : 0,
      reqDone, reqTotal, conf, filled, attention: unresolvedItems(ctx).length,
    };
  }

  function employeeName(data) {
    const val = (form, field) => {
      const f = (data.forms || []).find(x => x.form === form);
      const x = f && f.fields.find(y => y.field === field);
      return x && hasValue(x) ? x.value : "";
    };
    return [val(EMP, "Name: First") || val(I9, "First Name (Given Name)"),
            val(EMP, "Name: Last") || val(I9, "Last Name (Family Name)")].filter(Boolean).join(" ");
  }

  function renderHeader(ctx, stats) {
    const {effective: data, options} = ctx;
    const name = employeeName(data) || "New hire packet";
    const emp = (data.forms || []).find(x => x.form === EMP);
    const company = emp && (emp.fields.find(x => x.field === "Company") || {}).value;
    const pageCount = (data.pages || []).length;
    const processed = options.processed ? new Date(options.processed).toLocaleString(undefined,
      {month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"}) : "";
    const step = (cls, dot, title, sub) => `<div class="${cls}"><span class="dot">${dot}</span><span><b>${title}</b><small>${sub}</small></span></div>`;
    const reviewDone = stats.attention === 0;
    return `
      <div class="stepper">
        ${step("done", "&#10003;", "Upload", `${pageCount}-page PDF`)}
        ${step("done", "&#10003;", "Extract", `${stats.filled} fields found`)}
        ${reviewDone ? step("done", "&#10003;", "Review", "All items resolved")
                     : step("current", "3", "Review", `${stats.attention} need attention`)}
        ${step(reviewDone ? "current" : "upcoming", "4", "Request info", "Draft message")}
        ${step("upcoming", "5", "Export", reviewDone ? "Ready" : "Available after review")}
      </div>
      <header class="page-header packet-header"><div class="kicker">AI-assisted operations review</div>
      <div class="title-row"><h1>${esc(name)}</h1>
        <span class="pill file-chip">${esc(options.filename || "Packet")} · ${pageCount} pages</span>
        ${options.pagesUrl ? `<label class="btn add-pages${ctx.adding ? " disabled" : ""}">+ Add pages to this packet
          <input type="file" accept="application/pdf,.pdf" data-action="add-pages" hidden ${ctx.adding ? "disabled" : ""}></label>` : ""}</div>
      <p class="lede">Find missing forms, verify uncertain fields, resolve conflicts, and prepare clean employee data for export.</p>
      <div class="subline">${[company, "New hire packet", processed && `Processed ${processed}`].filter(Boolean).map(esc).join(" · ")}</div></header>`;
  }

  function completionText(items) {
    if (!items.length) return '<span class="muted">none</span>';
    const done = items.filter(Boolean).length;
    return `${done} of ${items.length} (${Math.round(100 * done / items.length)}%)`;
  }

  // Under "Forms complete", always visible: each form with a missing page, and each missing form,
  // linking to its Triage item.
  function incompleteForms(ctx) {
    const lines = [];
    for (const form of reviewedForms(ctx.effective)) {
      for (const p of form.missing_pages || []) {
        lines.push(`<a href="#triage" class="kpi-issue partial" data-action="review-in-triage" data-key="${esc(pageKey(form.form, p.page))}">
          &#9888; ${esc(shortName(form.form))}: ${esc(p.label.toLowerCase())} missing</a>`);
      }
      if (form.status === "missing") {
        lines.push(`<a href="#triage" class="kpi-issue missing" data-action="review-in-triage" data-key="${esc(`form::${form.form}`)}">
          &#9675; ${esc(shortName(form.form))}: form missing</a>`);
      }
    }
    return lines.length ? `<div class="kpi-issues">${lines.join("")}</div>` : "";
  }

  // Once the client email is sent: how long it's been and what's still owed; green when all is in.
  function emailBanner(ctx) {
    const sent = lastSent(ctx);
    if (!sent) return "";
    const waiting = awaitingSent(ctx).length;
    if (!waiting) {
      let dismissed = null;
      try { dismissed = localStorage.getItem(`packetReview.emailResolved.${ctx.options.decisionsUrl}`); } catch {}
      if (dismissed === sent) return "";
      return `<div class="email-banner resolved" role="status"><a href="#review" data-action="open-awaiting">&#10003; All client items resolved.</a>
        <button type="button" class="stage-dismiss" data-action="dismiss-email-banner" aria-label="Dismiss">&#10005;</button></div>`;
    }
    const n = daysSince(sent);
    const age = n < 1 ? "awaiting reply since today" : `awaiting reply for ${n} day${n === 1 ? "" : "s"}`;
    return `<a class="email-banner" role="status" href="#review" data-action="open-awaiting">&#9993; Client email sent ${esc(shortWhen(sent))} — ${age} · ${
      waiting} item${waiting === 1 ? "" : "s"} still awaiting client.</a>`;
  }

  // While added pages are being read (and after: how many fields they changed).
  function addingBanner(ctx) {
    const a = ctx.adding;
    if (!a) return "";
    if (a.status === "running") return `<div class="adding-banner" role="status"><span class="spinner"></span>Reading the added pages (${esc(a.file || "PDF")}) — only the new pages are extracted…</div>`;
    if (a.status === "error") return `<div class="adding-banner error" role="alert">Adding pages failed: ${esc(a.error || "")}</div>`;
    return "";
  }
  async function uploadPages(container, file) {
    const ctx = container._ctx, body = new FormData();
    body.append("pages", file);
    const res = await fetch(ctx.options.pagesUrl, {method: "POST", body});
    const reply = await res.json().catch(() => ({}));
    if (!res.ok) return alert(reply.error || `Upload failed (${res.status})`);
    ctx.adding = {status: "running", file: file.name};
    draw(container);
    pollPages(container);
  }
  function pollPages(container) {
    const ctx = container._ctx;
    setTimeout(async () => {
      const a = await (await fetch(ctx.options.pagesUrl)).json().catch(() => ({}));
      if (a.status === "running") return pollPages(container);
      if (a.status === "done") { sessionStorage.setItem("packetReview.added", JSON.stringify(a)); return location.reload(); }
      ctx.adding = a;
      draw(container);
    }, 1500);
  }

  function renderDashboard(ctx, stats) {
    const {conf} = stats;
    const total = conf.high + conf.medium + conf.low || 1;
    const pct = n => Math.round(100 * n / total);
    const open = ctx.state.dashboardOpen;
    const rows = reviewedForms(ctx.effective).map((form, i) => {
      const {required, optional} = requirementItems(form.fields);
      const done = required.filter(Boolean).length;
      const share = required.length ? Math.round(100 * done / required.length) : 0;
      const status = form.status === "present" ? '<span class="status-pill present">Present</span>'
                   : form.status === "partial" ? `<span class="status-pill partial">Partial</span><div class="pill-sub">${
                       esc(form.missing_pages.map(p => `${p.label} missing`).join(", "))}</div>`
                   : form.status === "missing" ? '<span class="status-pill missing">Missing</span>'
                   : '<span class="status-pill na">Not applicable</span>';
      const na = form.status === "not_applicable";
      return `<tr class="${form.status === "missing" ? "row-missing" : form.status === "partial" ? "row-partial" : ""}"><td class="num">${i + 1}</td><td>${esc(form.form)}</td><td>${status}</td>
        <td class="stat">${na ? '<span class="muted">n/a</span>' : `<span class="bar"><span style="width:${share}%"></span></span>${completionText(required)}`}</td>
        <td class="stat">${na ? '<span class="muted">n/a</span>' : completionText(optional)}</td></tr>`;
    }).join("");
    return `
      <section class="card dashboard">
        <header><div><h2>Packet dashboard</h2><p class="sub screen-line">Overview of this packet. Expand for details, then work the Triage queue.</p></div>
          <button type="button" class="toggle" data-action="toggle-dashboard" aria-expanded="${open}">
            <span>${open ? "Hide details" : "Show details"}</span><span class="chev">&#8964;</span></button></header>
        <div class="kpis">
          <div class="kpi"><div class="num">${stats.formsPresent}<small>of ${stats.formsTotal}</small></div><div class="label">Forms complete</div>
            ${incompleteForms(ctx)}</div>
          <div class="kpi"><div class="num">${stats.requiredPct}%</div><div class="label">Required fields complete</div><div class="subtext">${stats.reqDone} of ${stats.reqTotal}</div></div>
          <div class="kpi"><div class="num${stats.attention ? " attention" : " good"}">${stats.attention}</div><div class="label">Items need attention</div></div>
          <div class="kpi">
            <div class="split"><span class="high" style="width:${pct(conf.high)}%"></span><span class="medium" style="width:${pct(conf.medium)}%"></span><span class="low" style="width:${pct(conf.low)}%"></span></div>
            <div class="legend">${pct(conf.high)}% high · ${pct(conf.medium)}% medium · ${pct(conf.low)}% low</div>
            <div class="label">Confidence split</div></div>
        </div>
        <div class="dash-details" ${open ? "" : "hidden"}>
          <table><tr><th>#</th><th>Form name</th><th>Status</th><th>Required complete</th><th>Optional complete</th></tr>${rows}</table>
        </div>
      </section>`;
  }

  // Unresolved items per category (medium-confidence fields included), optionally for one form.
  function openCounts(ctx, formName) {
    const open = ctx.items.filter(i => i.tags.length && !isResolved(ctx, i) && (!formName || i.forms.includes(formName)));
    return {open, counts: Object.fromEntries(CATEGORIES.map(c => [c.tag, open.filter(i => i.tags.includes(c.tag)).length]))};
  }

  // A collapsible overview card. Collapsed shows a compact summary; expanded shows the full body.
  function overviewCard(ctx, id, title, total, body, collapsedBody = "") {
    const open = ctx.state.cards[id] !== false;
    return `<section class="card overview-card${open ? "" : " collapsed"}">
      <header><h2>${title} <span class="card-count">${total}</span></h2>
        <button type="button" class="toggle" data-action="toggle-card" data-card="${id}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${title}">
          <span class="chev">&#8964;</span></button></header>
      ${open ? body : collapsedBody}</section>`;
  }

  // Donut of open issues by category, in severity colors, with a legend of counts.
  function issuesDonut(counts, total) {
    const shown = CATEGORIES.filter(c => counts[c.tag]);
    const sum = shown.reduce((n, c) => n + counts[c.tag], 0) || 1;
    const R = 15.9155, C = 2 * Math.PI * R;  // circumference 100, so dash lengths are percentages
    let offset = 0;
    const slices = shown.map(c => {
      const len = 100 * counts[c.tag] / sum;
      const slice = `<circle class="slice cat-${c.tag}" r="${R}" cx="21" cy="21" stroke-dasharray="${len.toFixed(2)} ${(100 - len).toFixed(2)}"
        stroke-dashoffset="${(25 - offset).toFixed(2)}"><title>${c.label}: ${counts[c.tag]}</title></circle>`;
      offset += len;
      return slice;
    }).join("");
    const legend = shown.map(c => `<li class="cat-${c.tag}"><i></i><span>${c.label}</span><b>${counts[c.tag]}</b></li>`).join("");
    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Open issues by category">
        <circle class="donut-hole" r="${R}" cx="21" cy="21"></circle>${slices}
        <text x="21" y="21" class="donut-total">${total}</text><text x="21" y="26.5" class="donut-caption">open</text></svg>
      <ul class="donut-legend">${legend}</ul></div>`;
  }

  // Per form: share of fields that are fine vs. have open issues (missing in red, the rest orange).
  function formBreakdown(ctx) {
    const open = unresolvedItems(ctx);
    return reviewedForms(ctx.data).map(form => {
      const items = open.filter(i => i.forms.includes(form.form));
      let row;
      if (form.status === "not_applicable") row = `<span class="fb-note muted">Not applicable</span>`;
      else if (form.status === "missing") row = `<span class="fb-bar"><span class="fb-missing" style="width:100%"></span></span><span class="fb-note">Missing · 1 issue</span>`;
      else {
        // Which of this form's fields the open items cover.
        const missing = new Set(), other = new Set();
        for (const i of items) {
          const names = i.kind === "field" ? [i.field.field] : i.kind === "group" ? i.members.map(m => m.field)
                      : i.kind === "conflict" ? i.sources.filter(s => s.form === form.form).flatMap(s => s.fields) : [];
          const issues = i.tags.filter(t => t !== "medium");  // medium confidence alone isn't an issue
          for (const n of names) (issues.length === 1 && issues[0] === "missing" ? missing : other).add(n);
        }
        for (const n of other) missing.delete(n);
        const total = form.fields.length || 1;
        const pm = Math.round(100 * missing.size / total), po = Math.round(100 * other.size / total), good = 100 - pm - po;
        row = `<span class="fb-bar"><span class="fb-good" style="width:${good}%"></span><span class="fb-other" style="width:${po}%"></span><span class="fb-missing" style="width:${pm}%"></span></span>
          <span class="fb-note">${form.status === "partial" ? "partial · " : ""}${good}% good · ${items.length} issue${items.length === 1 ? "" : "s"}</span>`;
      }
      return `<button type="button" class="form-breakdown" data-action="goto-filter" data-form="${esc(form.form)}" title="Show this form in Triage">
        <span class="fb-name">${esc(shortName(form.form))}</span>${row}</button>`;
    }).join("");
  }
  // The catalog's short form name ("Form I-9", "Direct Deposit Authorization"), carried at the start
  // of each field's location; falls back to the text before " — ".
  const SHORT_NAMES = new Map();
  function shortName(name) {
    if (!SHORT_NAMES.has(name)) {
      const loc = (((window.__packetData || {}).forms || []).find(f => f.form === name) || {fields: []}).fields.map(f => f.location).find(Boolean);
      SHORT_NAMES.set(name, loc ? loc.split(", ")[0] : name.split(" — ")[0].replace(/ \(ProService\)$/, ""));
    }
    return SHORT_NAMES.get(name);
  }

  function renderIssuesOverview(ctx) {
    const {open, counts} = openCounts(ctx);
    if (!open.length) {
      return overviewCard(ctx, "overview", "Issues overview", 0, '<p class="summary">Nothing open — every item has been reviewed.</p>',
                          '<p class="summary">Nothing open.</p>');
    }
    const donut = issuesDonut(counts, open.length);
    return overviewCard(ctx, "overview", "Issues overview", open.length,
      `${donut}<div class="breakdown"><div class="mini-label">By form <span class="fb-key"><i class="k-good"></i>good <i class="k-other"></i>issues <i class="k-missing"></i>missing</span></div>${formBreakdown(ctx)}</div>`,
      donut);
  }

  const TYPE_LABELS = {ssn: "SSN", phone: "Phone number", zip: "ZIP code", date: "Date", email: "Email address"};
  const TYPE_NOUNS = {ssn: "an SSN", phone: "a phone number", zip: "a ZIP code", date: "a date", email: "an email address"};
  // Very short label for one error: "Expiration Date looks like an SSN", "phone format", "date format".
  const REASON_LABELS = [[/^SSN/, "SSN format"], [/^Phone/, "phone format"], [/^ZIP/, "ZIP format"], [/email/i, "email format"],
    [/^Routing/, "routing number format"], [/calendar date/, "date format"], [/in the future/, "birth date in the future"],
    [/before the date of birth/, "start before birth date"]];
  function errorLabel(ctx, e) {
    if (e.suspected_type) {
      const src = fieldSource(ctx, e.form, e.field);
      return `${(src ? src.label : e.field).replace(/ row$/, "")} looks like ${TYPE_NOUNS[e.suspected_type] || e.suspected_type}`;
    }
    return (REASON_LABELS.find(([re]) => re.test(e.reason)) || [null, e.field])[1];
  }
  // Collapsed card: errors grouped by form, at most 3 short lines.
  function errorSummary(ctx, errors) {
    if (!errors.length) return '<p class="summary">None.</p>';
    const byForm = new Map();
    for (const e of errors) {
      const labels = byForm.get(e.form) || new Map();
      const label = errorLabel(ctx, e);
      labels.set(label, (labels.get(label) || 0) + 1);
      byForm.set(e.form, labels);
    }
    const lines = [...byForm].map(([form, labels]) =>
      `<li><b>${esc(shortName(form))}</b> — ${[...labels].map(([l, n]) => `${esc(l)} (${n})`).join(", ")}</li>`);
    if (lines.length > 3) lines.splice(2, lines.length, `<li class="muted">+${byForm.size - 2} more forms</li>`);
    return `<ul class="error-summary">${lines.join("")}</ul>`;
  }
  function renderErrors(ctx) {
    const errors = ctx.data.validation_errors || [];
    const rows = errors.map(e => `<tr><td>${esc(e.form)}</td><td>${esc(e.field)}</td><td>${esc(e.value)}</td>
      <td>${esc(e.reason)}${e.suspected_type ? `<div class="hint">Looks like: ${esc(TYPE_LABELS[e.suspected_type] || e.suspected_type)} — check whether it belongs on another line</div>` : ""}
        <div class="source-row">${sourceButton(ctx, "errors", e.form, e.field, `${e.reason} Value read: '${e.value}'.`)}</div></td></tr>`).join("");
    return overviewCard(ctx, "errors", "Validation errors", errors.length,
      errors.length ? `<div class="errors-scroll"><table class="errors"><tr><th>Form</th><th>Field</th><th>Value</th><th>Problem</th></tr>${rows}</table></div>`
                    : '<p class="summary">None — no impossible or badly formatted values.</p>',
      errorSummary(ctx, errors));
  }

  // ===========================================================================
  // Tabs
  // ===========================================================================
  const TABS = [["triage", "Triage"], ["forms", "All Forms"], ["review", "Review & Export"], ["activity", "Activity"]];
  function renderTabs(ctx, stats) {
    const awaiting = ctx.items.filter(i => ["needs_client", "requested"].includes(itemState(ctx, i))).length;
    const counts = {triage: stats.attention, forms: reviewedForms(ctx.data).length, review: awaiting || null, activity: (ctx.activity || []).length};
    return `<nav class="tabs" role="tablist">${TABS.map(([id, label]) => `
      <a href="#${id}" role="tab" class="tab${ctx.state.tab === id ? " active" : ""}" aria-selected="${ctx.state.tab === id}" data-tab="${id}">
        ${label}${counts[id] != null ? `<span class="tab-count">${counts[id]}</span>` : ""}</a>`).join("")}</nav>`;
  }

  // ---------- form list (left sidebar, shared by Triage and All Forms) ----------
  function renderFormList(ctx, selected, withAll, action = "select-form") {
    const open = unresolvedItems(ctx);
    const count = name => open.filter(i => i.forms.includes(name)).length;
    const entry = (name, label, n, extraCls = "") => `
      <li><button type="button" class="form-link${selected === name ? " selected" : ""}${extraCls}" data-action="${action}" data-form="${esc(name)}">
        <span>${esc(label)}</span>${n ? `<span class="count">${n}</span>` : ""}</button></li>`;
    return `<aside class="form-list"><ul>
      ${withAll ? entry("", "All forms", open.length) : ""}
      ${reviewedForms(ctx.data).map(f => entry(f.form, f.form, count(f.form),
        f.status === "missing" ? " is-missing" : f.status === "partial" ? " is-partial" : f.status === "not_applicable" ? " is-na" : "")).join("")}
    </ul></aside>`;
  }

  // ---------- Triage ----------
  function triageScope(ctx) {
    const {form, filters} = ctx.state;
    // Only items needing attention; medium-confidence fields only when their filter is on.
    return ctx.items.filter(i => (needsAttention(i) || (filters.has("medium") && i.tags.includes("medium")))
                                 && (!form || i.forms.includes(form)));
  }
  function triageQueue(ctx) {
    const scope = triageScope(ctx), filters = ctx.state.filters;
    const shown = filters.size ? scope.filter(i => i.tags.some(t => filters.has(t))) : scope;
    // Open first, then skipped, then waiting on the client, then resolved; within each, by issue group.
    const rank = i => ({open: (decisionOf(ctx, i) || {}).action === "skipped" ? 1 : 0, needs_client: 2, requested: 2, resolved: 3})[itemState(ctx, i)];
    return shown.slice().sort((a, b) => rank(a) - rank(b) || queueGroup(a) - queueGroup(b)
      || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  // Queue order follows CATEGORIES (severity). An item with several issues goes in the group of its
  // most specific one: a scribbled field is always low confidence and often blank, but it's a
  // scribble; a blank required field read with medium confidence is missing, not "medium".
  const QUEUE_GROUPS = CATEGORIES.map(c => c.tag);
  const MOST_SPECIFIC_FIRST = ["new", "code", "conflict", "validation", "scribble", "low", "missing", "choice", "unrecognized", "medium"];
  function queueGroup(item) {
    const group = MOST_SPECIFIC_FIRST.find(g => item.tags.includes(g));
    return group ? QUEUE_GROUPS.indexOf(group) : QUEUE_GROUPS.length;
  }

  function originalValue(ctx, o) {
    const form = (ctx.data.forms || []).find(f => f.form === o.form);
    const f = form && form.fields.find(x => x.field === o.field);
    return f ? f.value : "";
  }

  // "Done — confirmed missing · in client email", "Done — value entered", "Done — resolved".
  function doneBadge(ctx, item) {
    const d = decisionOf(ctx, item) || {}, state = itemState(ctx, item);
    const text = state === "requested" ? (d.action === "clarify" ? "asked client to clarify · awaiting reply" : "requested · awaiting client")
      : state === "needs_client" ? ({unreadable: "marked unreadable · in client email", clarify: "asked client to clarify · in client email"}[d.action] || "confirmed missing · in client email")
      : d.received ? "value received" : d.filled_from ? "filled from other forms" : d.action === "edited" ? "value entered" : "resolved";
    return `<span class="badge done-badge">Done — ${esc(text)}</span>`;
  }

  function itemBadges(ctx, item) {
    const d = decisionOf(ctx, item);
    let out = CATEGORIES.filter(c => item.tags.includes(c.tag)).map(c => categoryBadge(c.tag)).join("");
    if (!item.tags.length && item.kind === "field") {
      out += `<span class="badge conf-${item.field.confidence}">${item.field.confidence} confidence</span>`;
    }
    if (item.kind === "group") out = `<span class="badge required">required: pick one</span>` + out;
    const state = itemState(ctx, item);
    if (state === "requested") out += `<span class="badge awaiting">${d.action === "clarify" ? "awaiting clarification" : "awaiting client"}</span>`;
    else if (state === "needs_client") out += `<span class="badge needs-client">${clientLabel(d)}</span>`;
    else if (d && d.filled_from) out += `<span class="badge filled">${esc(filledFromLabel(d.filled_from))}</span>`;
    else if (d) {
      const adjusted = d.action === "edited" || (d.fields || []).some(o => o.value !== originalValue(ctx, o));
      if (adjusted && RESOLVED.has(d.action)) out += '<span class="badge adjusted">adjusted</span>';
      out += `<span class="badge decision ${d.action}">${{accepted: "confirmed", edited: "corrected", skipped: "skipped"}[d.action] || d.action}</span>`;
    }
    return out;
  }

  function renderTriage(ctx) {
    const scope = triageScope(ctx), queue = triageQueue(ctx), {filters} = ctx.state;
    // One pill per category present in this scope, in severity order, colored like the queue tiles.
    const formScope = ctx.items.filter(i => !ctx.state.form || i.forms.includes(ctx.state.form));
    const count = tag => (tag === "medium" ? formScope : scope).filter(i => i.tags.includes(tag)).length;
    const pills = CATEGORIES.filter(c => count(c.tag) || filters.has(c.tag)).map(c => `
      <button type="button" class="tag-pill cat-${c.tag}${filters.has(c.tag) ? " on" : ""}" data-action="toggle-filter" data-tag="${c.tag}"
        aria-pressed="${filters.has(c.tag)}"><span class="cat-icon">${c.icon}</span> ${c.label} <span class="n">(${count(c.tag)})</span></button>`).join("");
    if (!queue.some(i => i.key === ctx.state.selected)) {
      const first = queue.find(i => !isResolved(ctx, i)) || queue[0];
      ctx.state.selected = first ? first.key : null;
    }
    const rows = queue.map(item => {
      const d = decisionOf(ctx, item);
      const group = QUEUE_GROUPS[queueGroup(item)] || "other";
      const done = itemState(ctx, item) !== "open";
      return `<li><button type="button" class="queue-row cat-${group}${item.key === ctx.state.selected ? " selected" : ""}${done ? " done" : ""}"
          data-action="select-item" data-key="${esc(item.key)}" data-group="${group}">
        <span class="q-text"><b>${done ? '<span class="q-check" aria-label="Done">&#10003;</span> ' : ""}${esc(item.title)}</b><small>${esc(item.subtitle)}</small></span>
        <span class="q-badges">${done ? doneBadge(ctx, item) : itemBadges(ctx, item)}</span></button></li>`;
    }).join("");
    const selected = ctx.items.find(i => i.key === ctx.state.selected);
    return `
      <div class="triage">
        <div class="toolbar">
          <div class="pills">${pills}${filters.size ? '<button type="button" class="clear-filters" data-action="clear-filters">Clear filters</button>' : ""}</div>
        </div>
        <div class="triage-grid">
          ${renderFormList(ctx, ctx.state.form, true)}
          <section class="queue">
            <div class="queue-head">${queue.length} item${queue.length === 1 ? "" : "s"}${filters.size ? " (filtered)" : ""}${(() => {
              const n = queue.filter(i => itemState(ctx, i) !== "open").length; return n ? ` · ${queue.length - n} to do · ${n} done` : ""; })()}</div>
            ${queue.length ? `<ul>${rows}</ul>` : '<p class="empty">Nothing here. Try another form or clear the filters.</p>'}
          </section>
          <aside class="detail">${selected ? renderDetail(ctx, selected) : '<p class="empty">Select an item to review it.</p>'}</aside>
        </div>
      </div>`;
  }

  // The field as the reviewer currently sees it (reviewed value if decided).
  function currentField(ctx, form, field) {
    const ef = (ctx.effective.forms || []).find(f => f.form === form);
    return ef ? (ef.fields.find(x => x.field === field) || {}) : {};
  }

  // Conflict options: one radio per form's value, plus "Enter another value".
  //   saved: {radio, other} to restore; shownIndex marks the reading on the page being viewed.
  function conflictOptions(ctx, item, name, saved = {}, shownIndex = -1) {
    const d = decisionOf(ctx, item);
    const chosen = d && RESOLVED.has(d.action) ? d.value : null;
    const custom = chosen != null && !item.sources.some(s => s.value === chosen);
    // Nothing is preselected: the reviewer picks (Save selection stays disabled until they do).
    const checked = i => saved.radio != null ? saved.radio === String(i)
                       : chosen != null ? (i === "other" ? custom : item.sources[i].value === chosen) : false;
    const options = item.sources.map((s, i) => `
      <label class="option${s.differs ? " differs" : ""}${i === shownIndex ? " shown" : ""}">
        <input type="radio" name="${name}" value="${i}" ${checked(i) ? "checked" : ""}>
        <span><b>${esc(s.name)}</b>${i === shownIndex ? '<span class="shown-tag">on this page</span>' : ""}<span class="opt-value">${esc(s.value)}</span>
          ${s.differs ? '<span class="differs-tag">differs from the most common value</span>' : ""}</span></label>`).join("");
    const otherValue = saved.other != null ? saved.other : custom ? chosen : "";
    return `<fieldset class="options"><legend>Choose the correct value</legend>${options}
      <label class="option other"><input type="radio" name="${name}" value="other" ${checked("other") ? "checked" : ""}>
        <span><b>Enter another value</b><input type="text" class="other-value" placeholder="Type the correct value" value="${esc(otherValue)}"
          data-format="${esc(formatOf(ctx, item.sources[0].form, item.sources[0].fields[0]) || "")}"><span class="input-error" hidden></span></span></label>
    </fieldset>`;
  }

  // ===========================================================================
  // Cross-form quick-add. The same logical value appears on several forms; when a field is missing
  // and every other form that has it agrees (after normalizing), offer to fill it from them.
  // A source is [form, [fields]]; several fields are joined with spaces (only if all are filled).
  // ===========================================================================
  const LOGICAL_FIELDS = [
    {name: "email", kind: "email", sources: [[EMP, ["Email Address"]], [I9, ["Employee's Email Address"]]]},
    {name: "phone", kind: "phone", sources: [[EMP, ["Telephone Number"]], [I9, ["Employee's Telephone Number"]], [HC5, ["Employee phone no."]]]},
    {name: "street address", kind: "text", sources: [[EMP, ["Residence Address (Including Room/Apt #)"]], [W4, ["Address (Step 1a)"]],
      [I9, ["Address (Street Number and Name)", "Apt. Number (if any)"]], [HW4, ["Home address — number and street or rural route (Section A, line 3)"]],
      [HC5, ["Employee address"]]]},
    {name: "city", kind: "text", sources: [[EMP, ["City or Town"]], [I9, ["City or Town"]]]},
    {name: "state", kind: "text", sources: [[EMP, ["State"]], [I9, ["State"]]]},
    {name: "ZIP code", kind: "zip", sources: [[EMP, ["Zip Code"]], [I9, ["ZIP Code"]]]},
    {name: "city, state, and ZIP", kind: "text", sources: [[W4, ["City, state, and ZIP code (Step 1a)"]],
      [HW4, ["City or town, State, Postal/ZIP code (Section A, line 3)"]], [EMP, ["City or Town", "State", "Zip Code"]], [I9, ["City or Town", "State", "ZIP Code"]]]},
    {name: "SSN", kind: "ssn", sources: [[EMP, ["Social Security Number"]], [I9, ["U.S. Social Security Number"]],
      [W4, ["Social security number (Step 1b)"]], [HW4, ["Your social security number (Section A, line 2)"]]]},
    {name: "date of birth", kind: "date", sources: [[EMP, ["Date of Birth"]], [I9, ["Date of Birth (mm/dd/yyyy)"]]]},
    {name: "first name", kind: "name", sources: [[EMP, ["Name: First"]], [I9, ["First Name (Given Name)"]], [DD, ["Employee Name — First"]]]},
    {name: "last name", kind: "name", sources: [[EMP, ["Name: Last"]], [I9, ["Last Name (Family Name)"]], [W4, ["Last name (Step 1a)"]], [DD, ["Employee Name — Last"]]]},
    {name: "full name", kind: "name", sources: [[AGR, ["Employee name (You)"]], [HW4, ["Type or print your full name (Section A, line 1)"]],
      [HB, ["Print Name"]], [HC5, ["Print employee name"]], [EMP, ["Name: First", "Name: Last"]], [I9, ["First Name (Given Name)", "Last Name (Family Name)"]]]},
  ];

  // Format checks (the extraction's rules) and normalizers per kind.
  const digits = v => v.replace(/[\s()\-.]/g, "");
  const FORMAT_OK = {
    email: v => /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v.trim()),
    phone: v => /^\d{10}$/.test(digits(v)),
    ssn: v => /^\d{9}$/.test(digits(v)),
    zip: v => /^\s*\d{5}(\s*-\s*\d{4})?\s*$/.test(v),
    routing: v => /^\d{9}$/.test(digits(v)),
    date: v => parseDate(v) != null,
  };
  // Messages for a value that fails its field's format (same rules as the extractor).
  const FORMAT_MESSAGES = {email: "Not a valid email address.", phone: "Phone number must be 10 digits.",
    ssn: "SSN must be 9 digits.", zip: "ZIP code must be 5 digits (optionally +4).", routing: "Routing number must be 9 digits.",
    date: "Not a valid date — use a format like 3/15/2026."};
  const NO_DATE = /^(n\s*\/?\s*a|none|-+)$/i;  // e.g. an expiration date written "N/A"
  // null if the value is fine for the format (or empty, or the field has no format); else the message.
  function formatError(format, value) {
    const v = (value || "").trim();
    if (!v || !format || !FORMAT_OK[format] || (format === "date" && NO_DATE.test(v))) return null;
    return FORMAT_OK[format](v) ? null : FORMAT_MESSAGES[format];
  }
  // A field's format, from the catalog (passed by the web app) or the field itself.
  function formatOf(ctx, formName, fieldName) {
    const fromCatalog = ((ctx.options.formats || {})[formName] || {})[fieldName];
    if (fromCatalog) return fromCatalog;
    const form = (ctx.data.forms || []).find(f => f.form === formName);
    const f = form && form.fields.find(x => x.field === fieldName);
    return (f && f.format) || null;
  }

  // Live checking of value boxes: each box carries data-format; a red message appears under it and
  // every button marked data-needs-valid in the same panel is disabled while any visible box fails.
  function validateInputs(panel) {
    let bad = false;
    for (const input of panel.querySelectorAll("input.edit-value, input.other-value")) {
      const box = input.closest(".edit-box");
      const other = input.classList.contains("other-value") ? panel.querySelector('input[type="radio"][value="other"]') : null;
      const active = !(box && box.hidden) && (!other || other.checked);
      const message = active ? formatError(input.dataset.format, input.value) : null;
      const note = input.parentElement.querySelector(".input-error");
      if (note) { note.textContent = message || ""; note.hidden = !message; }
      input.classList.toggle("invalid", !!message);
      input.setAttribute("aria-invalid", message ? "true" : "false");
      if (message) bad = true;
    }
    for (const b of panel.querySelectorAll("[data-needs-valid]")) {
      if (bad) b.disabled = true;
      else if (b.dataset.needsValid === "input") b.disabled = false;
    }
    return !bad;
  }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  // Dates (same rules as the extractor): m/d/y, y-m-d, "Mar 1 2026", "March 1, 2026". Two-digit
  // years: 00-49 are 2000s, 50-99 are 1900s. Anything else (e.g. "March 1/2") isn't a date: never guessed.
  const TWO_DIGIT_PIVOT = 50;
  function parseDate(value) {
    const t = value.trim().toLowerCase();
    let m = t.match(/^(\d{1,2})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{2}|\d{4})$/), month, day, year;
    const iso = t.match(/^(\d{4})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{1,2})$/);
    if (m) [month, day, year] = [+m[1], +m[2], m[3]];
    else if (iso) [year, month, day] = [iso[1], +iso[2], +iso[3]];
    else {
      m = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[,\/ ]\s*(\d{2}|\d{4})$/);
      if (!m || MONTHS.indexOf(m[1].slice(0, 3)) < 0) return null;
      [month, day, year] = [MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2], m[3]];
    }
    if (year.length === 2) year = String(+year < TWO_DIGIT_PIVOT ? 2000 + +year : 1900 + +year);
    const d = new Date(+year, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  // The canonical way dates are stored and shown: M/D/YYYY, no leading zeros ("3/1/2026"); null if not a date.
  function canonicalDate(value) {
    const iso = parseDate(value || "");
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return `${m}/${d}/${y}`;
  }
  // A typed value as it's saved: dates become canonical (anything else unchanged).
  const normalizeTyped = (format, value) => format === "date" ? (canonicalDate(value) || value) : value;
  const NORMALIZE = {
    email: v => v.trim().toLowerCase(), phone: digits, ssn: digits, zip: digits, date: v => parseDate(v) || v,
    text: v => v.toLowerCase().replace(/[^0-9a-z]/g, ""),
    name: v => v.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(w => w.length > 1).sort().join(" "),
  };

  // {value, from: [forms]} when the other forms hold exactly one distinct valid value for the same
  // logical field (highOnly: only readings with high confidence, or ones the reviewer settled).
  function suggestionFor(ctx, formName, fieldName, highOnly = false) {
    const logical = LOGICAL_FIELDS.find(l => l.sources.some(([f, names]) => f === formName && names.length === 1 && names[0] === fieldName));
    if (!logical) return null;
    const ok = FORMAT_OK[logical.kind] || (() => true);
    const candidates = [];
    for (const [form, names] of logical.sources) {
      if (form === formName && names.includes(fieldName)) continue;
      const fields = names.map(n => currentField(ctx, form, n));
      if (!fields.every(f => hasValue(f) && f.value !== SIGNED)) continue;  // every part filled
      if (highOnly && !fields.every(f => f.confidence === "high" || f.review)) continue;
      const value = fields.map(f => f.value.trim()).join(" ");
      if (ok(value)) candidates.push({form, value, norm: NORMALIZE[logical.kind](value)});
    }
    const distinct = new Set(candidates.map(c => c.norm));
    if (distinct.size !== 1) return null;  // nothing found, or the forms disagree (that's a conflict)
    return {value: candidates[0].value, from: [...new Set(candidates.map(c => c.form))], kind: logical.kind, logical: logical.name};
  }
  // "Form I-9 and W-4"; badge "filled from I-9, W-4"
  const shortNoForm = name => shortName(name).replace(/^Form /, "");
  const foundOnLabel = forms => {
    const names = forms.map(shortName), allForm = names.every(n => n.startsWith("Form "));
    return listNames(allForm ? [names[0], ...names.slice(1).map(n => n.replace(/^Form /, ""))] : names);
  };
  const filledFromLabel = forms => `filled from ${forms.map(shortNoForm).join(", ")}`;

  // The value other forms suggest for a flagged field, by flag type (null: no suggestion):
  //   missing          one valid value elsewhere
  //   invalid          one valid value elsewhere that differs from this one
  //   low / medium     one value elsewhere, read with high confidence
  //   scribble         one valid value elsewhere
  // Never when the other forms' values are invalid or disagree with each other (the conflict path).
  function itemSuggestion(ctx, item) {
    if (!item || item.kind !== "field" || itemState(ctx, item) !== "open") return null;
    const {form: {form}, field: {field}} = item, tags = item.tags;
    if (tags.includes("missing") || tags.includes("scribble")) return suggestionFor(ctx, form, field);
    if (tags.includes("validation")) {
      const sug = suggestionFor(ctx, form, field), cur = currentField(ctx, form, field);
      return sug && NORMALIZE[sug.kind](sug.value) !== NORMALIZE[sug.kind](cur.value || "") ? sug : null;
    }
    if (tags.includes("low") || tags.includes("medium")) return suggestionFor(ctx, form, field, true);
    return null;
  }

  function suggestionCard(ctx, item, where) {
    const sug = itemSuggestion(ctx, item);
    if (!sug) return "";
    const attr = where === "sweep" ? 'data-sw-act="quickadd"' : 'data-act="quickadd"';
    return `<div class="suggestion" role="note"><span class="sg-icon" aria-hidden="true">&#8505;</span>
      <span class="sg-text"><span class="sg-head">AI found this on other forms:</span>
        Found on ${esc(foundOnLabel(sug.from))}: <b>'${esc(sug.value)}'</b></span>
      <button type="button" class="btn small info" ${attr} ${ctx.options.decisionsUrl ? "" : "disabled"}>Quick add</button></div>`;
  }

  function quickAddDecision(ctx, item, sug) {
    const from = sug.from.map(shortNoForm).join(", ");
    return {key: item.key, action: "edited", title: item.title, form: item.subtitle, value: sug.value, original: item.field.value,
            fields: [{form: item.form.form, field: item.field.field, value: sug.value}], filled_from: sug.from,
            note: `Filled ${item.field.field} on ${shortName(item.form.form)} from ${from}`};
  }

  // The severity category of a field row (same colors as the triage tiles), from its open item:
  // an open conflict it's part of wins; else its own item's most specific issue; else an open
  // required group it belongs to (missing). Resolved items and fine fields: null (white row).
  const FLAG_TAGS = {conflicting: "conflict", illegible_scribble: "scribble", invalid_value: "validation",
                     invalid_format: "validation", ambiguous_choice: "choice", missing: "choice"};
  function fieldCategory(ctx, formName, fieldName) {
    const open = i => !isResolved(ctx, i);
    if (ctx.items.some(i => i.kind === "conflict" && open(i) && i.sources.some(s => s.form === formName && s.fields.includes(fieldName)))) return "conflict";
    const own = ctx.items.find(i => i.kind === "field" && i.form.form === formName && i.field.field === fieldName);
    const tag = own && open(own) && MOST_SPECIFIC_FIRST.find(t => own.tags.includes(t));
    if (tag) return tag;
    const group = ctx.items.find(i => i.kind === "group" && open(i) && i.tags.length && i.form.form === formName && i.members.some(m => m.field === fieldName));
    return group ? "missing" : null;
  }

  // A field's pills: required/optional, confidence, issue flags (in their category colors), adjusted.
  function fieldPills(f, rule, titles = {}) {
    const tags = [...new Set(flagsOf(f).map(fl => FLAG_TAGS[fl]).filter(Boolean))];
    return `<span class="badge ${rule.cls}" title="${esc(rule.title)}">${esc(rule.badge)}</span>${
      f.confidence ? `<span class="badge conf-${f.confidence}" title="${CONFIDENCE_TITLES[f.confidence]}">${f.confidence} confidence</span>` : ""}${
      tags.map(t => categoryBadge(t).replace("<span ", `<span title="${esc(titles[t] || "")}" `)).join("")}${
      f.review && f.review.filledFrom ? `<span class="badge filled">${esc(filledFromLabel(f.review.filledFrom))}</span>`
        : f.review && f.review.adjusted ? '<span class="badge adjusted">adjusted</span>' : ""}`;
  }
  const fieldValueHtml = (f, rule) => f.value === SIGNED ? '<span class="v-signed" title="Signed">&#10003;</span>'
    : hasValue(f) ? esc(f.value) : f.page_missing ? '<span class="v-pagemissing" title="Its page is missing from the scan">page missing</span>'
    : `<span class="${rule.empty[1]}">${rule.empty[0]}</span>`;

  // "Ask the client" for a conflict or a flagged field (invalid, low/medium confidence, scribble,
  // unclear choice); blank fields go through "Yes, it's blank" instead.
  const CLARIFIABLE = ["validation", "scribble", "low", "medium", "choice"];
  const canClarify = (ctx, item) => itemState(ctx, item) === "open" &&
    (item.kind === "conflict" || (item.kind === "field" && item.tags.some(t => CLARIFIABLE.includes(t)) && !item.tags.includes("missing")));
  function clarifyRow(ctx, item) {
    if (!canClarify(ctx, item)) return "";
    return `<div class="clarify-row"><span>${item.kind === "conflict" ? "Can't tell from the scan — ask the client to clarify" : "Can't tell — ask the client to clarify"}</span>
      <button type="button" class="btn small" data-act="clarify" ${ctx.options.decisionsUrl ? "" : "disabled"}>Add to email</button></div>`;
  }

  // "From added page 9 · before: (blank)" for a field the added pages filled in or changed.
  const f_supplementNote = f => f && f.supplement
    ? `<p class="sm-note supplement-note">From added page ${esc(f.supplement.page)} · before: ${esc(f.supplement.previous || "(blank)")}</p>` : "";

  // A field's current value, adjusted note, badges, and validation reasons.
  function fieldValueBlock(ctx, item, cur) {
    const shown = cur.value === SIGNED ? '<span class="v-signed">&#10003; signed</span>'
                : hasValue(cur) ? esc(cur.value) : `<span class="${item.rule.empty[1]}">${item.rule.empty[0]}</span>`;
    const flagBadges = [...new Set(flagsOf(item.field).map(fl => FLAG_TAGS[fl]).filter(Boolean))].map(categoryBadge).join("");
    const errors = (ctx.data.validation_errors || []).filter(e => e.form === item.form.form && e.field === item.field.field);
    return `<div class="big-value">${shown}</div>
      ${adjustedLine(cur)}
      <div class="badge-row"><span class="badge ${item.rule.cls}">${esc(item.rule.badge)}</span>
        <span class="badge conf-${item.field.confidence}" title="${CONFIDENCE_TITLES[item.field.confidence] || ""}">${item.field.confidence} confidence</span>${flagBadges}</div>
      ${errors.map(e => `<p class="hint">${esc(e.reason)}</p>`).join("")}`;
  }

  // ===========================================================================
  // Contextual actions. Each item offers the actions that fit its issue:
  //   missing      "Is this field blank on the scanned form?"  Yes, it's blank (→ client email) | Enter the value
  //   conflict     Save selection (after picking a value or typing one), or Add to email (ask the client)
  //   low/medium   Confirm value | Correct value
  //   scribble     Enter value | Mark unreadable (→ client email)
  //   validation   Correct value | Accept as-is (logged as accepted despite the warning)
  //   requested    Enter received value (the client's answer arrived)
  // plus Skip. {input: true} actions take a typed value; others save directly.
  // question: asked above the buttons; toast: replaces the default toast text; note: kept in the log.
  // ===========================================================================
  function actionsFor(ctx, item) {
    if (item.kind === "conflict") return {primary: {label: "Save selection", conflict: true}};
    if (item.kind === "code") return {primary: {label: "Use this code", conflict: true}};
    if (itemState(ctx, item) === "requested") {
      return {primary: item.kind === "field" ? {label: "Save received value", input: true, received: true} : {label: "Mark received", action: "accepted"}};
    }
    const blank = {action: "confirmed_missing", toast: "Marked missing — added to the client email draft", toastExact: true};
    if (item.kind === "missing_form") return {question: "Is this form missing from the scan?", primary: {label: "Yes, it's missing", ...blank}};
    if (item.kind === "missing_page") {
      return {question: `Is page ${item.page.page} (${item.page.label}) missing from the scan?`,
              primary: {label: "Confirm page missing", ...blank},
              secondary: {label: "Page is actually there", action: "accepted", toast: "Page marked present — its fields are back in the queue", toastExact: true}};
    }
    if (item.kind === "unrecognized") return {primary: {label: "Confirm page reviewed", action: "accepted"}};
    if (item.kind === "group") {
      return item.tags.includes("missing") ? {question: "Are all of these blank on the scanned form?", primary: {label: "Yes, they're blank", ...blank}}
                                           : {primary: {label: "Confirm", action: "accepted"}};
    }
    const group = QUEUE_GROUPS[queueGroup(item)];
    if (group === "new") return {primary: {label: "Confirm value", action: "accepted"}, secondary: {label: "Correct value", input: true}};
    if (group === "missing") {
      return {question: "Is this field blank on the scanned form?", primary: {label: "Yes, it's blank", ...blank},
              secondary: {label: "Enter the value", input: true}};
    }
    if (group === "scribble") return {primary: {label: "Enter value", input: true}, secondary: {label: "Mark unreadable", action: "unreadable"}};
    if (group === "validation") {
      const flag = flagsOf(item.field).includes("invalid_format") ? "invalid format" : "invalid value";
      return {primary: {label: "Correct value", input: true},
              secondary: {label: "Accept as-is", action: "accepted", note: `Accepted as-is despite ${flag} warning`, toast: "Accepted as-is"}};
    }
    return {primary: {label: "Confirm value", action: "accepted"}, secondary: {label: "Correct value", input: true}};
  }

  const hasInput = spec => !!((spec.primary && spec.primary.input) || (spec.secondary && spec.secondary.input));

  // The action buttons (and, in the triage panel, Back / Next under them).
  function actionButtons(ctx, item, where, saved = {}) {
    const spec = actionsFor(ctx, item), canDecide = !!ctx.options.decisionsUrl;
    const conflictReady = saved.radio != null && (saved.radio !== "other" || (saved.other || "").trim());
    const chosen = (item.kind === "conflict" || item.kind === "code") && (conflictReady || (itemState(ctx, item) === "resolved" && saved.radio == null));
    const primaryOff = !canDecide || (spec.primary.conflict && !chosen);
    return `${suggestionCard(ctx, item, where)}${spec.question ? `<p class="action-question">${esc(spec.question)}</p>` : ""}<div class="actions">
        <button type="button" class="btn primary" data-act="primary" ${primaryOff ? "disabled" : ""}${
          spec.primary.input ? ' data-needs-valid="input"' : spec.primary.conflict ? ' data-needs-valid="conflict"' : ""}>${esc(spec.primary.label)}</button>
        ${spec.secondary ? `<button type="button" class="btn" data-act="secondary" ${canDecide ? "" : "disabled"}${
          spec.secondary.input ? ' data-needs-valid="input"' : ""}>${esc(spec.secondary.label)}</button>` : ""}
        <button type="button" class="btn ghost" data-act="skip" ${canDecide ? "" : "disabled"}>Skip</button>
      </div>${canDecide ? "" : '<p class="sub">Decisions are saved by the web app (python app.py).</p>'}
      ${where === "triage" ? `<div class="queue-nav">
        <button type="button" class="btn small" data-action="queue-step" data-step="-1">&#8249; Back</button>
        <span class="kbd-hint">&#8592; &#8594; to move · Enter for ${esc(spec.primary.label.toLowerCase())}</span>
        <button type="button" class="btn small" data-action="queue-step" data-step="1">Next &#8250;</button></div>` : ""}`;
  }

  // What's been decided about an item, in a line.
  function decisionLine(ctx, item) {
    const d = decisionOf(ctx, item), state = itemState(ctx, item);
    if (!d) return "";
    const when = t => new Date(t).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
    const pick = item.kind === "conflict" ? " · pick the confirmed value below when they reply"
               : d.action === "clarify" ? " · enter the value below when they reply" : "";
    if (state === "requested") return `<div class="decision-status awaiting">${d.action === "clarify" ? "Awaiting client clarification" : "Awaiting client"} · ${
      d.sent ? `email sent ${when(d.sent)} · ${waitingText(d.sent)}` : `requested ${when(d.requested)} · draft not yet sent`}${pick}</div>`;
    if (state === "needs_client") return `<div class="decision-status needs-client">${
      {unreadable: "Marked unreadable", clarify: "Awaiting client clarification"}[d.action] || "Confirmed missing"} · goes in the client email${pick}</div>`;
    if (state === "resolved") return `<div class="decision-status accepted">${d.filled_from ? `Filled from ${esc(d.filled_from.map(shortNoForm).join(", "))}`
      : d.action === "edited" ? "Corrected" : "Confirmed"}${d.value ? `: ${esc(d.value)}` : ""} · ${when(d.time)}</div>`;
    if (ctx.invalidKeys.has(item.key)) return `<div class="decision-status needs-client">Saved value fails its format check · ${when(d.time)}</div>`;
    return `<div class="decision-status skipped">Skipped · ${when(d.time)}</div>`;
  }

  // An item's explanation, value, and inputs (shared by the triage panel and the viewer sidebar).
  //   where: "triage" (value input hidden until an Enter/Correct action asks for it) or "viewer" (shown)
  function itemBody(ctx, item, {where, entry = {}, saved = {}}) {
    let body = decisionLine(ctx, item);
    if (item.kind === "conflict") {
      const chips = [...new Set(item.sources.map(s => s.name))].map(n => `<span class="form-chip">${esc(n)}</span>`).join("");
      const shown = where === "viewer" ? item.sources[entry.sourceIndex] : null;
      body += `
        <div class="forms-involved"><span class="mini-label">Forms involved</span><div class="chips">${chips}</div></div>
        <p class="detail-explain">${esc(item.summary)} ${item.conflict.majority == null
          ? "No majority: the values disagree with each other, so check each one against the scan."
          : `The most common value is '${esc(item.conflict.majority)}'.`}</p>
        <p class="disclaimer">* The most common value is not necessarily the correct one.</p>
        ${shown ? `<div class="sm-value-label">This page (${esc(shown.name)}) reads</div><div class="big-value">${esc(shown.value)}</div>
          ${shown.differs ? '<p class="sm-note highlight">This value differs from the most common value.</p>' : ""}` : ""}
        ${conflictOptions(ctx, item, `${where}-choice`, saved, shown ? entry.sourceIndex : -1)}
        ${clarifyRow(ctx, item)}`;
    } else if (item.kind === "field") {
      const cur = currentField(ctx, item.form.form, item.field.field);
      const spec = actionsFor(ctx, item);
      const prefill = saved.edit != null ? saved.edit : hasValue(cur) && cur.value !== SIGNED ? cur.value : "";
      body += `${fieldValueBlock(ctx, item, cur)}
        ${f_supplementNote(cur)}
        ${hasInput(spec) ? `<div class="edit-box" ${where === "triage" && !spec.primary.received ? "hidden" : ""}><label>${esc(spec.primary.received ? "Value the client sent" : (spec.primary.input ? spec.primary : spec.secondary).label)}
          <input type="text" class="edit-value" placeholder="Type the correct value" value="${esc(prefill)}"
            data-format="${esc(formatOf(ctx, item.form.form, item.field.field) || "")}"><span class="input-error" hidden></span></label></div>` : ""}
        ${clarifyRow(ctx, item)}`;
    } else if (item.kind === "code") {
      const d = decisionOf(ctx, item), chosen = d && RESOLVED.has(d.action) ? d.value : null;
      const client = (ctx.options.codes.client || {}).name || "this client";
      body += `<p class="detail-explain">"${esc(item.value)}" (${esc(shortName(item.from.form))}, ${esc(item.from.field)}) matches no PrismHR ${
          esc(item.check.label)} for ${esc(client)}. Pick the code to use, or correct the value on the form.</p>
        <fieldset class="options"><legend>PrismHR ${esc(item.check.label)}</legend>${Object.entries(item.choices).map(([code, desc]) => `
          <label class="option"><input type="radio" name="${where}-code" value="${esc(code)}" ${(saved.radio != null ? saved.radio === code : chosen === code) ? "checked" : ""}>
            <span><b>${esc(code)}</b><span class="opt-value">${esc(desc)}</span></span></label>`).join("")}</fieldset>`;
    } else if (item.kind === "group") {
      const fields = item.form.fields, satisfied = groupSatisfied(item.title, fields);
      const cur = name => currentField(ctx, item.form.form, name);
      body += `<div class="badge-row"><span class="badge required">required: pick one</span>${
          satisfied ? '<span class="badge conf-high">requirement met</span>' : '<span class="badge cat-badge cat-missing">&#9675; missing</span>'}</div>
        <p class="detail-explain">${satisfied ? "One of these is required, and it's filled in:" : "One of these is required, and none is filled in:"}</p>
        <ul class="members">${item.members.map(m => {
          const f = cur(m.field), filled = hasValue(f);
          return `<li class="${filled ? "member-on" : "member-off"}">${filled ? "&#9745;" : "&#9744;"} ${esc(m.label || m.field)}${
            filled && f.value !== "checked" ? `: <b>${esc(f.value)}</b>` : ""}</li>`;
        }).join("")}</ul>`;
    } else if (item.kind === "missing_form") {
      body += `<p class="detail-explain">This required form isn't in the packet. Confirming it as missing adds it to the client email.</p>`;
    } else if (item.kind === "missing_page") {
      const n = item.page.fields;
      body += `<p class="detail-explain">Page ${item.page.page} (${esc(item.page.label)}) appears to be missing from the scan: the packet has
        fewer pages of this form than expected, and all ${n} field${n === 1 ? "" : "s"} on that page came back empty.
        Confirming adds "please resend the ${esc(item.page.label.toLowerCase())}" to the client email.</p>`;
    } else if (item.kind === "unrecognized") {
      body += `<p class="detail-explain">This page didn't match any form in the catalog. Check whether it belongs in the packet, and which form it is.</p>`;
    }
    return body;
  }

  function renderDetail(ctx, item) {
    const group = `detail::${item.key}`;
    const entries = itemEntries(ctx, item).filter(e => e.image);
    entries.forEach(e => addSource(ctx, group, e));
    const thumb = entries.length ? `
      <figure class="detail-thumb">
        <button type="button" class="source-open" data-group="${esc(group)}" data-index="0" title="Click to enlarge">
          <img src="${esc(entries[0].image)}" alt="Source page"></button>
        <figcaption>${esc(entries[0].caption)}</figcaption></figure>` : "";
    return `
      <div class="detail-card" data-key="${esc(item.key)}">
        <h3 class="detail-title">${esc(item.title)}</h3>${item.kind === "conflict" ? "" : `<p class="sub">${esc(item.subtitle)}</p>`}
        ${itemBody(ctx, item, {where: "triage"})}${thumb}
        ${actionButtons(ctx, item, "triage")}
      </div>`;
  }

  // The decision to save for an item, from the inputs in a panel (triage detail or viewer sidebar).
  // correction: use the typed value. Returns null if a needed value is missing.
  function buildDecision(ctx, item, action, panel, correction = false) {
    const base = {key: item.key, action, title: item.title, form: item.subtitle, value: "", original: "", fields: []};
    if (action !== "accepted") {  // skipped, confirmed_missing, unreadable: nothing changes
      if (item.kind === "field") base.original = currentField(ctx, item.form.form, item.field.field).value || "";
      return base;
    }
    if (item.kind === "code") {  // the PrismHR code to use for a value that matched none
      const choice = panel.querySelector('input[type="radio"]:checked');
      const d = decisionOf(ctx, item);
      base.value = choice ? choice.value : d && RESOLVED.has(d.action) ? d.value : "";
      if (!base.value) return null;
      base.original = item.value;
      return base;
    }
    if (item.kind === "conflict") {
      const choice = panel.querySelector('input[type="radio"]:checked');
      const d = decisionOf(ctx, item);
      let value;
      if (!choice) {
        if (!d || !RESOLVED.has(d.action)) return null;
        value = d.value;  // re-saving an earlier selection
      } else if (choice.value === "other") {
        value = normalizeTyped(formatOf(ctx, item.sources[0].form, item.sources[0].fields[0]), panel.querySelector(".other-value").value.trim());
        if (!value) return null;
        base.action = "edited";
      } else {
        value = item.sources[+choice.value].value;
      }
      base.value = value;
      base.original = item.conflict.majority || Object.values(item.conflict.values).join(" / ");
      // The chosen value applies to every single-field reading in the conflict.
      base.fields = item.sources.filter(s => s.fields.length === 1).map(s => ({form: s.form, field: s.fields[0], value}));
      return base;
    }
    if (item.kind === "field") {
      const original = item.field.value;
      const value = correction ? normalizeTyped(formatOf(ctx, item.form.form, item.field.field), panel.querySelector(".edit-value").value.trim())
                               : currentField(ctx, item.form.form, item.field.field).value;
      if (correction && !value) return null;
      base.value = value;
      base.original = original;
      if (value !== original) base.action = "edited";
      base.fields = [{form: item.form.form, field: item.field.field, value}];
      return base;
    }
    return base;  // group, missing form, unrecognized page: acknowledged
  }

  // ---------- doing an action: save, toast with Undo, move on ----------
  const VERBS = {accepted: "Confirmed", edited: "Saved", skipped: "Skipped", confirmed_missing: "Confirmed missing", unreadable: "Marked unreadable"};

  function performAction(container, item, act, panel, where) {
    const ctx = container._ctx;
    if (act === "quickadd") return quickAdd(container, item, where);
    const spec = act === "skip" ? {action: "skipped"}
               : act === "blank" ? {action: "confirmed_missing", toast: "Marked missing — added to the client email draft", toastExact: true}
               : act === "clarify" ? {action: "clarify", toast: `Added to the client email — asking to clarify ${item.kind === "conflict" ? `the ${conflictNoun(item.conflict)}` : item.title}`, toastExact: true}
               : actionsFor(ctx, item)[act];
    if (!spec) return;
    const wasRequested = itemState(ctx, item) === "requested";
    let decision;
    if (spec.input) {
      const box = panel.querySelector(".edit-box"), input = panel.querySelector(".edit-value");
      if (box && box.hidden) {  // first click shows the value box
        box.hidden = false;
        panel.querySelector(`[data-act="${act}"]`).textContent = "Save value";
        validateInputs(panel);
        return input.focus();
      }
      if (!validateInputs(panel)) return input.focus();
      // "Enter the value" with nothing typed yet: wait for the value ("Yes, it's blank" is the other button).
      if (!input.value.trim() && item.tags.includes("missing") && itemState(ctx, item) === "open") return input.focus();
      if (!input.value.trim() && item.kind === "field") {
        // Empty: a required field goes down the missing path; an optional one may be left blank.
        if (item.rule.cls === "required") return performAction(container, item, "blank", panel, where);
        decision = {...buildDecision(ctx, item, "skipped", panel), action: "edited", value: "",
                    fields: [{form: item.form.form, field: item.field.field, value: ""}]};
      } else {
        decision = buildDecision(ctx, item, "accepted", panel, true);
        if (!decision) return input.focus();
      }
    } else if (spec.conflict) {
      if (!validateInputs(panel)) return panel.querySelector(".other-value").focus();
      decision = buildDecision(ctx, item, "accepted", panel);
      if (!decision) return (panel.querySelector(".other-value") || panel).focus();
    } else {
      decision = buildDecision(ctx, item, spec.action, panel);
    }
    if (spec.note) decision.note = spec.note;
    const order = triageQueue(ctx).map(i => i.key);
    panel.querySelectorAll("[data-act]").forEach(b => { b.disabled = true; });
    saveDecision(ctx, decision).then(() => {
      const verb = wasRequested && RESOLVED.has(decision.action) ? "Received"
                 : spec.conflict && decision.action === "accepted" ? "Saved selection" : VERBS[decision.action];
      const asSaved = (spec.input || spec.conflict) && decision.value && parseDate(decision.value) ? ` as ${decision.value}` : "";  // dates come back canonical
      showToast(container, spec.toastExact ? spec.toast : spec.toast ? `${spec.toast} — ${item.title}` : `${verb}${asSaved} — ${item.title}`, item.key);
      // Auto-advance: the next item in the queue (as it was ordered) that still needs attention.
      const at = order.indexOf(item.key);
      const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].map(k => ctx.items.find(i => i.key === k))
        .find(i => i && itemState(ctx, i) === "open" && (decisionOf(ctx, i) || {}).action !== "skipped" && needsAttention(i));
      if (where === "viewer") return viewerAdvance(container, item);
      if (where === "sweep") { draw(container); return renderSweep(); }
      if (next) ctx.state.selected = next.key;
      writeHash(ctx);
      draw(container);
    }).catch(err => { panel.querySelectorAll("[data-act]").forEach(b => { b.disabled = false; }); alert(err.message); });
  }

  // Quick add: fill a missing field from the other forms (format-checked), toast, move on.
  function quickAdd(container, item, where) {
    const ctx = container._ctx, sug = itemSuggestion(ctx, item);
    if (!sug) return;
    if (FORMAT_OK[sug.kind] && !FORMAT_OK[sug.kind](sug.value)) return alert(`'${sug.value}' doesn't pass the ${sug.kind} format check.`);
    const order = triageQueue(ctx).map(i => i.key);
    saveDecision(ctx, quickAddDecision(ctx, item, sug)).then(() => {
      showToast(container, `Filled from ${sug.from.map(shortNoForm).join(", ")} — ${item.title}`, item.key);
      const at = order.indexOf(item.key);
      const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].map(k => ctx.items.find(i => i.key === k))
        .find(i => i && itemState(ctx, i) === "open" && (decisionOf(ctx, i) || {}).action !== "skipped" && needsAttention(i));
      if (where === "viewer") return viewerAdvance(container, item);
      if (where === "sweep") { draw(container); return renderSweep(); }
      if (next) ctx.state.selected = next.key;
      writeHash(ctx);
      draw(container);
    }).catch(err => alert(err.message));
  }

  // Toast: "✓ Confirmed — Field" with Undo, for 5 seconds.
  function showToast(container, message, key) {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.setAttribute("role", "status");
      document.body.appendChild(toast);
    }
    clearTimeout(toast._timer);
    toast.innerHTML = `<span>&#10003; ${esc(message)}</span>${key ? '<button type="button" class="toast-undo">Undo</button>' : ""}`;
    toast.classList.add("show");
    const undo = toast.querySelector(".toast-undo");
    if (undo) undo.addEventListener("click", () => undoDecision(container, key));
    toast._timer = setTimeout(() => toast.classList.remove("show"), 5000);
  }

  function undoDecision(container, key) {
    const ctx = container._ctx, item = ctx.items.find(i => i.key === key) || {title: key, subtitle: ""};
    document.getElementById("toast").classList.remove("show");
    saveDecision(ctx, {key, action: "cleared", title: item.title, form: item.subtitle, value: "", original: "", fields: []}).then(() => {
      ctx.state.selected = key;
      const modal = document.getElementById("source-modal");
      if (modal && modal.classList.contains("open") && ctx.items.some(i => i.key === key)) return showItemInViewer(container, ctx.items.find(i => i.key === key));
      writeHash(ctx);
      draw(container);
      const sweep = document.getElementById("sweep");
      if (sweep && sweep.classList.contains("open")) renderSweep();
    });
  }

  // Conflicts: typing a value picks "Enter another value"; "Save selection" is enabled once something is picked.
  function syncConflictChoice(panel, e) {
    if (e && e.target.classList.contains("other-value")) {
      const other = panel.querySelector('input[type="radio"][value="other"]');
      if (other) other.checked = true;
    }
    const valid = validateInputs(panel);
    const choice = panel.querySelector('input[type="radio"]:checked');
    const button = panel.querySelector('[data-act="primary"]');
    if (!choice || !button || !panel.querySelector(".options")) return;
    button.disabled = !valid || (choice.value === "other" && !panel.querySelector(".other-value").value.trim());
  }

  // Enter: the action that takes the typed value if the reviewer is typing, else the primary action.
  function enterAction(panel, ctx) {
    let button = panel.querySelector('[data-act="primary"]');
    if (document.activeElement && document.activeElement.matches(".edit-value")) {
      const key = panel.dataset.key || (panel.closest("[data-key]") || {dataset: {}}).dataset.key;
      const item = ctx.items.find(i => i.key === key);
      const spec = item && actionsFor(ctx, item);
      if (spec && spec.secondary && spec.secondary.input) button = panel.querySelector('[data-act="secondary"]');
    }
    if (button && !button.disabled) button.click();
  }

  // ===========================================================================
  // All Forms: one form at a time, every field, with an optional side-by-side view of its pages.
  // ===========================================================================
  // One plain-language note per conflict this field is part of: what the other forms say,
  // or the reviewer's choice once the conflict is resolved.
  function conflictNotes(ctx, formName, fieldName) {
    const notes = [];
    for (const c of ctx.data.conflicts || []) {
      const mine = Object.entries(c.fields || {}).find(([label, names]) =>
        (label === formName || label.startsWith(formName + " — ")) && names.includes(fieldName));
      if (!mine) continue;
      const d = ctx.decisions[`conflict::${c.field}`];
      if (d && RESOLVED.has(d.action)) { notes.push(`${c.field} conflict resolved: you set "${d.value}"`); continue; }
      const myLabel = mine[0], differs = c.differs || [];
      const others = Object.entries(c.values).filter(([label]) => label !== myLabel);
      if (c.majority == null) {
        notes.push(`${c.field}: ` + others.map(([label, v]) => `${shortForm(label)} says "${v}"`).join("; "));
      } else if (differs.includes(myLabel)) {
        notes.push(`${c.field}: differs from the most common value, "${c.majority}"`);
      } else {
        notes.push(`${c.field}: matches the most common value, but ` +
          others.filter(([label]) => differs.includes(label)).map(([label, v]) => `${shortForm(label)} says "${v}"`).join("; "));
      }
    }
    return notes;
  }

  // "AI read: X → You set: Y" for a field the reviewer changed.
  const adjustedLine = f => f.review && f.review.filledFrom
    ? `<div class="adjusted-note filled-note"><span class="badge filled">${esc(filledFromLabel(f.review.filledFrom))}</span> ${
        f.review.original ? `AI read: ${esc(f.review.original)} → filled with ${esc(f.review.value)}` : `Blank on this form · filled with ${esc(f.review.value)}`}</div>`
    : f.review && f.review.adjusted
    ? `<div class="adjusted-note"><span class="badge adjusted">adjusted</span> AI read: ${esc(f.review.original || "(blank)")} → You set: ${esc(f.review.value || "(blank)")}</div>` : "";

  function renderAllForms(ctx) {
    const forms = reviewedForms(ctx.effective);
    if (!forms.some(f => f.form === ctx.state.formsForm)) ctx.state.formsForm = forms[0].form;
    const form = forms.find(f => f.form === ctx.state.formsForm);
    const number = forms.indexOf(form) + 1;
    let main;
    if (form.status === "missing") {
      main = `<section class="card form-view missing-form"><div class="form-view-head"><h2>${number}. ${esc(form.form)}</h2></div>
        <div class="form-alert" role="status"><span class="fa-icon" aria-hidden="true">&#9888;</span><a href="#triage" class="cat-text cat-missing"
          data-action="review-in-triage" data-key="${esc(`form::${form.form}`)}">Required form not in this packet</a></div></section>`;
    } else if (form.status === "not_applicable") {
      main = `<section class="card form-view na-form"><h2>${number}. ${esc(form.form)}</h2>
        <p class="summary">Not applicable: not in this packet. ${esc(form.note || "This form is conditional.")}</p></section>`;
    } else {
      main = renderFormView(ctx, form, number);
    }
    return `${sweepEntryCard(ctx)}<div class="forms-grid">${renderFormList(ctx, form.form, false, "pick-form")}<div class="forms-main">${main}</div></div>`;
  }

  // One alert strip per form: "⚠ 4 required fields empty · 2 conflicts · 1 validation error · …",
  // each segment in its severity color and linking to Triage (that category, this form);
  // or a green "✓ All clear". Live: reviewed values and decisions count.
  function formAlertStrip(ctx, formName, emptyRequired, missingPages = []) {
    const {counts} = openCounts(ctx, formName);
    const link = (tag, text) => `<a href="#triage" class="cat-text cat-${tag}" data-action="goto-filter" data-tag="${tag}" data-form="${esc(formName)}">${text}</a>`;
    const segments = missingPages.map(p => `<a href="#triage" class="cat-text cat-missing" data-action="review-in-triage"
      data-key="${esc(pageKey(formName, p.page))}">${esc(p.label)} missing</a>`);
    if (emptyRequired) segments.push(link("missing", `${emptyRequired} required field${emptyRequired === 1 ? "" : "s"} empty`));
    for (const c of CATEGORIES.filter(c => counts[c.tag] && !["missing", "medium"].includes(c.tag))) {
      segments.push(link(c.tag, `${counts[c.tag]} ${counts[c.tag] === 1 ? c.one : c.many}`));
    }
    return segments.length
      ? `<div class="form-alert" role="status"><span class="fa-icon" aria-hidden="true">&#9888;</span>${segments.join('<span class="sep">·</span>')}</div>`
      : '<div class="form-alert clear" role="status"><span class="fa-icon" aria-hidden="true">&#10003;</span>All clear</div>';
  }

  function renderFormView(ctx, form, number) {
    const fields = form.fields;  // reviewed values in place (ctx.effective)
    const {required} = requirementItems(fields);
    // Fields on a missing page are counted by the page, not as empty required fields.
    const emptyRequired = requirementItems(fields.filter(f => !f.page_missing)).required.filter(done => !done).length;
    const missingPages = form.missing_pages || [];
    const pageBanners = missingPages.map(p => `<div class="banner page-banner">Page ${p.page} (${esc(p.label)}) appears to be missing from the scan —
      ${p.fields} field${p.fields === 1 ? "" : "s"} couldn't be extracted because ${p.fields === 1 ? "its" : "their"} page is absent.</div>`).join("");
    const errors = ctx.data.validation_errors || [];
    const rows = fields.map(f => {
      const rule = fieldRule(f, fields);
      const notes = conflictNotes(ctx, form.form, f.field);
      const reasons = errors.filter(e => e.form === form.form && e.field === f.field).map(e => e.reason);
      const value = fieldValueHtml(f, rule);
      const cat = fieldCategory(ctx, form.form, f.field);
      // All Forms is read-only: flagged fields link to their item in Triage, where decisions are made.
      const {item} = itemFor(ctx, form.form, f.field);
      const review = cat && item && itemState(ctx, item) === "open"  // every flagged row, and only those
        ? `<a href="#triage/${encodeURIComponent(item.key)}" class="review-link" data-action="review-in-triage" data-key="${esc(item.key)}">Review in triage &#8594;</a>` : "";
      return `<tr class="field${f.review && f.review.adjusted ? " adjusted" : ""}${cat ? ` row-cat cat-${cat}` : ""}">
        <td class="name">${esc(f.field)}<div class="field-pills">${fieldPills(f, rule, {conflict: notes.join(" "), validation: reasons.join(" ")})}${
          sweepVerified(ctx, {form: form.form, field: f.field}) && !(f.review && f.review.adjusted) ? '<span class="badge conf-high">&#10003; verified</span>' : ""}</div></td>
        <td class="value">${value}${adjustedLine(f)}${notes.map(n => `<div class="conflict-note">&#8800; ${esc(n)}</div>`).join("")}${
          review ? `<div class="source-row">${review}</div>` : ""}</td></tr>`;
    }).join("");
    const pages = (form.pages || []).map(n => (ctx.data.pages || []).find(p => p.page === n)).filter(p => p && p.image);
    const showPages = pages.length > 0;  // always beside the table
    const pageGroup = `pages::${form.form}`;
    const pageColumn = showPages ? `<aside class="page-column">${pages.map(p => {
      const index = addSource(ctx, pageGroup, {image: ctx.imageBase + p.image, caption: `${form.form} — page ${p.page}`, page: p.page, form: form.form});
      return `<figure><figcaption>Page ${p.page}</figcaption><button type="button" class="source-open" data-group="${esc(pageGroup)}"
        data-index="${index}" title="Open page ${p.page}"><img src="${esc(ctx.imageBase + p.image)}" alt="Page ${p.page}"></button></figure>`;
    }).join("")}</aside>` : "";
    return `<section class="card form-view">
      <div class="form-view-head"><h2>${number}. ${esc(form.form)}</h2></div>
      ${pageBanners}${formAlertStrip(ctx, form.form, emptyRequired, missingPages)}
      <p class="summary">${fields.filter(hasValue).length} of ${fields.length} fields have values (${required.length} required)</p>
      <div class="${showPages ? "split-view" : ""}">
        <div class="field-table"><table><tr><th>Field</th><th>Value</th></tr>${rows}</table></div>${pageColumn}
      </div></section>`;
  }

  // ===========================================================================
  // Activity: every decision as a timeline, newest first, grouped by day. Edits show
  // "old → new"; quick-adds say where the value came from; one email save is one entry.
  // ===========================================================================
  const ACTIVITY_VERBS = {accepted: "Confirmed", edited: "Edited", skipped: "Skipped", confirmed_missing: "Marked missing",
    unreadable: "Marked unreadable", clarify: "Asked client to clarify", requested: "Requested from client",
    received: "Received from client", undone: "Undid", email_sent: "Sent client email"};
  const ACTIVITY_TONE = {accepted: "good", edited: "edit", received: "good", skipped: "muted", undone: "muted",
    confirmed_missing: "client", unreadable: "client", clarify: "client", requested: "client", email_sent: "client"};

  function activityEntry(ctx, a) {
    const kind = a.key.split("::")[0];
    let verb = ACTIVITY_VERBS[a.action] || a.action, detail = "";
    const val = v => `<span class="act-value">${esc(v || "(blank)")}</span>`;
    if (kind === "sweep" && a.action === "skipped") verb = "Checked in sweep";
    else if (kind === "page_missing" && a.action === "accepted") verb = "Marked page present";
    else if (kind === "page" && a.action === "accepted") verb = "Reviewed page";
    else if (kind === "form" && a.action === "confirmed_missing") verb = "Confirmed form missing";
    if (a.action === "email_sent") detail = `Marked sent · ${a.count || 0} requested item${a.count === 1 ? "" : "s"} stamped`;
    else if (a.action === "undone") detail = `Undid “${esc(ACTIVITY_VERBS[a.undid] || a.undid || "decision")}”`;
    else if (a.filled_from && a.filled_from.length) {
      verb = "Filled";
      detail = `Filled ${esc(a.title)} on ${esc(shortName(a.form))} from ${esc(a.filled_from.map(shortNoForm).join(", "))}: ${val(a.value)}`;
    } else if (a.action === "edited" || (a.action === "received" && a.value !== a.original)) {
      detail = `${val(a.original)} <span class="act-arrow">&#8594;</span> ${val(a.value)}`;
    } else if (a.action === "accepted" && /^Accepted as-is/.test(a.note || "")) {
      verb = "Accepted as-is";
      detail = `${esc(a.note)}: ${val(a.value)}`;  // "Accepted as-is despite invalid value warning"
    } else if (a.action === "accepted" && kind === "conflict") detail = `Chose ${val(a.value)}`;
    else if (a.action === "accepted" && a.value) detail = val(a.value);
    if (a.note && !a.filled_from && !/^Accepted as-is/.test(a.note)) detail += `${detail ? " · " : ""}<span class="act-note">${esc(a.note)}</span>`;
    const item = ctx.items.find(i => i.key === (kind === "sweep" ? `field::${a.key.slice(7)}` : a.key));
    const link = item && needsAttention(item)
      ? `<a href="#triage/${encodeURIComponent(item.key)}" data-action="review-in-triage" data-key="${esc(item.key)}">Go to item &#8594;</a>` : "";
    return {verb, detail, link, tone: ACTIVITY_TONE[a.action] || "muted"};
  }

  function renderActivity(ctx) {
    const log = (ctx.activity || []).slice().reverse();
    if (!log.length) return `<section class="card"><h2>Timeline</h2><p class="summary">No decisions yet. Everything you confirm, edit, skip, or send to the client shows up here.</p></section>`;
    // One email save marks many items "requested" at once: show it as one entry.
    const rows = [];
    for (const a of log) {
      const last = rows[rows.length - 1];
      if (a.action === "requested" && last && last.batch && last.batch === (a.batch || a.time)) { last.items.push(a); continue; }
      rows.push(a.action === "requested" ? {batch: a.batch || a.time, time: a.time, items: [a]} : a);
    }
    const day = t => new Date(t).toLocaleDateString(undefined, {weekday: "short", month: "short", day: "numeric"});
    const clock = t => new Date(t).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
    let html = "", lastDay = "";
    for (const r of rows) {
      if (day(r.time) !== lastDay) { lastDay = day(r.time); html += `<li class="act-day">${esc(lastDay)}</li>`; }
      if (r.items) {
        html += `<li class="act-row tone-client"><time>${clock(r.time)}</time><span class="act-dot"></span><div class="act-main">
          <div><span class="act-verb">Saved client email</span> <b>${r.items.length} item${r.items.length === 1 ? "" : "s"} requested</b></div>
          <details class="act-batch"><summary>Show items</summary><ul>${r.items.map(i => `<li>${esc(i.title)} <small>${esc(i.form)}</small></li>`).join("")}</ul></details></div></li>`;
        continue;
      }
      const e = activityEntry(ctx, r);
      html += `<li class="act-row tone-${e.tone}"><time>${clock(r.time)}</time><span class="act-dot"></span><div class="act-main">
        <div><span class="act-verb">${esc(e.verb)}</span> <b>${esc(r.title || r.key)}</b> <small>${esc(r.form)}</small></div>
        ${e.detail ? `<div class="act-detail">${e.detail}</div>` : ""}</div>${e.link}</li>`;
    }
    return `<section class="card activity"><h2>Timeline</h2><p class="summary">${log.length} entr${log.length === 1 ? "y" : "ies"}, newest first. Saved with the packet.</p>
      <ol class="act-list">${html}</ol></section>`;
  }

  // ===========================================================================
  // Render + interactions
  // ===========================================================================
  // Page header for each tab: kicker, title, and what the screen is for.
  const TAB_HEADERS = {
    triage: ["Step 1 — Triage", "Triage", "Work through everything the AI flagged (conflicts, invalid values, scribbles, low-confidence reads, missing fields) until the queue is empty."],
    forms: ["Reference", "All forms", "Browse each catalog form field by field beside its scanned pages, to check context without changing anything."],
    review: ["Final step — Review & export", "Review & export", "Confirm nothing is left open, send the client one email for what's missing, then download the reviewed data and PrismHR payload."],
    activity: ["Audit trail", "Activity", "A timestamped record of every decision on this packet, from confirmations and edits to client requests and replies."],
  };
  const tabHeader = tab => TAB_HEADERS[tab] ? `<header class="page-header tab-header"><div class="kicker">${esc(TAB_HEADERS[tab][0])}</div>
    <h1>${esc(TAB_HEADERS[tab][1])}</h1><p class="lede">${esc(TAB_HEADERS[tab][2])}</p></header>` : "";

  // One-line stage banners above each tab; dismissing one hides it for good (in this browser).
  const STAGE_BANNERS = {
    triage: "Step 1 — Resolve each flagged item below. Nothing leaves this queue until you act on it.",
    forms: "Reference — browse the full packet. Read-only; flagged items link to Triage.",
    review: "Final step — confirm everything below is resolved, then email and export.",
  };
  const BANNER_STORE = "packetReview.dismissedBanners";
  const dismissedBanners = () => { try { return JSON.parse(localStorage.getItem(BANNER_STORE)) || []; } catch { return []; } };
  function stageBanner(tab) {
    if (!STAGE_BANNERS[tab] || dismissedBanners().includes(tab)) return "";
    return `<div class="stage-banner" role="note"><span>${esc(STAGE_BANNERS[tab])}</span>
      <button type="button" class="stage-dismiss" data-action="dismiss-banner" data-tab="${tab}" aria-label="Dismiss">&#10005;</button></div>`;
  }

  // The packet's status for the home screen's list, saved whenever it changes.
  function packetSummary(ctx) {
    const attention = ctx.items.filter(needsAttention), open = unresolvedItems(ctx).length;
    const sweep = sweepFields(ctx), swept = sweep.filter(x => sweepVerified(ctx, x)).length;
    const awaiting = ctx.items.filter(i => ["needs_client", "requested"].includes(itemState(ctx, i))).length;
    const progress = Math.round(100 * (attention.length - open + swept) / Math.max(1, attention.length + sweep.length));
    if (open) return {status: "In triage", detail: `${open} item${open === 1 ? "" : "s"} left`, progress};
    if (swept < sweep.length) return {status: "In verification sweep", detail: `${swept} of ${sweep.length}`, progress};
    if (awaiting) return {status: "Awaiting client", detail: lastSent(ctx) ? `email sent · ${waitingText(lastSent(ctx))}` : "email not sent yet", progress};
    return {status: "Ready to export", detail: "all items resolved", progress};
  }
  function saveSummary(ctx) {
    if (!ctx.options.summaryUrl) return;
    const body = JSON.stringify(packetSummary(ctx));
    if (body === ctx.summarySent) return;
    ctx.summarySent = body;
    fetch(ctx.options.summaryUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body}).catch(() => { ctx.summarySent = null; });
  }

  function draw(container) {
    const ctx = container._ctx;
    // Saved values are re-checked against their formats every time; a failing decision loses its
    // resolved status and its item comes back to Triage flagged invalid.
    // Only values the reviewer typed or filled in count; "Accept as-is" is a deliberate override.
    ctx.invalidKeys = new Set(Object.values(ctx.decisions).filter(d => (d.action === "edited" || d.filled_from) &&
      (d.fields || []).some(o => formatError(formatOf(ctx, o.form, o.field), o.value))).map(d => d.key));
    ctx.items = buildItems(ctx);  // decisions can change items (e.g. a "missing" page that's actually there)
    ctx.effective = effectiveData(ctx.data, ctx.decisions);
    ctx.groups = new Map();
    const stats = packetStats(ctx);
    const tab = ctx.state.tab;
    const body = tab === "triage" ? renderTriage(ctx)
               : tab === "forms" ? renderAllForms(ctx)
               : tab === "review" ? renderReview(ctx)
               : renderActivity(ctx);
    const oldList = container.querySelector(".queue ul");
    const scroll = oldList ? oldList.scrollTop : 0;  // re-rendering resets it
    // Every inner scroll area (and the page) keeps its position across the re-render.
    const SCROLLERS = [".errors-scroll", ".aw-scroll", ".field-table", ".page-column", ".em-body"];
    const kept = tab === ctx.renderedTab ? SCROLLERS.flatMap(sel => [...container.querySelectorAll(sel)].map((el, i) => [sel, i, el.scrollTop])) : [];
    const pageY = window.scrollY;
    ctx.renderedTab = tab;
    container.innerHTML = renderHeader(ctx, stats) + emailBanner(ctx) + addingBanner(ctx) + renderDashboard(ctx, stats) +
      `<div class="overview-grid">${renderErrors(ctx)}${renderIssuesOverview(ctx)}</div>` +
      renderTabs(ctx, stats) + `<div class="tab-body">${tabHeader(tab)}${stageBanner(tab)}${body}</div>`;
    for (const [sel, i, top] of kept) { const el = container.querySelectorAll(sel)[i]; if (el) el.scrollTop = top; }
    if (window.scrollY !== pageY) window.scrollTo(window.scrollX, pageY);
    saveSummary(ctx);
    if (tab === "review") fillPayloadCard(container);
    if (ctx.state.focusInput) {  // from "Go to item" in Awaiting client: ready to type the received value
      ctx.state.focusInput = false;
      const target = container.querySelector(".detail-card .edit-value:not([hidden])") || container.querySelector('.detail-card .options input[type="radio"]');
      if (target) setTimeout(() => target.focus(), 0);
    }
    const list = container.querySelector(".queue ul"), row = container.querySelector(".queue-row.selected");
    if (list) {
      list.scrollTop = scroll;
      // Keep the selected row in view inside the queue's own scroll area.
      if (row) {
        const top = row.offsetTop - list.offsetTop, bottom = top + row.offsetHeight;
        if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTop = top - 8;
      }
    }
  }

  // The tab (and the selected triage item) live in the URL hash, so refresh and "Go to item" links work.
  function readHash(ctx) {
    const [tab, key] = location.hash.slice(1).split("/").map(decodeURIComponent);
    if (TABS.some(([id]) => id === tab)) ctx.state.tab = tab;
    if (key && tab === "triage") {
      ctx.state.selected = key;
      // Make sure the linked item is in the queue: a medium-confidence field needs its filter on;
      // any other item needs the filters cleared if they'd hide it.
      const item = (ctx.items || []).find(i => i.key === key), filters = ctx.state.filters;
      if (item && !needsAttention(item) && item.tags.includes("medium")) ctx.state.filters = new Set(["medium"]);
      else if (item && filters.size && !item.tags.some(t => filters.has(t))) ctx.state.filters = new Set();
    }
    if (key && tab === "forms") ctx.state.formsForm = key;
  }
  function writeHash(ctx) {
    const {tab, selected, formsForm} = ctx.state;
    const hash = tab === "triage" && selected ? `#triage/${encodeURIComponent(selected)}`
               : tab === "forms" && formsForm ? `#forms/${encodeURIComponent(formsForm)}` : `#${tab}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  async function saveDecision(ctx, decision) {
    const res = await fetch(ctx.options.decisionsUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(decision)});
    if (!res.ok) throw new Error(`Saving failed (${res.status})`);
    const saved = await res.json();
    ctx.decisions = saved.decisions;
    ctx.activity = saved.activity;
  }

  function onClick(container, e) {
    const ctx = container._ctx;
    const act = e.target.closest(".detail-card [data-act]");
    if (act) {
      const panel = act.closest(".detail-card");
      return performAction(container, ctx.items.find(i => i.key === panel.dataset.key), act.dataset.act, panel, "triage");
    }
    const el = e.target.closest("[data-action], .source-open, .tab");
    if (!el) return;
    if (el.classList.contains("source-open")) return openViewer(container, ctx.groups.get(el.dataset.group), +el.dataset.index, ctx.state.tab === "forms");
    if (el.classList.contains("tab")) {
      e.preventDefault();
      ctx.state.tab = el.dataset.tab;
    } else {
      const action = el.dataset.action;
      if (action === "toggle-dashboard") ctx.state.dashboardOpen = !ctx.state.dashboardOpen;
      else if (action === "toggle-card") ctx.state.cards[el.dataset.card] = ctx.state.cards[el.dataset.card] === false;
      else if (action === "toggle-filter") {
        const f = ctx.state.filters;
        f.has(el.dataset.tag) ? f.delete(el.dataset.tag) : f.add(el.dataset.tag);
      } else if (action === "clear-filters") ctx.state.filters.clear();
      else if (action === "select-form") ctx.state.form = el.dataset.form;
      else if (action === "pick-form") ctx.state.formsForm = el.dataset.form;
      else if (action === "goto-filter" || action === "review-in-triage") {
        e.preventDefault();
        const item = ctx.items.find(i => i.key === el.dataset.key);
        // A medium-confidence field is only in the queue with its filter on.
        const tag = action === "goto-filter" ? el.dataset.tag : item && !needsAttention(item) && item.tags.includes("medium") ? "medium" : "";
        ctx.state.focusInput = el.dataset.focus === "input";
        Object.assign(ctx.state, {tab: "triage", form: el.dataset.form || "", filters: new Set(tag ? [tag] : []),
                                  selected: item ? item.key : null});
        writeHash(ctx);
        draw(container);
        return document.querySelector(".tabs").scrollIntoView({block: "start"});
      }
      else if (action === "select-item") ctx.state.selected = el.dataset.key;
      else if (action === "queue-step") return stepQueue(container, +el.dataset.step);
      else if (action === "start-sweep") return openSweep(container);
      else if (action === "dismiss-banner") {
        try { localStorage.setItem(BANNER_STORE, JSON.stringify([...new Set([...dismissedBanners(), el.dataset.tab])])); } catch {}
      }
      else if (action === "email-save") return saveEmail(container);
      else if (action === "email-sent") return markEmailSent(container);
      else if (action === "copy-followup") {
        return navigator.clipboard.writeText(followUpEmail(ctx))
          .then(() => { el.textContent = "Copied"; setTimeout(() => { el.textContent = "Copy follow-up email"; }, 1500); });
      } else if (action === "open-awaiting") {
        e.preventDefault();
        ctx.state.tab = "review";
        writeHash(ctx);
        draw(container);
        const card = document.getElementById("awaiting-client");
        if (card) card.scrollIntoView({block: "start"});
        return;
      } else if (action === "dismiss-email-banner") {
        try { localStorage.setItem(`packetReview.emailResolved.${ctx.options.decisionsUrl}`, lastSent(ctx) || "1"); } catch {}
      }
      else if (action === "email-reset") ctx.state.email = null;
      else if (action === "email-copy") {
        const {subject, body} = emailText(container);
        return navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`)
          .then(() => { el.textContent = "Copied"; setTimeout(() => { el.textContent = "Copy to clipboard"; }, 1500); });
      } else if (action === "email-mailto") {
        const {subject, body} = emailText(container);
        el.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;  // opens a draft; nothing is sent
        return;
      }
      else return;
    }
    writeHash(ctx);
    draw(container);
  }

  // Back / Next through the triage queue.
  function stepQueue(container, step) {
    const ctx = container._ctx, queue = triageQueue(ctx);
    if (!queue.length) return;
    const pos = queue.findIndex(i => i.key === ctx.state.selected);
    ctx.state.selected = queue[Math.max(0, Math.min(queue.length - 1, pos < 0 ? 0 : pos + step))].key;
    writeHash(ctx);
    draw(container);
  }

  // Triage keyboard: → next, ← back, Enter = primary action (or the typed-value action while typing).
  function onKey(container, e) {
    const ctx = container._ctx;
    if (ctx.state.tab !== "triage" || document.querySelector("#source-modal.open, #sweep.open")) return;
    const panel = document.querySelector(".detail-card");
    if (!panel) return;
    const typing = e.target.matches && e.target.matches("input, textarea");
    if (e.key === "Enter" && typing) { e.preventDefault(); return enterAction(panel, ctx); }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight") { e.preventDefault(); stepQueue(container, 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stepQueue(container, -1); }
    else if (e.key === "Enter" && !(e.target.matches && e.target.matches("button, a"))) { e.preventDefault(); enterAction(panel, ctx); }
  }

  // ===========================================================================
  // Verification sweep, page by page: the page on the left; on the right every field on it, flagged
  // ones ("Needs attention", with Triage's actions) first, then "Looks good" (Verify, Verify all).
  // "Verify page" marks the page done. Back / Next move between pages; Esc exits.
  // ===========================================================================
  function sweepFields(ctx) {
    return reviewedForms(ctx.effective).filter(hasPages)
      .flatMap(form => form.fields.map(f => ({form: form.form, field: f.field})));
  }
  const sweepKey = s => `field::${fieldKey(s.form, s.field)}`;
  const sweepCheckKey = s => `sweep::${fieldKey(s.form, s.field)}`;
  // Verified in the sweep: either the field's own decision, or a sweep check (for blank required
  // fields and fields waiting on the client, where Verify only records that the reviewer looked).
  const sweepVerified = (ctx, s) => {
    const d = ctx.decisions[sweepKey(s)];
    if (ctx.invalidKeys && ctx.invalidKeys.has(sweepKey(s))) return false;
    // Skipped, or only put in the client email ("requested" with no decision of its own), isn't verified.
    if ((!!d && !["skipped", "requested"].includes(d.action)) || ctx.decisions[sweepCheckKey(s)]) return true;
    const c = sweepConflict(ctx, s);  // a field of a conflict counts once the conflict is resolved
    return !!c && itemState(ctx, c.item) === "resolved";
  };

  // The sweep's buttons for one field: the flagged item's contextual labels where it has an open
  // issue (same wording as Triage), else Verify / Edit. Each: [label, sweep action, primary?].
  // The conflict a sweep field belongs to, while it isn't resolved: {item, sourceIndex}.
  function sweepConflict(ctx, s) {
    const found = itemFor(ctx, s.form, s.field);
    return found.item && found.item.kind === "conflict" ? found : null;
  }
  function sweepButtons(ctx, s) {
    const c = sweepConflict(ctx, s);
    if (c && itemState(ctx, c.item) !== "resolved") return {conflict: c, buttons: [["Save selection", "primary", true]]};
    const {item} = itemFor(ctx, s.form, s.field);
    const form = ctx.effective.forms.find(f => f.form === s.form), f = form.fields.find(x => x.field === s.field);
    // Blank and shown as "missing" (required, or optional left empty): the same question as Triage.
    const blank = !hasValue(f) && !f.page_missing && fieldRule(f, form.fields).empty === MISSING
      && item && itemState(ctx, item) === "open";
    if (blank) return {question: "Is this field blank on the scanned form?", buttons: [["Yes, it's blank", "blank", true], ["Enter the value", "edit"]]};
    const open = item && item.kind === "field" && itemState(ctx, item) === "open" && item.tags.length;  // medium-only counts here
    const group = open ? QUEUE_GROUPS[queueGroup(item)] : null;
    if (group === "scribble") return {buttons: [["Enter value", "edit", true], ["Mark unreadable", "unreadable"]]};
    if (group === "validation") return {buttons: [["Correct value", "edit", true], ["Accept as-is", "accept-as-is"]]};
    if (group === "low" || group === "medium") return {buttons: [["Confirm value", "verify", true], ["Correct value", "edit"]]};
    return {buttons: [["Verify", "verify", true], ["Edit", "edit"]]};
  }

  // The way in (All Forms header, Review & Export): the step's copy, progress, and the Start button.
  function sweepEntryCard(ctx, extraClass = "") {
    const all = sweepFields(ctx), verified = all.filter(x => sweepVerified(ctx, x)).length;
    const status = verified === all.length && all.length ? `Sweep complete: ${verified} of ${all.length} &#10003;`
                 : verified ? `${verified} of ${all.length} fields verified` : "Sweep not started";
    return `<section class="card sweep-entry ${extraClass}">
      <div><h2>${status}</h2><p class="summary">Step 2 — Final pass: verify every field, page by page.</p></div>
      <button type="button" class="btn${verified === all.length ? "" : " primary"}" data-action="start-sweep">${
        verified === all.length ? "Open verification sweep" : verified ? "Continue verification sweep" : "Start verification sweep"}</button></section>`;
  }

  // ---------- pages ----------
  // Every scanned page with fields, form by form in page order; a form's fields whose page is
  // missing from the scan make one more "page" (no image).
  function sweepPages(ctx) {
    const pages = [];
    reviewedForms(ctx.effective).filter(hasPages).forEach((form, formIndex) => {
      const byPage = new Map();
      for (const f of form.fields) {
        const page = f.page_missing || !f.page ? null : f.page;
        if (!byPage.has(page)) byPage.set(page, {key: `${form.form}::${page == null ? "missing" : page}`, form: form.form, page, formIndex, fields: []});
        byPage.get(page).fields.push({form: form.form, field: f.field});
      }
      pages.push(...[...byPage.values()].sort((a, b) => (a.page == null) - (b.page == null) || a.page - b.page));
    });
    return pages;
  }
  const pageDoneKey = p => `sweep_page::${p.key}`;
  const pageVerified = (ctx, p) => !!ctx.decisions[pageDoneKey(p)];
  function pageTitle(ctx, p) {
    const sections = [...new Set(p.fields.map(s => (fieldSource(ctx, s.form, s.field) || {}).section).filter(Boolean))];
    const where = [shortName(p.form), sections.join(" & ")].filter(Boolean).join(", ");
    return p.page == null ? `Missing page — ${where}` : `Page ${p.page} — ${where}`;
  }

  // One field's place on the page: in "Needs attention" (flagged: a conflict, an issue tag, or
  // blank where it counts as missing) or "Looks good"; and whether it's still open.
  function sweepRow(ctx, s) {
    const form = ctx.effective.forms.find(f => f.form === s.form), f = form.fields.find(x => x.field === s.field);
    const rule = fieldRule(f, form.fields), {item} = itemFor(ctx, s.form, s.field), c = sweepConflict(ctx, s);
    const blank = !hasValue(f) && !f.page_missing && rule.empty === MISSING;
    if (f.page_missing) {  // its page isn't in the scan: settled by the page's own item in Triage
      const pageItem = ctx.items.find(i => i.kind === "missing_page" && i.form.form === s.form && i.page.page === f.form_page);
      return {s, f, rule, item, conflict: null, flagged: true, pageMissing: true,
              open: !sweepVerified(ctx, s) && !!pageItem && itemState(ctx, pageItem) === "open"};
    }
    const flagged = !!c || !!(item && item.tags && item.tags.length) || blank;
    const handled = sweepVerified(ctx, s) || (c ? itemState(ctx, c.item) !== "open" : item ? itemState(ctx, item) !== "open" : false);
    return {s, f, rule, item, conflict: c, flagged, open: flagged && !handled};
  }

  // ---------- open / close ----------
  function openSweep(container, formName = "") {
    const ctx = container._ctx;
    let sweep = document.getElementById("sweep");
    if (!sweep) {
      sweep = document.createElement("div");
      sweep.id = "sweep";
      sweep.setAttribute("role", "dialog");
      sweep.setAttribute("aria-modal", "true");
      sweep.setAttribute("aria-label", "Verification sweep");
      document.body.appendChild(sweep);
      for (const type of ["input", "change"]) sweep.addEventListener(type, e => {
        const row = e.target.closest(".sw-row");
        if (row) syncConflictChoice(row, e);
      });
      sweep.addEventListener("click", e => {
        const act = e.target.closest("[data-sw-act]");
        if (act && !act.disabled) return sweepAct(act.dataset.swAct, act.closest(".sw-row"));
        const itemAct = e.target.closest(".sw-row [data-act]");
        if (itemAct && !itemAct.disabled) return sweepItemAct(itemAct.dataset.act, itemAct.closest(".sw-row"));
        const z = e.target.closest("[data-sw-zoom]");
        if (z) return sweepZoom(z.dataset.swZoom);
        const page = e.target.closest("[data-sw-page]");
        if (page) return sweepGoto(+page.dataset.swPage);
        const jump = e.target.closest("[data-sw-form]");
        if (jump) return sweepJump(jump.dataset.swForm);
      });
      sweep.addEventListener("focusin", e => {
        const row = e.target.closest(".sw-row");
        if (row) sweep._focusKey = row.dataset.field;
      });
      // Drag the page to pan.
      sweep.addEventListener("pointerdown", e => {
        const pane = e.target.closest(".sw-page");
        if (!pane || e.button !== 0 || e.target.tagName !== "IMG") return;
        const start = {x: e.clientX, y: e.clientY, left: pane.scrollLeft, top: pane.scrollTop};
        pane.classList.add("panning");
        const move = ev => { pane.scrollLeft = start.left - (ev.clientX - start.x); pane.scrollTop = start.top - (ev.clientY - start.y); };
        const up = () => { pane.classList.remove("panning"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        e.preventDefault();
      });
      window.addEventListener("resize", () => { if (sweep.classList.contains("open") && sweep._zoom === "fit") sweepZoom("fit"); });
      document.addEventListener("keydown", e => {
        if (!sweep.classList.contains("open") || document.querySelector("#source-modal.open")) return;
        const modal = sweep.querySelector(".sw-modal");
        if (e.key === "Escape") return modal ? sweepAct("review-them") : closeSweep();
        if (modal) return;
        const typing = e.target.matches && e.target.matches("input");
        const row = e.target.closest && e.target.closest(".sw-row");
        if (e.key === "Enter") {
          if (e.target.matches && e.target.matches("button, a")) return;  // the button itself
          if (!row) return;
          e.preventDefault();
          // Typing: save the edit, or the conflict's typed value. Else the row's primary action.
          if (typing && e.target.classList.contains("edit-value")) return sweepAct("save", row);
          const primary = row.querySelector(".sw-row-actions .btn.primary:not(:disabled)");
          if (primary) primary.click();
          return;
        }
        if (typing) return;
        if (e.key === "ArrowRight") { e.preventDefault(); sweepGoto(sweep._page + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); sweepGoto(sweep._page - 1); }
      });
    }
    sweep._container = container;
    sweep._pages = sweepPages(ctx);
    sweep._zoom = 1;  // pages load at 100%; Fit width is one click away
    sweep._image = null;
    sweep._editing = null;
    sweep._expanded = new Set();
    // Start at the first page (of the given form, if any) that isn't verified yet.
    const pages = sweep._pages, inForm = p => !formName || p.form === formName;
    const first = pages.findIndex(p => inForm(p) && !pageVerified(ctx, p));
    sweep._page = first >= 0 ? first : Math.max(0, pages.findIndex(inForm));
    sweep.classList.add("open");
    document.body.style.overflow = "hidden";
    renderSweep();
  }
  function closeSweep() {
    const sweep = document.getElementById("sweep");
    sweep.classList.remove("open");
    document.body.style.overflow = "";
    draw(sweep._container);
  }
  function sweepGoto(index) {
    const sweep = document.getElementById("sweep");
    if (index < 0 || index >= sweep._pages.length) return;
    sweep._page = index;
    sweep._editing = null;
    sweep._focusKey = null;
    renderSweep();
    sweep.querySelector(".sw-field-body").scrollTop = 0;
  }
  // Sidebar: a form opens at its first page that isn't verified (or its first page).
  function sweepJump(formName) {
    const sweep = document.getElementById("sweep"), ctx = sweep._container._ctx, pages = sweep._pages;
    const i = pages.findIndex(p => p.form === formName && !pageVerified(ctx, p));
    sweepGoto(i >= 0 ? i : pages.findIndex(p => p.form === formName));
  }
  // Page zoom: "fit" fills the pane's width; +/− step from the current size; "keep" re-applies.
  function sweepZoom(step) {
    const sweep = document.getElementById("sweep"), pane = sweep.querySelector(".sw-page"), img = pane && pane.querySelector("img");
    if (!img || !img.naturalWidth) return;
    const fit = (pane.clientWidth - 24) / img.naturalWidth;
    let zoom = sweep._zoom === "fit" ? fit : sweep._zoom;
    if (step === "fit") sweep._zoom = "fit";
    else if (step === "1") sweep._zoom = ZOOMS.find(z => z > zoom + 0.001) || ZOOMS[ZOOMS.length - 1];
    else if (step === "-1") sweep._zoom = [...ZOOMS].reverse().find(z => z < zoom - 0.001) || ZOOMS[0];
    zoom = sweep._zoom === "fit" ? fit : sweep._zoom;
    img.style.width = `${Math.round(img.naturalWidth * zoom)}px`;
    sweep.querySelector(".sw-zoom-level").textContent = sweep._zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;
  }

  // ---------- render ----------
  function renderSweep() {
    const sweep = document.getElementById("sweep"), container = sweep._container, ctx = container._ctx;
    const pages = sweep._pages, p = pages[sweep._page];
    const all = sweepFields(ctx), done = all.filter(x => sweepVerified(ctx, x)).length;
    const pct = (n, total) => Math.round(100 * n / Math.max(1, total));
    const rows = p.fields.map(s => sweepRow(ctx, s));
    const attention = rows.filter(r => r.flagged), good = rows.filter(r => !r.flagged);
    const openCount = attention.filter(r => r.open).length;
    const pageDone = rows.filter(r => sweepVerified(ctx, r.s)).length;
    // Sidebar: every form with its progress; the current form lists its pages.
    const forms = reviewedForms(ctx.effective).filter(hasPages).map(fm => {
      const fields = all.filter(x => x.form === fm.form), n = fields.filter(x => sweepVerified(ctx, x)).length;
      const current = fm.form === p.form;
      const pageList = current ? `<ul class="sw-pages">${pages.map((pg, i) => pg.form !== fm.form ? "" : (() => {
        const n2 = pg.fields.filter(x => sweepVerified(ctx, x)).length, ok = pageVerified(ctx, pg);
        return `<li><button type="button" class="sw-page-link${i === sweep._page ? " current" : ""}${ok ? " verified" : ""}" data-sw-page="${i}">
          <span class="sw-page-icon" aria-hidden="true">${ok ? "&#10003;" : n2 === pg.fields.length ? "&#9679;" : "&#9675;"}</span>
          <span>${pg.page == null ? "Missing page" : `Page ${pg.page}`}</span><span class="sw-form-count">${n2}/${pg.fields.length}</span></button></li>`; })()).join("")}</ul>` : "";
      const formPages = pages.filter(pg => pg.form === fm.form), allPages = formPages.every(pg => pageVerified(ctx, pg));
      return `<li><button type="button" class="sw-form${current ? " current" : ""}${n === fields.length ? " complete" : ""}${allPages ? " pages-verified" : ""}" data-sw-form="${esc(fm.form)}">
        <span class="sw-form-name">${allPages ? '<span class="sw-form-ok" title="Every page verified">&#10003;</span> ' : ""}${esc(shortName(fm.form))}</span><span class="sw-form-count">${n}/${fields.length}</span>
        <span class="sw-bar"><span style="width:${pct(n, fields.length)}%"></span></span></button>${pageList}</li>`;
    }).join("");
    const info = p.page != null && (ctx.data.pages || []).find(x => x.page === p.page);
    const image = info && info.image ? ctx.imageBase + info.image : null;
    const keepImage = sweep._image === image;
    sweep._image = image;
    // Re-rendering replaces the panes: keep each scroll position when staying on the same page.
    const samePage = sweep._renderedPage === p.key;
    const keep = samePage ? [".sw-field-body", ".sw-forms", ".sw-page"].map(sel => {
      const el = sweep.querySelector(sel);
      return el && [sel, el.scrollTop, el.scrollLeft];
    }).filter(Boolean) : [];
    sweep._renderedPage = p.key;
    sweep.innerHTML = `
      <header class="sw-head">
        <div class="page-header sw-page-header"><div class="kicker">Step 2 — Verification sweep · ${esc(shortName(p.form))}</div>
          <h1>Verification sweep</h1>
          <p class="lede">Check every extracted field against its scanned page, including the high-confidence ones, and mark each page verified.</p></div>
        <span class="sw-progress${done === all.length ? " complete" : ""}"><span class="sw-count">${sweep._page + 1} of ${pages.length} pages · ${done} of ${all.length} fields verified</span>
          <span class="sw-bar"><span style="width:${pct(done, all.length)}%"></span></span></span>
        <button type="button" class="btn small" data-sw-act="exit">Exit (Esc)</button></header>
      <div class="sw-main">
        <nav class="sw-forms" aria-label="Forms and pages"><ul>${forms}</ul></nav>
        <section class="sw-page-pane">
          ${image ? `<div class="sw-page"><img src="${esc(image)}" alt="Page ${p.page} of the packet"></div>
            <div class="sw-zoom" role="group" aria-label="Zoom"><button type="button" data-sw-zoom="-1" aria-label="Zoom out">&#8722;</button>
              <span class="sw-zoom-level">100%</span><button type="button" data-sw-zoom="1" aria-label="Zoom in">+</button>
              <button type="button" data-sw-zoom="fit">Fit width</button></div>`
            : `<p class="empty">This page is missing from the scan, so its fields couldn't be read.</p>`}
        </section>
        <section class="sw-field">
          <div class="sw-field-body">
            <header class="sw-page-head">
              <h3>${esc(pageTitle(ctx, p))}</h3>
              <div class="sw-page-progress${pageDone === rows.length ? " complete" : ""}"><span>${pageDone} of ${rows.length} verified${
                pageVerified(ctx, p) ? ' · <b class="sw-page-ok">&#10003; page verified</b>' : ""}</span>
                <span class="sw-bar"><span style="width:${pct(pageDone, rows.length)}%"></span></span></div>
            </header>
            ${attention.length ? `<section class="sw-group-box ${openCount ? "attention" : "handled"}" aria-label="Needs attention">
              <h4 class="sw-group">${openCount
                ? '<span class="sw-group-icon" aria-hidden="true">&#9888;</span>Needs attention'
                : '<span class="sw-group-icon" aria-hidden="true">&#10003;</span>Needs attention — all handled'}
                <span class="sw-group-count">${openCount ? `${openCount} open` : `${attention.length} handled`}</span></h4>
              ${attention.map((r, i) => sweepRowHtml(ctx, r, sweep, `a${i}`)).join("")}</section>` : ""}
            ${good.length ? `<section class="sw-group-box good" aria-label="Looks good">
              <h4 class="sw-group"><span class="sw-group-icon" aria-hidden="true">&#10003;</span>Looks good <span class="sw-group-count">${good.length}</span>
              ${good.some(r => !sweepVerified(ctx, r.s)) ? '<button type="button" class="btn small" data-sw-act="verify-all">Verify all</button>' : ""}</h4>
              ${good.map((r, i) => sweepRowHtml(ctx, r, sweep, `g${i}`)).join("")}</section>` : ""}
          </div>
          <footer class="sw-footer">
            ${pageVerified(ctx, p) && sweep._page < pages.length - 1
              ? '<button type="button" class="btn primary sw-verify-page" data-sw-act="next-page">&#10003; Page verified — next page &#8594;</button>'
              : `<button type="button" class="btn primary sw-verify-page" data-sw-act="verify-page">${pageVerified(ctx, p) ? "&#10003; Page verified — verify again" : "Verify page"}</button>`}
            <div class="sw-navbar">
              <button type="button" class="btn small" data-sw-act="prev-page" ${sweep._page ? "" : "disabled"}>&#8592; Back</button>
              <span class="kbd-hint">Enter = verify the focused row · &#8592; &#8594; = pages · Esc = exit</span>
              <button type="button" class="btn small" data-sw-act="next-page" ${sweep._page < pages.length - 1 ? "" : "disabled"}>Next &#8594;</button>
            </div>
          </footer>
        </section>
      </div>`;
    const img = sweep.querySelector(".sw-page img");
    if (img) {
      if (!keepImage) sweep._zoom = 1;  // a new page loads at 100%
      const apply = () => sweepZoom(sweep._zoom === "fit" ? "fit" : "keep");
      if (img.complete) apply(); else img.addEventListener("load", apply);
    }
    for (const [sel, top, left] of keep) { const el = sweep.querySelector(sel); el.scrollTop = top; el.scrollLeft = left; }
    const current = sweep.querySelector(".sw-form.current");
    if (current && !samePage) current.scrollIntoView({block: "nearest"});
    for (const row of sweep.querySelectorAll(".sw-row")) syncConflictChoice(row);
    const editing = sweep._editing && sweep.querySelector(`.sw-row[data-field="${CSS.escape(sweep._editing)}"]`);
    if (editing) {
      validateInputs(editing);
      editing.querySelector(".edit-value").focus({preventScroll: true});
      return keepInView(sweep.querySelector(".sw-field-body"), editing);
    }
    // Keep the reviewer's place: the row they were on (scrolled into view only if it isn't),
    // else the first open row.
    const focusRow = (sweep._focusKey && sweep.querySelector(`.sw-row[data-field="${CSS.escape(sweep._focusKey)}"]`))
      || sweep.querySelector(".sw-row.open");
    if (focusRow) {
      focusRow.focus({preventScroll: true});
      if (sweep._focusKey) keepInView(sweep.querySelector(".sw-field-body"), focusRow);
    }
  }
  // Scroll a list only as much as needed to show the row (no jump when it's already visible).
  function keepInView(list, row) {
    if (!list || !row) return;
    const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
    const head = (list.querySelector(".sw-page-head") || {offsetHeight: 0}).offsetHeight;  // sticky header covers the top
    if (r.top < l.top + head) list.scrollTop -= l.top + head - r.top + 8;
    else if (r.bottom > l.bottom) list.scrollTop += Math.min(r.bottom - l.bottom + 8, r.top - l.top - head - 8);
  }

  // One row: name, value box, tags, status, and the same actions as Triage.
  function sweepRowHtml(ctx, r, sweep, id) {
    const {s, f, rule, item, conflict} = r;
    const verified = sweepVerified(ctx, s), editing = sweep._editing === s.field && sweep._editForm === s.form;
    const state = conflict ? itemState(ctx, conflict.item) : item ? itemState(ctx, item) : "open";
    const status = verified ? '<span class="badge conf-high">&#10003; verified</span>'
                 : state === "needs_client" ? `<span class="badge needs-client">${esc(clientLabel(decisionOf(ctx, conflict ? conflict.item : item)))}</span>`
                 : state === "requested" ? '<span class="badge awaiting">awaiting client</span>'
                 : r.flagged && !r.open ? '<span class="badge conf-high">&#10003; resolved</span>' : "";
    const cat = r.open ? (conflict ? "conflict" : !r.pageMissing && item && item.tags.length ? QUEUE_GROUPS[queueGroup(item)] : "missing") : "";
    const value = editing
      ? `<input type="text" class="edit-value sw-value-input" value="${esc(hasValue(f) && f.value !== SIGNED ? f.value : "")}"
           data-format="${esc(formatOf(ctx, s.form, s.field) || "")}" aria-label="Correct value for ${esc(s.field)}"><span class="input-error" hidden></span>`
      : `<div class="sw-value">${fieldValueHtml(f, rule)}</div>`;
    const btn = (label, act, primary = false, extra = "") => `<button type="button" class="btn small${primary ? " primary" : ""}" data-sw-act="${act}" ${extra}>${esc(label)}</button>`;
    let actions = "", extra = "";
    if (editing) {
      actions = btn("Save", "save", true, 'data-needs-valid="input"') + btn("Cancel", "cancel");
    } else if (r.pageMissing) {
      extra = r.open ? '<p class="action-question">Its page is missing from the scan — settle the page in Triage, or enter the value if you have it.</p>' : "";
      actions = btn("Enter the value", "edit", false);
    } else if (conflict && r.open) {
      const expanded = sweep._expanded.has(conflict.item.key);
      actions = `<button type="button" class="btn small${expanded ? "" : " primary"} sw-chevron" data-sw-act="toggle" aria-expanded="${expanded}">${
        expanded ? "Hide options &#9652;" : "Resolve conflict &#9662;"}</button>`;
      if (expanded) {
        extra = `<div class="sw-conflict">${itemBody(ctx, conflict.item, {where: `sweep-${id}`, saved: {}})}</div>`;
        actions = `<button type="button" class="btn small primary" data-act="primary" data-needs-valid="conflict" disabled>Save selection</button>` + actions;
      }
    } else if (r.open) {
      const spec = sweepButtons(ctx, s);
      if (spec.question) extra = `<p class="action-question">${esc(spec.question)}</p>`;
      actions = spec.buttons.map(([label, act, primary]) => btn(label, act, primary)).join("");
      extra += clarifyRow(ctx, item) + suggestionCard(ctx, item, "sweep");
    } else if (!r.flagged && !verified) {
      actions = btn("✓ Verify", "verify", true) + btn("Edit", "edit");
    } else {
      actions = btn("Edit", "edit");
    }
    return `<div class="sw-row${r.open ? ` open row-cat cat-${cat}` : ""}${verified ? " verified" : ""}" tabindex="0" data-form="${esc(s.form)}" data-field="${esc(s.field)}">
      <div class="sw-row-head"><span class="sw-row-name">${esc(s.field)}</span><span class="sw-row-tags">${fieldPills(f, rule)}${status}</span></div>
      ${value}${adjustedLine(f)}${extra}
      <div class="sw-row-actions">${actions}</div></div>`;
  }

  // ---------- actions ----------
  const rowField = row => ({form: row.dataset.form, field: row.dataset.field});
  // Item actions (Save selection / Add to email / "Yes, it's blank") run exactly as in Triage.
  function sweepItemAct(act, row) {
    const sweep = document.getElementById("sweep"), container = sweep._container, ctx = container._ctx;
    const s = rowField(row), {item} = itemFor(ctx, s.form, s.field);
    sweep._focusKey = s.field;
    if (item) performAction(container, item, act, row, "sweep");
  }
  function sweepSaved(container, message, key) {
    const ctx = container._ctx;
    ctx.effective = effectiveData(ctx.data, ctx.decisions);
    if (message) showToast(container, message, key);
    draw(container);
    renderSweep();
  }
  function sweepAct(what, row) {
    const sweep = document.getElementById("sweep"), container = sweep._container, ctx = container._ctx;
    const p = sweep._pages[sweep._page];
    if (what === "exit") return closeSweep();
    if (what === "prev-page") return sweepGoto(sweep._page - 1);
    if (what === "next-page") return sweepGoto(sweep._page + 1);
    if (what === "verify-page") return openPageModal();
    if (what === "review-them") { const m = sweep.querySelector(".sw-modal"); if (m) m.remove(); return; }
    if (what === "page-anyway" || what === "page-verify") return verifyPage(what === "page-anyway");
    if (what === "verify-all") return verifyFields(sweep._pages[sweep._page].fields.map(s => sweepRow(ctx, s)).filter(r => !r.flagged && !sweepVerified(ctx, r.s)).map(r => r.s))
      .then(n => sweepSaved(container, `Verified ${n} field${n === 1 ? "" : "s"} on this page`));
    if (!row) return;
    const s = rowField(row);
    sweep._focusKey = s.field;
    if (what === "toggle") {
      const {item} = itemFor(ctx, s.form, s.field);
      sweep._expanded.has(item.key) ? sweep._expanded.delete(item.key) : sweep._expanded.add(item.key);
      return renderSweep();
    }
    if (what === "edit") { sweep._editing = s.field; sweep._editForm = s.form; return renderSweep(); }
    if (what === "cancel") { sweep._editing = null; return renderSweep(); }
    if (!ctx.options.decisionsUrl) return;
    const {item} = itemFor(ctx, s.form, s.field);
    if (what === "blank") return sweepItemAct("blank", row);
    if (what === "quickadd") return quickAdd(container, item, "sweep");
    const form = ctx.effective.forms.find(f => f.form === s.form), f = form.fields.find(x => x.field === s.field);
    const original = (ctx.data.forms.find(x => x.form === s.form).fields.find(x => x.field === s.field) || {}).value || "";
    if (what === "unreadable" || what === "accept-as-is") {
      const decision = buildDecision(ctx, item, what === "unreadable" ? "unreadable" : "accepted", row);
      if (what === "accept-as-is") decision.note = (actionsFor(ctx, item).secondary || {}).note;
      return saveDecision(ctx, decision).then(() => sweepSaved(container,
        what === "unreadable" ? `Marked unreadable — ${s.field}` : `Accepted as-is — ${s.field}`, decision.key)).catch(err => alert(err.message));
    }
    if (what === "save") {
      if (!validateInputs(row)) return row.querySelector(".edit-value").focus();
      const value = normalizeTyped(formatOf(ctx, s.form, s.field), row.querySelector(".edit-value").value.trim());
      if (!value && fieldRule(f, form.fields).cls === "required") { sweep._editing = null; return sweepItemAct("blank", row); }  // empty required → missing
      sweep._editing = null;
      const decision = {key: sweepKey(s), action: value === original ? "accepted" : "edited", title: s.field, form: s.form,
                        value, original, fields: [{form: s.form, field: s.field, value}]};
      return saveDecision(ctx, decision).then(() => sweepSaved(container, `Saved${parseDate(value) ? ` as ${value}` : ""} — ${s.field}`, decision.key)).catch(err => alert(err.message));
    }
    if (what === "verify") {
      return verifyFields([s]).then(() => sweepSaved(container, `Verified — ${s.field}`, null)).catch(err => alert(err.message));
    }
  }
  // Verify fields as read. A blank missing field, or one already with the client, only records the
  // check: it mustn't mark a missing item resolved or drop a client request.
  async function verifyFields(list) {
    const ctx = document.getElementById("sweep")._container._ctx;
    for (const s of list) {
      const f = currentField(ctx, s.form, s.field), {item} = itemFor(ctx, s.form, s.field);
      const original = (ctx.data.forms.find(x => x.form === s.form).fields.find(x => x.field === s.field) || {}).value || "";
      const checkOnly = item && (item.tags.includes("missing") || ["needs_client", "requested"].includes(itemState(ctx, item)));
      await saveDecision(ctx, checkOnly
        ? {key: sweepCheckKey(s), action: "skipped", title: s.field, form: s.form, value: f.value || "", original, fields: []}
        : {key: sweepKey(s), action: f.value === original ? "accepted" : "edited", title: s.field, form: s.form,
           value: f.value || "", original, fields: [{form: s.form, field: s.field, value: f.value || ""}]});
    }
    return list.length;
  }

  // ---------- Verify page ----------
  function openPageModal() {
    const sweep = document.getElementById("sweep"), ctx = sweep._container._ctx, p = sweep._pages[sweep._page];
    const rows = p.fields.map(s => sweepRow(ctx, s)), open = rows.filter(r => r.open);
    const unverified = rows.filter(r => !r.flagged && !sweepVerified(ctx, r.s)).length;
    const tags = r => r.conflict ? categoryBadge("conflict") : r.pageMissing ? '<span class="badge cat-badge cat-missing">page missing</span>'
      : r.item && r.item.tags.length ? CATEGORIES.filter(c => r.item.tags.includes(c.tag)).map(c => categoryBadge(c.tag)).join("") : categoryBadge("missing");
    const body = open.length
      ? `<h3>You still have ${open.length} item${open.length === 1 ? "" : "s"} needing attention on this page:</h3>
         <ul class="sw-modal-list">${open.map(r => `<li><b>${esc(r.s.field)}</b> ${tags(r)}</li>`).join("")}</ul>
         <div class="sw-modal-actions"><button type="button" class="btn primary" data-sw-act="review-them">Review them</button>
           <button type="button" class="btn" data-sw-act="page-anyway">Verify page anyway</button></div>`
      : `<h3>${unverified ? `No items need attention. Verifying the page also verifies its ${unverified} remaining field${unverified === 1 ? "" : "s"}. Mark page complete?`
           : `All ${rows.length} fields on this page are verified. Mark page complete?`}</h3>
         <div class="sw-modal-actions"><button type="button" class="btn" data-sw-act="review-them">Back</button>
           <button type="button" class="btn primary" data-sw-act="page-verify">Verify page</button></div>`;
    const modal = document.createElement("div");
    modal.className = "sw-modal";
    modal.innerHTML = `<div class="sw-modal-card" role="alertdialog" aria-modal="true">${body}</div>`;
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
    sweep.appendChild(modal);
    modal.querySelector(".btn.primary").focus();
  }
  async function verifyPage(anyway) {
    const sweep = document.getElementById("sweep"), container = sweep._container, ctx = container._ctx, p = sweep._pages[sweep._page];
    const rows = p.fields.map(s => sweepRow(ctx, s)), open = rows.filter(r => r.open).length;
    try {
      if (!anyway) await verifyFields(rows.filter(r => !r.flagged && !sweepVerified(ctx, r.s)).map(r => r.s));
      await saveDecision(ctx, {key: pageDoneKey(p), action: "accepted", title: pageTitle(ctx, p), form: p.form, value: "", original: "", fields: [],
                               note: open ? `Verified with ${open} item${open === 1 ? "" : "s"} still needing attention` : ""});
    } catch (err) { return alert(err.message); }
    const label = p.page == null ? "Missing page" : `Page ${p.page}`;
    sweepSaved(container, `${label} verified — Next → for the next page`, pageDoneKey(p));
  }

  // ===========================================================================
  // Review & Export
  // ===========================================================================
  const stateOfField = (ctx, formName, fieldName) => {
    const own = ctx.decisions[`field::${fieldKey(formName, fieldName)}`];
    const {item} = itemFor(ctx, formName, fieldName);
    const state = item ? itemState(ctx, item) : "open";
    if (state === "requested") return [isClarify(ctx, item) ? "awaiting clarification" : "awaiting client", "awaiting"];
    if (state === "needs_client") return [isClarify(ctx, item) ? "awaiting clarification" : decisionOf(ctx, item).action === "unreadable" ? "unreadable" : "needs client", "needs-client"];
    const f = currentField(ctx, formName, fieldName);
    if (f.review && f.review.filledFrom) return [filledFromLabel(f.review.filledFrom), "filled"];
    if (f.review && f.review.adjusted) return ["adjusted", "adjusted"];
    if ((own && RESOLVED.has(own.action)) || state === "resolved") return ["verified", "verified"];
    if (item && needsAttention(item) && state === "open") return ["needs attention", "attention"];
    return ["not reviewed", "unreviewed"];
  };

  // When the client email went out, and how long the client has had it.
  const shortWhen = t => new Date(t).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  const daysSince = t => Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
  const waitingText = t => { const n = daysSince(t); return n < 1 ? "waiting since today" : `waiting ${n} day${n === 1 ? "" : "s"}`; };
  // Items requested in a sent email and still not received.
  const awaitingSent = ctx => ctx.items.filter(i => itemState(ctx, i) === "requested" && (decisionOf(ctx, i) || {}).sent);
  const lastSent = ctx => Object.values(ctx.decisions).map(d => d.sent).filter(Boolean).sort().pop() || null;

  // The finish line, in order: Triage status, sweep status, awaiting client, client email, export
  // (always available: the cards above say what's still open), then the field checklist.
  function renderReview(ctx) {
    const open = unresolvedItems(ctx);
    const awaiting = ctx.items.filter(i => itemState(ctx, i) === "requested" || (itemState(ctx, i) === "needs_client" && isClarify(ctx, i)));
    const when = t => new Date(t).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
    const line = (i, extra = "") => `<li><span>${categoryBadge(QUEUE_GROUPS[queueGroup(i)] || "choice")} <b>${esc(i.title)}</b>
      <small>${esc(i.subtitle)}</small>${extra}</span>
      <a href="#triage/${encodeURIComponent(i.key)}" data-action="review-in-triage" data-key="${esc(i.key)}">Go to item &#8594;</a></li>`;
    const triageCard = open.length
      ? `<section class="card cta attention"><h2>${open.length} still open in Triage</h2>
          <ul class="cta-list">${open.map(i => line(i)).join("")}</ul></section>`
      : `<section class="card cta clear"><h2>0 items left &#10003;</h2>
          <p class="summary">Every flagged item has been reviewed${awaiting.length ? "; some are waiting on the client (below)" : ""}.</p></section>`;
    // Awaiting client: a compact table in its own scroll area, beside the client email.
    const awaitingRows = awaiting.map(i => {
      const d = decisionOf(ctx, i);
      return `<tr><td class="aw-tag">${categoryBadge(QUEUE_GROUPS[queueGroup(i)] || "choice")}<span class="badge awaiting">${
          d.action === "clarify" ? "awaiting clarification" : "awaiting client"}</span></td>
        <td class="aw-field"><b>${esc(i.title)}</b><small>${d.sent ? `Email sent ${esc(shortWhen(d.sent))} · ${waitingText(d.sent)}`
          : d.requested ? "draft saved, not yet sent" : "in the email draft"}</small></td>
        <td class="aw-form">${esc(i.kind === "field" ? shortName(i.form.form) : i.subtitle)}</td>
        <td class="aw-go"><a class="btn small" href="#triage/${encodeURIComponent(i.key)}" data-action="review-in-triage" data-focus="input" data-key="${esc(i.key)}">Go to item &#8594;</a></td></tr>`;
    }).join("");
    const stillSent = awaitingSent(ctx);
    const awaitingCard = `<section class="card awaiting-card" id="awaiting-client"><div class="card-head"><h2>Awaiting client${awaiting.length ? ` (${awaiting.length})` : ""}</h2>
      ${stillSent.length ? '<button type="button" class="btn small" data-action="copy-followup">Copy follow-up email</button>' : ""}</div>${awaiting.length
      ? `<p class="summary">Requested in the client email, or sent to the client to clarify. Open one to enter the value — or pick the confirmed one — when they reply.</p>
        <div class="aw-scroll"><table class="aw-table"><thead><tr><th>Tag</th><th>Field</th><th>Form</th><th><span class="sr-only">Go to item</span></th></tr></thead>
          <tbody>${awaitingRows}</tbody></table></div>`
      : '<p class="summary">None.</p>'}</section>`;
    const checklist = reviewedForms(ctx.effective).map(form => {
      if (!hasPages(form)) {
        const st = form.status === "missing" ? (() => { const it = ctx.items.find(i => i.key === `form::${form.form}`); const s2 = it ? itemState(ctx, it) : "open";
          return s2 === "requested" ? ["awaiting client", "awaiting"] : s2 === "needs_client" ? ["needs client", "needs-client"] : ["missing form", "attention"]; })()
          : ["not applicable", "unreviewed"];
        return `<details class="check-form"><summary>${esc(form.form)} <span class="check-pill ${st[1]}">${st[0]}</span></summary></details>`;
      }
      const rows = form.fields.map(f => {
        const [label, cls] = stateOfField(ctx, form.form, f.field);
        return `<tr class="${cls === "adjusted" ? "adjusted" : ""}"><td>${esc(f.field)}</td><td>${fieldValueHtml(f, fieldRule(f, form.fields))}</td>
          <td><span class="check-pill ${cls}">${label}</span></td></tr>`;
      });
      const counts = form.fields.map(f => stateOfField(ctx, form.form, f.field)[1]).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {});
      const sum = ["attention", "needs-client", "awaiting", "adjusted", "verified"].filter(c => counts[c])
        .map(c => `<span class="check-pill ${c}">${counts[c]} ${{attention: "need attention", "needs-client": "need client", awaiting: "awaiting", adjusted: "adjusted", verified: "verified"}[c]}</span>`).join("");
      const partial = form.status === "partial" ? `<span class="check-pill attention">${esc(form.missing_pages.map(p => `${p.label.toLowerCase()} missing`).join(", "))}</span>` : "";
      return `<details class="check-form"><summary>${esc(form.form)} ${partial}${sum}</summary>
        <div class="field-table"><table><tr><th>Field</th><th>Value</th><th>Status</th></tr>${rows.join("")}</table></div></details>`;
    }).join("");
    const exportBtn = ctx.options.exportUrl
      ? `<a class="btn primary" href="${esc(ctx.options.exportUrl)}" download>Export reviewed JSON</a>`
      : '<button type="button" class="btn primary" disabled>Export reviewed JSON</button>';
    return `<div class="review-tab">${triageCard}${sweepEntryCard(ctx)}<div class="client-columns">${awaitingCard}${emailSection(ctx)}</div>
      <section class="card export-card"><div class="review-actions">${exportBtn}
        <span class="sub">Confirmed and corrected values replace what was read; items still open or awaiting the client keep their flags.</span></div></section>
      ${ctx.options.payloadUrl ? '<section class="card payload-card" id="payload-card"><h2>PrismHR payload preview</h2><p class="summary">Building the payload…</p></section>' : ""}
      <section class="card"><h2>Field checklist</h2>${checklist}</section></div>`;
  }

  // ---------- PrismHR payload preview ----------
  // What the reviewed packet would send to importEmployees (built by the server from the reviewed
  // JSON, the same as payload.py). Demo only: nothing is sent.
  const maskSsn = v => /^\d{3}-\d{2}-\d{4}$/.test(v || "") ? `•••-••-${v.slice(-4)}` : v;
  async function fillPayloadCard(container) {
    const ctx = container._ctx, card = container.querySelector("#payload-card");
    if (!card) return;
    const ticket = ctx.payloadTicket = (ctx.payloadTicket || 0) + 1;
    let p;
    try { p = await (await fetch(ctx.options.payloadUrl)).json(); } catch { return; }
    if (ticket !== ctx.payloadTicket || !container.contains(card)) return;  // a newer render took over
    const codes = ctx.options.codes || {}, e = p.employee || {}, client = codes.client || {};
    const coded = (code, table) => code ? `<b>${esc(code)}</b> <span class="muted">${esc((codes[table] || {})[code] || "")}</span>`
                                        : '<span class="payload-missing">no code</span>';
    const rows = [
      ["Client", `<b>${esc(p.client_id)}</b> <span class="muted">${esc(client.name || "")}</span>`],
      ["Employee", esc(`${e.firstName || ""} ${e.lastName || ""}`.trim() || "—")],
      ["SSN", esc(maskSsn(e.ssn) || "—")], ["Email", esc(e.email || "—")], ["Hire date", esc(e.hireDate || "—")],
      ["Job code", coded(e.jobCode, "job_codes")], ["Benefit group", `<b>${esc(e.benefitGroup || "—")}</b>`],
      ["Location", coded(e.locationCode, "location_codes")], ["Employee type", coded(e.employeeType, "employee_types")],
      ["Status", coded(e.employeeStatus, "employee_statuses")],
      ["Pay group", `<b>${esc(e.payGroup || "—")}</b> <span class="muted">${esc(client.pay_frequency || "")}</span>`],
    ];
    const raw = JSON.stringify({...p, employee: {...e, ssn: maskSsn(e.ssn)}}, null, 2);
    card.innerHTML = `<div class="card-head"><h2>PrismHR payload preview</h2><span class="em-status ${p.ready_to_import ? "sent" : "draft"}">${
        p.ready_to_import ? "&#10003; Ready to import" : `Not ready — ${p.blockers.length} blocker${p.blockers.length === 1 ? "" : "s"}`}</span></div>
      <p class="summary">Demo payload, nothing is sent: no PrismHR credentials were provided, so this shows what would be POSTed to <code>importEmployees</code>.</p>
      <table class="payload-table">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
      ${p.blockers.length ? `<div class="payload-blockers"><b>Blocking the import:</b><ul>${p.blockers.map(b => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
      <details class="payload-raw"><summary>Payload JSON</summary><pre>${esc(raw)}</pre></details>`;
  }

  // ---------- client email draft ----------
  // Items for the client: missing or invalid required items still open, everything confirmed missing
  // or marked unreadable, and everything already requested.
  function emailItems(ctx) {
    return ctx.items.filter(i => {
      const st = itemState(ctx, i);
      if (st === "needs_client" || st === "requested") return true;
      return st === "open" && (i.tags.includes("missing") || i.tags.includes("validation"));
    });
  }
  function emailLine(ctx, i) {
    const d = decisionOf(ctx, i);
    const label = i.kind === "field" ? (fieldSource(ctx, i.form.form, i.field.field) || {label: i.title}).label.replace(/ row$/, "") : i.title;
    if ((d && d.action === "unreadable") || i.tags.includes("scribble")) return `- ${label}: we couldn't read it (crossed out or unclear)`;
    if (i.tags.includes("validation") && !(d && d.action === "confirmed_missing")) {
      const e = (ctx.data.validation_errors || []).find(x => i.kind === "field" && x.form === i.form.form && x.field === i.field.field);
      return `- ${label}: ${e && e.suspected_type ? "this looks like it was written on the wrong line" : friendlyReason(e)}`;
    }
    if (i.kind === "missing_page") return `- Please resend the ${i.page.label.toLowerCase()} (page ${i.page.page}): it's missing from the scan.`;
    if (i.kind === "group" || (i.kind === "field" && i.field.single_choice) || /checkbox/i.test(label)) return `- ${label}: no box is checked`;
    return `- ${label}: left blank`;
  }
  // Validation reasons in words a client would use.
  const FRIENDLY = [[/^SSN/, "the Social Security number should have 9 digits"], [/^Phone/, "the phone number should have 10 digits"],
    [/^ZIP/, "the ZIP code should have 5 digits"], [/email/i, "the email address looks incomplete"], [/^Routing/, "the routing number should have 9 digits"],
    [/calendar date/, "the date is incomplete or unclear"], [/in the future/, "the date of birth is in the future"],
    [/before the date of birth/, "the start date is before the date of birth"]];
  const friendlyReason = e => (e && (FRIENDLY.find(([re]) => re.test(e.reason)) || [])[1]) || "please check this value";

  // "Address: Employment Form shows '1 Main St' and Form W-4 shows '1 Main Street'. Please confirm the correct address."
  const TYPE_WORDS = {date: "date", phone: "phone number", ssn: "Social Security number", zip: "ZIP code", email: "email address", routing: "routing number"};
  // "Date" → "date"; keeps "SSN", "ZIP code", "I-9 ..." as written.
  const lowerFirst = t => /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
  function clarifyLine(ctx, i) {
    if (i.kind === "field") {
      const read = (currentField(ctx, i.form.form, i.field.field).value || "").trim();
      const where = `${i.title} on ${shortName(i.form.form)}`;
      if (i.tags.includes("validation")) {
        const type = TYPE_WORDS[formatOf(ctx, i.form.form, i.field.field)] || "value";
        return `- ${where} reads '${read}', which is not a valid ${type}. Please provide the correct ${lowerFirst(i.title)}.`;
      }
      return `- ${where} could not be read clearly (AI read: '${read || "(blank)"}'). Please confirm the correct ${lowerFirst(i.title)}.`;
    }
    const shows = i.sources.map(s => `${s.name} shows '${s.value}'`);
    const listed = shows.length < 3 ? shows.join(" and ") : `${shows.slice(0, -1).join(", ")}, and ${shows[shows.length - 1]}`;
    return `- ${i.conflict.field}: ${listed}. Please confirm the correct ${conflictNoun(i.conflict)}.`;
  }

  function emailDraft(ctx, items) {
    const name = employeeName(ctx.effective) || "the new hire";
    const emp = (ctx.effective.forms || []).find(f => f.form === EMP);
    const company = emp && (emp.fields.find(f => f.field === "Company") || {}).value;
    const byForm = new Map(), missingForms = [], clarify = [];
    for (const i of items) {
      if (i.kind === "conflict" || isClarify(ctx, i)) { clarify.push(i); continue; }
      if (i.kind === "missing_form") { missingForms.push(i); continue; }
      const f = i.forms[0];
      byForm.set(f, [...(byForm.get(f) || []), i]);
    }
    const missing = [
      ...missingForms.map(i => `${shortName(i.title)}:\n- This form is missing from the packet. Please have ${name} complete and sign it.`),
      ...[...byForm].map(([form, list]) => `${shortName(form)}:\n${list.map(i => emailLine(ctx, i)).join("\n")}`),
    ];
    const sections = [
      missing.length ? `MISSING ITEMS\n\n${missing.join("\n\n")}` : "",
      clarify.length ? `PLEASE CLARIFY\nWe can't tell from the scan which value is right:\n${clarify.map(i => clarifyLine(ctx, i)).join("\n")}` : "",
    ].filter(Boolean);
    const asks = [missing.length && "missing or need a correction", clarify.length && "need clarifying"].filter(Boolean).join(", and some that ");
    return {
      subject: `${name} — new hire packet: a few items needed`,
      body: `Hi,\n\nWe're processing the new hire packet for ${name}${company ? ` at ${company}` : ""}. Before we can finish setting them up, we need a few items that are ${asks}:\n\n${sections.join("\n\n")}\n\nCould you ${[missing.length && "send the missing information (or a corrected copy of these pages)", clarify.length && "confirm the correct values"].filter(Boolean).join(" and ")}? Thank you!\n`,
    };
  }

  // The draft is generated from the items; once the reviewer edits it, their text is kept
  // (ctx.state.email) until they reset it. "sig" notes which items the edit was made for.
  function emailSection(ctx) {
    const items = emailItems(ctx), draft = emailDraft(ctx, items);
    const sig = items.map(i => i.key).join("|");
    const edit = ctx.state.email;
    const text = edit || draft, stale = edit && edit.sig !== sig;
    const saved = ctx.options.emailDraft;
    const clarify = items.filter(i => i.kind === "conflict" || isClarify(ctx, i)).length;
    if (!items.length) return `<section class="card email-card"><h2>Client email</h2><p class="summary">Nothing to ask the client for.</p></section>`;
    const sentLine = saved && saved.sent ? `<span class="em-status sent">&#10003; Email sent ${esc(shortWhen(saved.sent))}</span>`
                   : saved ? '<span class="em-status draft">Draft saved, not yet sent</span>' : "";
    return `<section class="card email-card"><div class="card-head"><h2>Client email</h2>${sentLine}</div>
      <p class="summary">${items.length - clarify} missing or to correct${clarify ? ` · ${clarify} to clarify` : ""}. Saving marks them "requested" (awaiting client). Nothing is sent automatically — send it from your email app, then mark it sent.${
        saved ? ` Last saved ${esc(new Date(saved.saved).toLocaleString())}.` : ""}</p>
      ${stale ? `<p class="banner">The items changed since you edited this draft. <button type="button" class="btn small" data-action="email-reset">Regenerate</button></p>` : ""}
      <label class="em-field">Subject <input type="text" class="em-subject" value="${esc(text.subject)}"></label>
      <label class="em-field">Message <textarea class="em-body" rows="16">${esc(text.body)}</textarea></label>
      <div class="actions"><button type="button" class="btn primary" data-action="email-save" ${ctx.options.emailUrl ? "" : "disabled"}>Save draft</button>
        <button type="button" class="btn" data-action="email-copy">Copy to clipboard</button>
        <a class="btn" data-action="email-mailto" href="#">Open in email app</a>
        <button type="button" class="btn" data-action="email-sent" ${saved && !saved.sent && ctx.options.emailSentUrl ? "" : "disabled"}
          title="${saved ? (saved.sent ? "This draft is marked sent" : "Record that you sent this draft") : "Save the draft first"}">Mark as sent</button>
        ${edit ? '<button type="button" class="btn ghost" data-action="email-reset">Reset to generated text</button>' : ""}</div></section>`;
  }
  function emailText(container) {
    const card = container.querySelector(".email-card");
    return {subject: card.querySelector(".em-subject").value, body: card.querySelector(".em-body").value};
  }
  async function markEmailSent(container) {
    const ctx = container._ctx;
    const res = await fetch(ctx.options.emailSentUrl, {method: "POST"});
    if (!res.ok) return alert(`Marking sent failed (${res.status})`);
    const saved = await res.json();
    ctx.decisions = saved.decisions;
    ctx.activity = saved.activity;
    ctx.options.emailDraft = saved.emailDraft;
    showToast(container, `Marked sent — ${shortWhen(saved.emailDraft.sent)}`);
    draw(container);
  }
  // A short nudge listing only what the client still owes.
  function followUpEmail(ctx) {
    const name = employeeName(ctx.effective) || "the new hire", items = awaitingSent(ctx);
    const first = items.map(i => decisionOf(ctx, i).sent).sort()[0];
    const lines = items.map(i => i.kind === "missing_form" ? `- ${shortName(i.title)}: the completed, signed form`
      : (i.kind === "conflict" || isClarify(ctx, i)) ? clarifyLine(ctx, i) : emailLine(ctx, i).replace(/^- /, `- ${shortName(i.forms[0] || "")}: `));
    return `Subject: Following up — ${name} new hire packet\n\nHi,\n\nFollowing up on our email from ${new Date(first).toLocaleDateString(undefined, {month: "short", day: "numeric"})} about ${name}'s new hire packet. We're still waiting on:\n\n${lines.join("\n")}\n\nThank you!\n`;
  }

  async function saveEmail(container) {
    const ctx = container._ctx, {subject, body} = emailText(container);
    const items = emailItems(ctx).map(i => ({key: i.key, title: i.title, form: i.subtitle}));
    const res = await fetch(ctx.options.emailUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({subject, body, items})});
    if (!res.ok) return alert(`Saving failed (${res.status})`);
    const saved = await res.json();
    ctx.decisions = saved.decisions;
    ctx.activity = saved.activity;
    ctx.options.emailDraft = saved.emailDraft;
    // Keep the saved text on screen (the item list now reads "requested"; same keys).
    ctx.state.email = {subject, body, sig: emailItems(ctx).map(i => i.key).join("|")};
    showToast(container, `Draft saved — ${items.length} item${items.length === 1 ? "" : "s"} awaiting client`);
    draw(container);
  }

  // The catalog's current requirement rules (from the web app) replace the ones stored with the
  // extraction, so a rule fix also applies to packets read before it.
  const RULE_FIELDS = ["required", "required_group", "group_option", "required_if", "required_if_matches", "required_if_label",
                       "optional_if_matches", "optional_if_label", "required_with", "required_with_label", "single_choice"];
  function applyRules(data, rules) {
    if (!rules) return;
    for (const form of data.forms || []) for (const f of form.fields) {
      const rule = (rules[form.form] || {})[f.field];
      if (!rule) continue;
      for (const k of RULE_FIELDS) delete f[k];
      Object.assign(f, rule);
    }
  }

  // Dates everywhere in the canonical M/D/YYYY, also for packets read before that was the rule.
  function canonicalDates(data, decisions, formats) {
    const isDate = (form, field) => ((formats || {})[form] || {})[field] === "date" ||
      (((data.forms || []).find(f => f.form === form) || {fields: []}).fields.find(x => x.field === field) || {}).format === "date";
    for (const form of data.forms || []) for (const f of form.fields) {
      const c = isDate(form.form, f.field) && canonicalDate(f.value);
      if (c && c !== f.value) { if (!f.read_as) f.read_as = f.value; f.value = c; }
    }
    for (const c of data.conflicts || []) {
      const vals = Object.values(c.values || {});
      if (!vals.length || !vals.every(v => canonicalDate(v))) continue;
      for (const k of Object.keys(c.values)) c.values[k] = canonicalDate(c.values[k]);
      if (c.majority) c.majority = canonicalDate(c.majority) || c.majority;
    }
    for (const e of data.validation_errors || []) if (isDate(e.form, e.field)) e.value = canonicalDate(e.value) || e.value;
    for (const d of Object.values(decisions || {})) for (const o of d.fields || []) {
      if (isDate(o.form, o.field)) o.value = canonicalDate(o.value) || o.value;
    }
  }

  function render(container, data, options = {}) {
    const saved = options.decisions || {decisions: {}, activity: []};
    applyRules(data, options.rules);
    canonicalDates(data, saved.decisions, options.formats);
    window.__packetData = data;  // for shortName()
    SHORT_NAMES.clear();
    const ctx = {
      data, options, imageBase: options.imageBase || "", decisions: saved.decisions || {}, activity: saved.activity || [],
      state: {tab: "triage", filters: new Set(), form: "", selected: null, dashboardOpen: false,
              formsForm: null, cards: {}},
      groups: new Map(),
    };
    ctx.items = buildItems(ctx);
    readHash(ctx);
    container._ctx = ctx;  // the latest data, for the click handler below
    if (options.adding && options.adding.status === "running") { ctx.adding = options.adding; setTimeout(() => pollPages(container), 0); }
    const justAdded = sessionStorage.getItem("packetReview.added");
    if (justAdded) {
      sessionStorage.removeItem("packetReview.added");
      const a = JSON.parse(justAdded);
      setTimeout(() => showToast(container, `Added page${a.pages.length === 1 ? "" : "s"} ${a.pages.join(", ")} — ${a.changed} field${a.changed === 1 ? "" : "s"} new or changed, now in Triage`), 0);
    }
    if (!container.dataset.wired) {  // listeners once per container
      container.dataset.wired = "1";
      container.addEventListener("click", e => onClick(container, e));
      document.addEventListener("keydown", e => onKey(container, e));
      for (const type of ["input", "change"]) container.addEventListener(type, e => {
        const panel = e.target.closest(".detail-card");
        if (panel) syncConflictChoice(panel, e);
        if (type === "change" && e.target.matches('input[data-action="add-pages"]') && e.target.files[0]) return uploadPages(container, e.target.files[0]);
        if (e.target.matches(".em-subject, .em-body")) {  // keep the reviewer's edits across redraws
          const c = container._ctx;
          c.state.email = {...emailText(container), sig: emailItems(c).map(i => i.key).join("|")};
        }
      });
      window.addEventListener("hashchange", () => { readHash(container._ctx); draw(container); });
    }
    draw(container);
  }

  window.PacketReview = {render};
})();
