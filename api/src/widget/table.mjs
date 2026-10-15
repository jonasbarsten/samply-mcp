// Renders a table with optional row actions for the table widget. Takes the
// document and a send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

/** Seconds as m:ss (or h:mm:ss). Keep in step with formatDuration in src/mcp/tools/table.ts (a test compares them). */
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Bytes as MB with one decimal (kB under a megabyte). Keep in step with formatSize in src/mcp/tools/table.ts. */
function formatSize(bytes) {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const toNumber = (value) => (typeof value === "number" ? value : String(value).trim() === "" ? Number.NaN : Number(value));

/** A duration or size cell formatted; a value that is not a number, or only whitespace, is shown as given. */
function formatCell(kind, value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return String(value);
  return kind === "duration" ? formatDuration(n) : formatSize(n);
}

function cellText(column, value) {
  if (value === undefined || value === null) return "";
  return column.kind === "duration" || column.kind === "size" ? formatCell(column.kind, value) : String(value);
}

/**
 * `acted` holds the indexes of rows whose action was already sent. The page keeps it across re-renders of the same
 * table, so a replayed tool result shows those rows disabled instead of offering the action again.
 */
function renderTable(doc, root, data, send, acted = new Set()) {
  let hint;
  const title = doc.createElement("p");
  title.className = "title";
  title.textContent = data.title;
  root.append(title);

  const wrap = doc.createElement("div");
  wrap.className = "scroll";
  const table = doc.createElement("table");
  const head = doc.createElement("tr");
  for (const column of data.columns) {
    const th = doc.createElement("th");
    th.textContent = column.label;
    if (column.kind === "duration" || column.kind === "size") th.className = "num";
    head.append(th);
  }
  const hasActions = data.rows.some((row) => row.actions?.length);
  if (hasActions) head.append(doc.createElement("th"));
  table.append(head);

  data.rows.forEach((row, index) => {
    const tr = doc.createElement("tr");
    for (const column of data.columns) {
      const td = doc.createElement("td");
      td.textContent = cellText(column, row.cells?.[column.key]);
      if (column.kind === "duration" || column.kind === "size") td.className = "num";
      tr.append(td);
    }
    if (hasActions) {
      const td = doc.createElement("td");
      td.className = "actions";
      const buttons = [];
      for (const action of row.actions ?? []) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = action.label;
        b.disabled = acted.has(index);
        b.addEventListener("click", () => {
          if (acted.has(index)) return;
          acted.add(index);
          for (const other of buttons) other.disabled = true;
          send(action.message);
          // ChatGPT sends the message at once, Claude puts it in the composer; say so once, however many rows are used.
          if (!hint) {
            hint = doc.createElement("p");
            hint.className = "hint";
            hint.textContent = "Your answer was sent to the chat. If it sits in the message box, press send.";
            root.append(hint);
          }
        });
        buttons.push(b);
        td.append(b);
      }
      tr.append(td);
    }
    table.append(tr);
  });
  wrap.append(table);
  root.append(wrap);

  if (data.note) {
    const note = doc.createElement("p");
    note.className = "note";
    note.textContent = data.note;
    root.append(note);
  }
}

export { renderTable, formatDuration, formatSize, cellText };
