// Cloudflare Worker (TypeScript) — Porto de Santos: Expected Cargo Vessels
// Saída 100% em inglês nos campos *_en. CORS liberado. API key opcional.

export interface Env {
  API_KEY?: string; // opcional: se definido, exigir header x-api-key com este valor
}

const SOURCE_URL =
  "https://www.portodesantos.com.br/informacoes-operacionais/operacoes-portuarias/navegacao-e-movimento-de-navios/navios-esperados-carga/";

/* ------------------------------ Helpers ------------------------------ */
function cleanHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:span|strong|em|b|i|u|font|small|big|div)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function onlyDigits(s?: string | null): string {
  return (s || "").replace(/[^\d]/g, "");
}

function parseLenDraft(cell: string | undefined) {
  // exemplos: "183 10.5", "229 12.8", "-/16", "200 7"
  if (!cell) return { length_m: null as number | null, draft_m: null as number | null };
  const nums = cell.replace(",", ".").match(/-?\d+(?:\.\d+)?/g);
  const length_m = nums && nums[0] ? parseFloat(nums[0]) : null;
  const draft_m = nums && nums[1] ? parseFloat(nums[1]) : null;
  return { length_m, draft_m };
}

function pad2(n: number) {
  return n < 10 ? "0" + n : String(n);
}

/** dd/mm/yyyy HH:MM[:SS]? -> ISO(-03:00) + timestamp */
function parseBRDateTimeToISO(s?: string | null) {
  if (!s) return { iso: null as string | null, ts: null as number | null };
  const m = s
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return { iso: null, ts: null };
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  const HH = parseInt(m[4], 10);
  const MM = parseInt(m[5], 10);
  const SS = m[6] ? parseInt(m[6], 10) : 0;

  const iso = `${yyyy}-${pad2(mm)}-${pad2(dd)}T${pad2(HH)}:${pad2(MM)}:${pad2(
    SS
  )}-03:00`;
  const ts = Date.parse(iso);
  return { iso, ts: isNaN(ts) ? null : ts };
}

/* ----------------------- Notice (PT code -> EN) ---------------------- */
function noticeToEN(code?: string | null): string | null {
  const c = (code || "").toUpperCase().replace(/\s+/g, "");
  if (!c) return null;
  if (c === "EMB") return "Load";
  if (c === "DESC") return "Unload";
  if (c === "EMBDESC" || c === "DESCEMB") return "Load & Unload";
  return null;
}

/* -------------------------- Flag PT -> EN ---------------------------- */
function norm(s?: string | null) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FLAG_PT_EN: Record<string, string> = {
  // Registros marítimos + adjetivos
  "chipre": "Cyprus", "cipriota": "Cyprus",
  "panama": "Panama", "panamenha": "Panama",
  "liberia": "Liberia", "liberiana": "Liberia",
  "malta": "Malta", "maltesa": "Malta",
  "ilhas marshall": "Marshall Islands", "marshall": "Marshall Islands",

  // Europa
  "portugal": "Portugal", "portugues": "Portugal", "portuguesa": "Portugal",
  "franca": "France", "francesa": "France",
  "espanha": "Spain", "espanhola": "Spain",
  "italia": "Italy", "italiana": "Italy",
  "alemanha": "Germany", "alemã": "Germany",
  "reino unido": "United Kingdom", "inglaterra": "United Kingdom", "uk": "United Kingdom",
  "paises baixos": "Netherlands", "países baixos": "Netherlands", "holanda": "Netherlands",
  "belgica": "Belgium", "bélgica": "Belgium",
  "grecia": "Greece", "grega": "Greece",
  "noruega": "Norway", "norueguesa": "Norway",
  "dinamarca": "Denmark", "suecia": "Sweden", "suécia": "Sweden", "finlandia": "Finland",

  // Américas
  "brasil": "Brazil", "brasileira": "Brazil",
  "bahamas": "Bahamas", "bahamense": "Bahamas",
  "estados unidos": "United States", "eua": "United States", "usa": "United States",
  "canada": "Canada", "canadá": "Canada",
  "mexico": "Mexico", "méxico": "Mexico",
  "argentina": "Argentina", "uruguai": "Uruguay", "paraguai": "Paraguay",

  // Ásia / Oriente Médio
  "china": "China", "hong kong": "Hong Kong", "taiwan": "Taiwan",
  "japao": "Japan", "japão": "Japan",
  "coreia do sul": "South Korea", "coreia, republica da": "South Korea", "coreia": "South Korea",
  "singapura": "Singapore", "singapurense": "Singapore",
  "india": "India", "indiana": "India",
  "indonesia": "Indonesia",
  "malasia": "Malaysia", "malásia": "Malaysia",
  "emirados arabes unidos": "United Arab Emirates", "emirados árabes unidos": "United Arab Emirates",
  "arabia saudita": "Saudi Arabia", "arábia saudita": "Saudi Arabia",
};

function toFlagEN(raw?: string | null): string {
  const n = norm(raw);
  if (!n) return "-";
  if (FLAG_PT_EN[n]) return FLAG_PT_EN[n];

  // heurísticas
  if (/\bportug/.test(n)) return "Portugal";
  if (/\bnorueg/.test(n)) return "Norway";
  if (/\bpanamen/.test(n)) return "Panama";
  if (/\bbaham/.test(n)) return "Bahamas";
  if (/\bindian(?!o)/.test(n)) return "India";
  if (/\bchipr/.test(n)) return "Cyprus";
  if (/hong\s*kong/.test(n)) return "Hong Kong";
  if (/\bliberi/.test(n)) return "Liberia";
  if (/\bmaltes?/.test(n) || /\bmalta\b/.test(n)) return "Malta";
  if (/\bbrasil/.test(n) || /\bbrasileir/.test(n)) return "Brazil";
  if (/\bmarshall/.test(n) || /ilhas?\s*marshall/.test(n)) return "Marshall Islands";

  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "-";
}

/* ---------------------- Goods (PT) -> English ----------------------- */
function goodsToEN(raw?: string | null): string | null {
  const t = (raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!t) return null;

  // Liquids / oil
  if (/oleo\s*combustivel/.test(t)) return "Fuel Oil";
  if (/oleo\s*diesel|diesel/.test(t)) return "Diesel Oil";
  if (/oleo\s*lubrificante/.test(t)) return "Lubricating Oil";
  if (/gasolina/.test(t)) return "Gasoline";
  if (/etanol|alcool\s*etilico/.test(t)) return "Ethanol";
  if (/nafta/.test(t)) return "Naphtha";
  if (/querosene/.test(t)) return "Kerosene";
  if (/\bglp\b/.test(t)) return "LPG";
  if (/gas\s*liquefeit/.test(t)) return "Liquefied Gas";

  // Containers
  if (/container|conteiner/.test(t)) return "Containers";

  // Bulk / solids
  if (/fertiliz/.test(t)) return "Fertilizers";
  if (/acucar/.test(t)) return "Sugar";
  if (/milho/.test(t)) return "Corn";
  if (/soja/.test(t)) return "Soybeans";
  if (/trigo/.test(t)) return "Wheat";
  if (/\bsal\b/.test(t)) return "Salt";
  if (/celulose|papel\s*e\s*celulose/.test(t)) return "Wood Pulp";
  if (/pellets?/.test(t)) return "Pellets";
  if (/coque/.test(t)) return "Coke";

  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : null;
}

/* ------------------ Cargo category (EN from text) ------------------- */
function categoryENFromText(
  ...parts: (string | undefined)[]
): "Container" | "Liquid (Oil)" | "Bulk" | "Other" {
  const t = parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/container|conteiner/.test(t)) return "Container";
  if (/\boleo\b|\bcombustivel\b|\bdiesel\b|\bgasolina\b|\betanol\b|\bnafta\b|\bquerosene\b|\bglp\b|\bgas\s*liquefeit/.test(t))
    return "Liquid (Oil)";
  if (/\bgranel\b|\bmilho\b|\bsoja\b|\btrigo\b|\bsal\b|\bacucar\b|\bfertiliz|\bcelulose|\bpapel|\bpellets?\b|\bcoque\b/.test(t))
    return "Bulk";
  return "Other";
}

/* ------------------------- HTML -> rows (td) ------------------------ */
function extractRows(html: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const rowHtml = m[1];
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(rowHtml))) {
      const text = cleanHtml(c[1]);
      cells.push(text);
    }
    // Ignorar cabeçalhos
    const join = cells.join("|").toLowerCase();
    if (cells.length >= 8 && !/navio.*bandeira|ship.*flag/.test(join)) {
      rows.push(cells);
    }
  }
  return rows;
}

/* --------------------- Mapear uma linha (ajustado) ------------------ */
function mapRowToShip(cells: string[]) {
  // Layout atual (colunas principais):
  // 0 Ship | 1 Flag | 2 Length/Draft | 3 Nav | 4 Arrival | 5 (outro Nav nº)
  // 6 Agency | 7 Notice(EMB/DESC/EMBDESC) | 8 Goods | 9 Weight | 10 Voyage
  // 11 DUV | 12 DUV Class | 13 Pier/Terminal | 14 IMO
  const shipName   = cells[0] || null;
  const flagPT     = cells[1] || null;
  const lenDraft   = parseLenDraft(cells[2]);
  const arrival    = parseBRDateTimeToISO(cells[4] || null);
  const agency     = cells[6] || null;
  const noticeCode = (cells[7] || "").toUpperCase().replace(/\s+/g, "");
  const goodsPT    = cells[8] || null;
  const weight     = cells[9] || null;
  const voyage     = cells[10] || null;
  const duv        = cells[11] || null;
  const duvClass   = cells[12] || null;
  const pier       = cells[13] || null;
  const lastCell   = cells[14] || cells[cells.length - 1] || "";

  // IMO na última coluna, com zeros à esquerda às vezes
  let imo: string | null = null;
  const imoDigits = onlyDigits(lastCell);
  if (imoDigits) {
    let trimmed = imoDigits.replace(/^0+/, "");
    // evitar confundir com DUV
    if (trimmed.length >= 7 && trimmed.length <= 9 && trimmed !== onlyDigits(duv || "")) {
      if (trimmed.length === 8 && trimmed.startsWith("0")) trimmed = trimmed.slice(1);
      if (trimmed.length >= 7 && trimmed.length <= 8) imo = trimmed;
    }
  }

  const flag_en = toFlagEN(flagPT);
  const notice_en = noticeToEN(noticeCode);
  const goods_en = goodsToEN(goodsPT);
  const cargo_category_en = categoryENFromText(goodsPT || "", cells[7] || "");

  return {
    imo,
    ship: shipName,
    flag_en,
    arrival_text: cells[4] || null,
    arrival_iso: arrival.iso,
    arrival_ts: arrival.ts,
    notice_en,
    agency,
    pier,                    // código/alcunha do cais
    terminal_name: pier,     // nome humano do terminal (para a UI)
    goods_en,                // nome da mercadoria em EN
    cargo_category_en,       // categoria em EN

    // extras (não usados na UI, mas úteis)
    length_m: lenDraft.length_m,
    draft_m: lenDraft.draft_m,
    weight: weight || null,
    voyage: voyage || null,
    duv: duv || null,
    duv_class: duvClass || null,

    _raw: cells, // removido se ?includeRaw != 1
  };
}

/* ------------------------------ Worker ------------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      // Proteção opcional por API key
      if (env.API_KEY) {
        const key = req.headers.get("x-api-key");
        if (key !== env.API_KEY) return json({ error: "Unauthorized" }, 401);
      }

      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("ok", { headers: corsHeaders() });
      }

      // Buscar página fonte
      const upstream = await fetch(SOURCE_URL, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!upstream.ok) return json({ error: `Upstream HTTP ${upstream.status}` }, 502);
      const html = await upstream.text();

      // Extrair e mapear
      const rows = extractRows(html);
      const ships = rows.map(mapRowToShip);

      // Depuração opcional
      const includeRaw = url.searchParams.get("includeRaw") === "1";
      if (!includeRaw) for (const s of ships) delete (s as any)._raw;

      const body = {
        source: SOURCE_URL,
        updatedAt: new Date().toISOString(),
        count: ships.length,
        ships,
      };

      const pretty = url.searchParams.get("pretty") === "1";
      return new Response(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders(),
          "cache-control": "public, max-age=60",
        },
      });
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};

/* ---------------------------- Resp helpers -------------------------- */
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "x-api-key, content-type",
  };
}
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
