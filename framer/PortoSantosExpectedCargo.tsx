import * as React from "react";
import useSWR from "swr";
import { addPropertyControls, ControlType } from "framer";

type Ship = {
  eta?: string;
  ship?: string;
  imo?: string;
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;
  cargo?: string | null;
  terminal?: string | null;
  priority?: string | null;
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
  sortBy: "eta" | "ship" | "terminal";
};

const fetcher = (url: string, apiKey?: string) =>
  fetch(url, { headers: apiKey ? { "x-api-key": apiKey } : undefined }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

export default function PortoSantosExpectedCargo(props: Partial<Props>) {
  const {
    apiUrl = "https://porto-santos-lineup.filippe.workers.dev",
    apiKey,
    refreshMs = 60_000,
    maxRows = 50,
    filterText = "",
    sortBy = "eta",
  } = props || {};

  const { data, error, isLoading } = useSWR<ApiResponse>(
    apiUrl ? [apiUrl, apiKey] : null,
    ([url, key]) => fetcher(url, key),
    { refreshInterval: refreshMs }
  );

  if (!apiUrl) return <Box>Configure o <b>API URL</b> nas propriedades.</Box>;
  if (error) return <Box>Falha ao carregar: {String(error)}</Box>;
  if (isLoading || !data) return <Box>Carregando navios esperados…</Box>;

  let ships = data.ships || [];

  // filtro simples por texto
  const q = (filterText || "").toLowerCase();
  if (q) {
    ships = ships.filter(
      (s) =>
        (s.ship || "").toLowerCase().includes(q) ||
        (s.terminal || "").toLowerCase().includes(q) ||
        (s.cargo || "").toLowerCase().includes(q)
    );
  }

  // ordenação simples
  ships = [...ships].sort((a, b) => {
    const aV = (a[sortBy] as any) ?? "";
    const bV = (b[sortBy] as any) ?? "";
    return String(aV).localeCompare(String(bV), "pt-BR", { numeric: true });
  });

  if (maxRows > 0) ships = ships.slice(0, maxRows);

  return (
    <div style={container}>
      <div style={meta}>
        <span>
          Fonte:{" "}
          <a href={data.source} target="_blank" rel="noreferrer">
            Porto de Santos
          </a>
        </span>
        <span>Atualizado: {new Date(data.updatedAt).toLocaleString("pt-BR")}</span>
        <span>Registros: {data.count}</span>
      </div>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {[
                "ETA",
                "Navio",
                "IMO",
                "Compr. (m)",
                "Calado (m)",
                "Navegação",
                "Carga",
                "Terminal",
                "Prioridade",
              ].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ships.map((s, i) => (
              <tr key={i} style={tr}>
                <td style={td}>{s.eta || "-"}</td>
                <td style={td}>{s.ship || "-"}</td>
                <td style={td}>{s.imo || "-"}</td>
                <td style={td}>{s.length_m ?? "-"}</td>
                <td style={td}>{s.draft_m ?? "-"}</td>
                <td style={td}>{s.nav ?? "-"}</td>
                <td style={td}>{s.cargo ?? "-"}</td>
                <td style={td}>{s.terminal ?? "-"}</td>
                <td style={td}>{s.priority ?? "-"}</td>
              </tr>
            ))}
            {ships.length === 0 && (
              <tr>
                <td colSpan={9} style={{ ...td, opacity: 0.7 }}>
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const container: React.CSSProperties = {
  fontFamily: "Inter, system-ui, sans-serif",
  padding: 12,
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const meta: React.CSSProperties = {
  display: "flex",
  gap: 16,
  fontSize: 12,
  opacity: 0.8,
  alignItems: "center",
  flexWrap: "wrap",
};
const tableWrap: React.CSSProperties = {
  overflow: "auto",
  borderRadius: 12,
  border: "1px solid #eee",
  flex: 1,
};
const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: 0,
  fontSize: 13,
};
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontWeight: 600,
  borderBottom: "1px solid #eee",
  position: "sticky",
  top: 0,
  background: "#fff",
};
const tr: React.CSSProperties = { borderTop: "1px solid #f3f3f3" };
const td: React.CSSProperties = { padding: "8px 12px", whiteSpace: "nowrap" };

function Box({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 12, fontFamily: "Inter, system-ui, sans-serif" }}>{children}</div>;
}

addPropertyControls(PortoSantosExpectedCargo, {
  apiUrl: { type: ControlType.String, title: "API URL", defaultValue: "https://SEU-ENDPOINT.workers.dev" },
  apiKey: { type: ControlType.String, title: "API Key (opcional)" },
  refreshMs: { type: ControlType.Number, title: "Refresh (ms)", min: 0, max: 3600000, defaultValue: 60000 },
  maxRows: { type: ControlType.Number, title: "Máx. Linhas", min: 0, max: 1000, defaultValue: 50 },
  filterText: { type: ControlType.String, title: "Filtro" },
  sortBy: {
    type: ControlType.Enum,
    title: "Ordenar por",
    options: ["eta", "ship", "terminal"],
    optionTitles: ["ETA", "Navio", "Terminal"],
    defaultValue: "eta",
  },
});
