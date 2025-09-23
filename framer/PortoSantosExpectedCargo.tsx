import * as React from "react";
import { addPropertyControls, ControlType } from "framer";

/** Must match the Worker (src/worker.ts) */
type Ship = {
  imo?: string | null;
  ship?: string | null;
  flag?: string | null;
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;
  arrival_text?: string | null;
  arrival_iso?: string | null;
  arrival_ts?: number | null;
  notice_code?: string | null;
  notice_en?: string | null;
  agency?: string | null;
  operation?: string | null;
  goods?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;
  duv_class?: string | null;
  pier?: string | null;
  terminal?: string | null;
  raw?: string[];
};

type ApiResponse = {
  source: string;
  updatedAt: string;
  count: number;
  ships: Ship[];
};

type Props = {
  apiUrl: string;
  apiKey?: string;
  refreshMs: number;
  maxRows: number;
  filterText: string;
  sortBy: "arrival" | "ship" | "terminal";
  sortDir: "asc" | "desc";

  columnOrder: string; // e.g. "imo,ship,flag,lengthDraft,nav,arrival,notice,agency,operation,goods,weight,voyage,duv,duvClass,pier,terminal"
  showIMO: boolean; showShip: boolean; showFlag: boolean; showLengthDraft: boolean; showNav: boolean;
  showArrival: boolean; showNotice: boolean; showAgency: boolean; showOperation: boolean;
  showGoods: boolean; showWeight: boolean; showVoyage: boolean; showDUV: boolean; showDUVClass: boolean; showPier: boolean; showTerminal: boolean;

  lblIMO: string; lblShip: string; lblFlag: string; lblLengthDraft: string; lblNav: string;
  lblArrival: string; lblNotice: string; lblAgency: string; lblOperation: string; lblGoods: string; lblWeight: string; lblVoyage: string; lblDUV: string; lblDUVClass: string; lblPier: string; lblTerminal: string;

  fontSize: number; rowHeight: number; cellPaddingX: number; cellPaddingY: number;
  headerBg: string; headerFg: string; borderColor: string; zebra: boolean; zebraBg: string; stickyHeader: boolean; radius: number;

  showRawInspector: boolean;
};

export default function PortoSantosExpectedCargo(p: Partial<Props>) {
  const {
    apiUrl = "https://porto-santos-lineup.filippe.workers.dev/",
    apiKey, refreshMs = 60_000, maxRows = 500, filterText = "",
    sortBy = "arrival", sortDir = "asc",

    columnOrder = "imo,ship,flag,lengthDraft,nav,arrival,notice,agency,operation,goods,weight,voyage,duv,duvClass,pier,terminal",

    showIMO = true, showShip = true, showFlag = true, showLengthDraft = true, showNav = true,
    showArrival = true, showNotice = true, showAgency = true, showOperation = true,
    showGoods = true, showWeight = true, showVoyage = true, showDUV = true, showDUVClass = false, showPier = true, showTerminal = true,

    lblIMO = "IMO", lblShip = "Ship", lblFlag = "Flag", lblLengthDraft = "Length/Draft (m)", lblNav = "Nav",
    lblArrival = "Arrival (d/m/y)", lblNotice = "Notice", lblAgency = "Agency", lblOperation = "Operation",
    lblGoods = "Goods", lblWeight = "Weight", lblVoyage = "Voyage", lblDUV = "DUV", lblDUVClass = "DUV Class", lblPier = "P", lblTerminal = "Terminal",

    fontSize = 13, rowHeight = 34, cellPaddingX = 12, cellPaddingY = 8,
    headerBg = "#ffffff", headerFg = "#111111", borderColor = "#eeeeee", zebra = false, zebraBg = "#f7f9fc",
    stickyHeader = true, radius = 12,

    showRawInspector = false,
  } = p;

  const [data, setData] = React.useState<ApiResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const fetchData = React.useCallback(() => {
    if (!apiUrl) return;
    setLoading(true); setErr(null);
    const headers: Record<string,string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    fetch(apiUrl, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j: ApiResponse) => setData(j))
      .catch(e => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [apiUrl, apiKey]);

  React.useEffect(() => {
    fetchData();
    if (refreshMs > 0) {
      const id = setInterval(fetchData, refreshMs);
      return () => clearInterval(id);
    }
  }, [fetchData, refreshMs]);

  if (!apiUrl) return <Box>Set the <b>API URL</b> in the right panel.</Box>;
  if (err) return <Box>Error: {err}</Box>;
  if (!data) return <Box>{loading ? "Loading…" : "No data yet."}</Box>;

  const value = (x?: string | number | null) => (x === null || x === undefined || String(x).trim() === "" ? "-" : String(x).trim());
  const lenDraft = (s: Ship) => `${s.length_m ?? "-"} / ${s.draft_m ?? "-"}`;
  const fmtArrival = (s: Ship) =>
    s.arrival_iso
      ? new Date(s.arrival_iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : value(s.arrival_text);

  // Filter
  const q = (filterText || "").toLowerCase();
  let rows = (data.ships || []).filter((s) =>
    !q
      ? true
      : (s.ship || "").toLowerCase().includes(q) ||
        (s.goods || "").toLowerCase().includes(q) ||
        (s.terminal || "").toLowerCase().includes(q) ||
        (s.agency || "").toLowerCase().includes(q)
  );

  // Sort
  rows = rows.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "arrival") {
      const at = a.arrival_ts ?? Number.POSITIVE_INFINITY;
      const bt = b.arrival_ts ?? Number.POSITIVE_INFINITY;
      cmp = at - bt;
    } else if (sortBy === "ship") {
      cmp = (a.ship || "").localeCompare(b.ship || "", "en", { numeric: true, sensitivity: "base" });
    } else {
      cmp = (a.terminal || "").localeCompare(b.terminal || "", "en", { numeric: true, sensitivity: "base" });
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  if (maxRows > 0) rows = rows.slice(0, maxRows);

  // Columns
  type Col = { key: string; label: string; show: boolean; render: (s: Ship) => React.ReactNode };
  const col = (key: string, label: string, show: boolean, render: (s: Ship) => React.ReactNode): Col => ({ key, label, show, render });

  const all: Record<string, Col> = {
    imo:         col("imo", lblIMO, showIMO, (s) => value(s.imo)),
    ship:        col("ship", lblShip, showShip, (s) => value(s.ship)),
    flag:        col("flag", lblFlag, showFlag, (s) => value(s.flag)),
    lengthDraft: col("lengthDraft", lblLengthDraft, showLengthDraft, (s) => lenDraft(s)),
    nav:         col("nav", lblNav, showNav, (s) => value(s.nav)),
    arrival:     col("arrival", lblArrival, showArrival, (s) => fmtArrival(s)),
    notice:      col("notice", lblNotice, showNotice, (s) => value(s.notice_en || s.notice_code)),
    agency:      col("agency", lblAgency, showAgency, (s) => value(s.agency)),
    operation:   col("operation", lblOperation, showOperation, (s) => value(s.operation)),
    goods:       col("goods", lblGoods, showGoods, (s) => value(s.goods)),
    weight:      col("weight", lblWeight, showWeight, (s) => value(s.weight)),
    voyage:      col("voyage", lblVoyage, showVoyage, (s) => value(s.voyage)),
    duv:         col("duv", lblDUV, showDUV, (s) => value(s.duv)),
    duvClass:    col("duvClass", lblDUVClass, showDUVClass, (s) => value(s.duv_class)),
    pier:        col("pier", lblPier, showPier, (s) => value(s.pier)),
    terminal:    col("terminal", lblTerminal, showTerminal, (s) => value(s.terminal)),
  };

  const order = columnOrder.split(",").map((k) => k.trim()).filter(Boolean);
  const columns = (order.length ? order : Object.keys(all))
    .map((k) => all[k as keyof typeof all])
    .filter(Boolean)
    .filter((c) => c.show) as Col[];

  // Styles
  const container: React.CSSProperties = { fontFamily: "Inter, system-ui, sans-serif", width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: 8 };
  const meta: React.CSSProperties = { display: "flex", gap: 12, fontSize: 12, opacity: 0.9, flexWrap: "wrap", alignItems: "center" };
  const wrap: React.CSSProperties = { overflow: "auto", border: `1px solid ${borderColor}`, borderRadius: radius, flex: 1 };
  const table: React.CSSProperties = { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize };
  const th: React.CSSProperties = { textAlign: "left", padding: `${cellPaddingY}px ${cellPaddingX}px`, fontWeight: 600, borderBottom: `1px solid ${borderColor}`, position: stickyHeader ? ("sticky" as const) : undefined, top: 0, background: headerBg, color: headerFg, height: rowHeight, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: `${cellPaddingY}px ${cellPaddingX}px`, borderBottom: `1px solid ${borderColor}`, height: rowHeight, whiteSpace: "nowrap" };
  const trAlt = (i: number): React.CSSProperties => (zebra && i % 2 ? { background: zebraBg } : {});

  return (
    <div style={container}>
      <div style={meta}>
        <span>Source: <a href={data.source} target="_blank" rel="noreferrer">Porto de Santos</a></span>
        <span>Worker updated: {new Date(data.updatedAt).toLocaleString("pt-BR")}</span>
        {loading && <span style={{ opacity: 0.7 }}>Refreshing…</span>}
      </div>

      {showRawInspector && data.ships?.[0]?.raw && (
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          <b>Raw (first row):</b> {data.ships[0].raw.map((v, i) => `[${i}] ${v}`).join(" | ")}
        </div>
      )}

      <div style={wrap}>
        <table style={table}>
          <thead><tr>{columns.map(c => <th key={c.key} style={th}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={i} style={trAlt(i)}>
                {columns.map(c => <td key={c.key} style={td}>{c.render(s)}</td>)}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} style={{ ...td, textAlign: "center", opacity: 0.7 }}>No records found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 12, fontFamily: "Inter, system-ui, sans-serif" }}>{children}</div>;
}

addPropertyControls(PortoSantosExpectedCargo, {
  apiUrl: { type: ControlType.String, title: "API URL", defaultValue: "https://porto-santos-lineup.filippe.workers.dev/" },
  apiKey: { type: ControlType.String, title: "API Key (optional)" },
  refreshMs: { type: ControlType.Number, title: "Refresh (ms)", min: 0, max: 3_600_000, defaultValue: 60_000 },
  maxRows: { type: ControlType.Number, title: "Max rows", min: 0, max: 5000, defaultValue: 500 },
  filterText: { type: ControlType.String, title: "Filter (text)" },
  sortBy: { type: ControlType.Enum, title: "Sort by", options: ["arrival", "ship", "terminal"], optionTitles: ["Arrival", "Ship", "Terminal"], defaultValue: "arrival" },
  sortDir: { type: ControlType.Enum, title: "Sort dir", options: ["asc", "desc"], optionTitles: ["Asc", "Desc"], defaultValue: "asc" },

  columnOrder: { type: ControlType.String, title: "Column order", defaultValue: "imo,ship,flag,lengthDraft,nav,arrival,notice,agency,operation,goods,weight,voyage,duv,duvClass,pier,terminal", displayTextArea: true },

  showIMO: { type: ControlType.Boolean, title: "Show IMO", defaultValue: true },
  showShip: { type: ControlType.Boolean, title: "Show Ship", defaultValue: true },
  showFlag: { type: ControlType.Boolean, title: "Show Flag", defaultValue: true },
  showLengthDraft: { type: ControlType.Boolean, title: "Show Length/Draft", defaultValue: true },
  showNav: { type: ControlType.Boolean, title: "Show Nav", defaultValue: true },
  showArrival: { type: ControlType.Boolean, title: "Show Arrival", defaultValue: true },
  showNotice: { type: ControlType.Boolean, title: "Show Notice", defaultValue: true },
  showAgency: { type: ControlType.Boolean, title: "Show Agency", defaultValue: true },
  showOperation: { type: ControlType.Boolean, title: "Show Operation", defaultValue: true },
  showGoods: { type: ControlType.Boolean, title: "Show Goods", defaultValue: true },
  showWeight: { type: ControlType.Boolean, title: "Show Weight", defaultValue: true },
  showVoyage: { type: ControlType.Boolean, title: "Show Voyage", defaultValue: true },
  showDUV: { type: ControlType.Boolean, title: "Show DUV", defaultValue: true },
  showDUVClass: { type: ControlType.Boolean, title: "Show DUV Class", defaultValue: false },
  showPier: { type: ControlType.Boolean, title: "Show P", defaultValue: true },
  showTerminal: { type: ControlType.Boolean, title: "Show Terminal", defaultValue: true },

  lblIMO: { type: ControlType.String, title: "Label: IMO", defaultValue: "IMO" },
  lblShip: { type: ControlType.String, title: "Label: Ship", defaultValue: "Ship" },
  lblFlag: { type: ControlType.String, title: "Label: Flag", defaultValue: "Flag" },
  lblLengthDraft: { type: ControlType.String, title: "Label: Length/Draft", defaultValue: "Length/Draft (m)" },
  lblNav: { type: ControlType.String, title: "Label: Nav", defaultValue: "Nav" },
  lblArrival: { type: ControlType.String, title: "Label: Arrival", defaultValue: "Arrival (d/m/y)" },
  lblNotice: { type: ControlType.String, title: "Label: Notice", defaultValue: "Notice" },
  lblAgency: { type: ControlType.String, title: "Label: Agency", defaultValue: "Agency" },
  lblOperation: { type: ControlType.String, title: "Label: Operation", defaultValue: "Operation" },
  lblGoods: { type: ControlType.String, title: "Label: Goods", defaultValue: "Goods" },
  lblWeight: { type: ControlType.String, title: "Label: Weight", defaultValue: "Weight" },
  lblVoyage: { type: ControlType.String, title: "Label: Voyage", defaultValue: "Voyage" },
  lblDUV: { type: ControlType.String, title: "Label: DUV", defaultValue: "DUV" },
  lblDUVClass: { type: ControlType.String, title: "Label: DUV Class", defaultValue: "DUV Class" },
  lblPier: { type: ControlType.String, title: "Label: P", defaultValue: "P" },
  lblTerminal: { type: ControlType.String, title: "Label: Terminal", defaultValue: "Terminal" },

  fontSize: { type: ControlType.Number, title: "Font size", min: 10, max: 24, defaultValue: 13 },
  rowHeight: { type: ControlType.Number, title: "Row height", min: 24, max: 64, defaultValue: 34 },
  cellPaddingX: { type: ControlType.Number, title: "Cell pad X", min: 4, max: 32, defaultValue: 12 },
  cellPaddingY: { type: ControlType.Number, title: "Cell pad Y", min: 2, max: 24, defaultValue: 8 },
  headerBg: { type: ControlType.Color, title: "Header bg", defaultValue: "#ffffff" },
  headerFg: { type: ControlType.Color, title: "Header text", defaultValue: "#111111" },
  borderColor: { type: ControlType.Color, title: "Border color", defaultValue: "#eeeeee" },
  zebra: { type: ControlType.Boolean, title: "Zebra rows", defaultValue: false },
  zebraBg: { type: ControlType.Color, title: "Zebra bg", defaultValue: "#f7f9fc" },
  stickyHeader: { type: ControlType.Boolean, title: "Sticky header", defaultValue: true },
  radius: { type: ControlType.Number, title: "Radius", min: 0, max: 24, defaultValue: 12 },

  showRawInspector: { type: ControlType.Boolean, title: "Show raw inspector", defaultValue: false },
});
