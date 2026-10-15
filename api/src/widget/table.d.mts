export interface TableColumn {
  key: string;
  label: string;
  kind?: "text" | "duration" | "size" | "date";
}

export interface TableAction {
  label: string;
  message: string;
}

export interface TableRow {
  cells: Record<string, string | number>;
  actions?: TableAction[];
}

export interface TableData {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  note?: string;
}

/** Seconds as m:ss or h:mm:ss. */
export function formatDuration(seconds: number): string;

/** Bytes as kB or MB. */
export function formatSize(bytes: number): string;

/** A cell as the widget shows it; a non-numeric duration or size comes back as given. */
export function cellText(column: TableColumn, value: string | number | null | undefined): string;

/**
 * Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. `acted` holds the indexes of
 * rows whose action was sent; it is read to start those rows disabled and added to on every click.
 */
export function renderTable(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  data: TableData,
  send: (text: string) => void,
  acted?: Set<number>,
): void;
