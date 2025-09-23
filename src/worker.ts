// Worker v2: header-aware parser + normalization + English operation names

export interface Env {
  SOURCE_URL: string;
  API_KEY?: string;
}

type Row = Record<string, string>;

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
  notice_code?: string | null;   // EMB / DESC / EMBDESC
  notice_en?: string | null;     // Load / Unload / Load & Unload
  agency?: string | null;
  operation?: string | null;
  goods?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;
  priority?: string | null;
  terminal?: string | null;
  raw?: string[];
};

// ---- CORS ----
const ALLOWED_ORIGINS = [
  "https://seachiosbrazil.com",
  "https://www.seachiosbrazil.com",
];
function corsHeaders(origin: string | null) {
  const allow =
    !!origin &&
    (ALLOWED_ORIGINS.includes(origin) ||
      ALLOWED_ORIGINS.some((o) => o.startsWith("https://*.") && origin.endsWith(o.slice("https://*".length))));
  return {
    "Access-Control-Allow-Origin": allow ? origin! : "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400",
  };
}

// ---- Utils ----
const toNumber = (s?: string | null) => {
  if (!s) return null;
  const n = s.replace(",", ".").match(/[0-9]+(\.[0-9]+)?/)?.[0];
  return n ? Number(n) : null;
};

// Arrival PT-BR → ISO(-03:00)
function parsePtBrDate(
  text?: string | null,
  now: Date = new Date(),
  tzOffsetMinutes: number = -180
): { iso: string | null; ts: number | null } {
  if (!text) return { iso: null, ts: null };
  const t = text.normalize("NFKC").trim();
  const m = t.match(
    /(?<d>\d{1,2})[\/\-](?<m>\d{1,2})(?:[\/\-](?<y>\d{2,4}))?(?:\s+(?<hh>\d{1,2})(?::(?<mm>\d{1,2}))?\s*(?:h)?)?/i
  );
  if (!m || !m.groups) return { iso: null, ts: null };
  const day = Number(m.groups.d);
  const mon = Number(m.groups.m);
  let year = m.groups.y ? Number(m.groups.y) : now.getFullYear();
  if (year < 100) year += 2000;
  let hh = m.groups.hh ? Number(m.groups.hh) : 0;
  let mm = m.groups.mm ? Number(m.groups.mm) : 0;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59)
    return { iso: null, ts: null };

  const utc = Date.UTC(year, mon - 1, day, hh, mm, 0) - tzOffsetMinutes * 60 * 1000;
  const ts = utc;

  const pad = (n: number, s = 2) => String(n).padStart(s, "0");
  const localTs = ts + tzOffsetMinutes * 60 * 1000;
  const dLoc = new Date(localTs);
  const isoLocal =
    `${pad(dLoc.getUTCFullYear(), 4)}-${pad(dLoc.getUTCMonth() + 1)}-${pad(dLoc.getUTCDate())}` +
    `T${pad(dLoc.getUTCHours())}:${pad(dLoc.getUTCMinutes())}:${pad(dLoc.getUTCSeconds())}-` +
    `${pad(Math.abs(tzOffsetMinutes) / 60)}:${pad(Math.abs(tzOffsetMinutes) % 60)}`;

  return { iso: isoLocal, ts };
}

// normalize header text → key
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\/ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function headerKey(h: string): string | null {
  const n = norm(h);
  const map: Array<[string, string[]]> = [
    ["ship", ["navio ship", "navio", "ship"]],
    ["flag", ["bandeira flag", "bandeira", "flag"]],
    ["lengthdraft", ["com len cal draft", "comprimento calado", "length draft", "len draft"]],
    ["nav", ["nav"]],
    ["arrival", ["cheg arrival d m y", "chegada", "arrival"]],
    ["notice", ["carimbo notice", "notice", "carimbo"]],
    ["agency", ["agencia office", "agencia", "office", "agency"]],
    ["operation", ["operac operat", "operacao", "operat", "operation"]],
    ["goods", ["mercadoria goods", "mercadoria", "goods"]],
    ["weight", ["peso weight", "peso", "weight"]],
    ["voyage", ["viagem voyage", "viagem", "voyage"]],
    ["duv", ["duv"]],
    ["priority", ["p", "prioridade"]],
    ["terminal", ["terminal"]],
    ["imo", ["imo"]],
  ];
  for (const [key, needles] of map) {
    if (needles.some((n2) => n.includes(n2))) return key;
  }
  return null;
}

function translateNotice(code?: string | null): string | null {
  if (!code) return null;
  const t = code.toUpperCase();
  if (t === "EMB") return "Load";
  if (t === "DESC") return "Unload";
  if (t === "EMBDESC" || t === "EMB/DESC" || t.includes("EMB") && t.includes("DESC")) return "Load & Unload";
  return code;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (env.API_KEY) {
      const k = req.headers.get("x-api-key");
      if (k !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders(origin) },
        });
      }
    }

    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, hit);

    const upstream = await fetch(env.SOURCE_URL, {
      headers: { "user-agent": "Mozilla/5.0 (header-aware fetch)" },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    // collect headers + rows
    const headersList: string[] = [];
    const rows: string[][] = [];
    let currentRow: string[] | null = null;
    let colIndex = -1;

    const rewriter = new HTMLRewriter()
      .on("table thead tr th", {
        element() {
          headersList.push("");
        },
        text(t) {
          const i = headersList.length - 1;
          headersList[i] = (headersList[i] + " " + t.text).trim();
        },
      })
      .on("table tbody tr", {
        element() {
          currentRow = [];
          rows.push(currentRow!);
          colIndex = -1;
        },
      })
      .on("table tbody tr td", {
        element() {
          if (!currentRow) return;
          colIndex++;
          currentRow[colIndex] = "";
        },
        text(t) {
          if (!currentRow) return;
          currentRow[colIndex] = (currentRow[colIndex] + " " + t.text).trim();
        },
      });

    await rewriter.transform(upstream).arrayBuffer();

    // Build column map by header labels
    const keys = headersList.map((h) => headerKey(h) || `col_${norm(h)}`);
    // Fallback: if page has no thead, assume first row is header (rare). We already captured thead; skip.

    const ships: Ship[] = rows
      .filter((r) => r.length > 1)
      .map((cells) => {
        const row: Row = {};
        cells.forEach((val, i) => (row[keys[i] || `c${i}`] = val.trim()));

        // Parse length/draft if present
        let length_m: number | null = null;
        let draft_m: number | null = null;
        const ld = (row["lengthdraft"] as string) || "";
        if (ld) {
          // formats: "200/12", "-/16"
          const m = ld.replace(",", ".").match(/^\s*([0-9]+(?:\.[0-9]+)?)?\s*\/\s*([0-9]+(?:\.[0-9]+)?)?\s*$/);
          if (m) {
            length_m = m[1] ? Number(m[1]) : null;
            draft_m = m[2] ? Number(m[2]) : null;
          }
        }

        // Arrival normalization
        const arrivalRaw = (row["arrival"] as string) || null;
        const { iso: arrival_iso, ts: arrival_ts } = parsePtBrDate(arrivalRaw);

        // Notice translation
        const notice_code = (row["notice"] as string) || null;
        const notice_en = translateNotice(notice_code);

        // IMO (if page provides as a column or embedded anywhere in row)
        let imo: string | null = null;
        if (row["imo"]) {
          const m = String(row["imo"]).match(/\b\d{7}\b/);
          if (m) imo = m[0];
        } else {
          // scan across cells for a 7-digit IMO-like number
          for (const v of cells) {
            const m = v.match(/\b\d{7}\b/);
            if (m) {
              imo = m[0];
              break;
            }
          }
        }

        return {
          imo,
          ship: (row["ship"] as string) || null,
          flag: (row["flag"] as string) || null,
          length_m,
          draft_m,
          nav: (row["nav"] as string) || null, // "Cabo", "Long"
          arrival_text: arrivalRaw,
          arrival_iso,
          arrival_ts,
          notice_code,
          notice_en,
          agency: (row["agency"] as string) || null,
          operation: (row["operation"] as string) || null,
          goods: (row["goods"] as string) || null,
          weight: (row["weight"] as string) || null,
          voyage: (row["voyage"] as string) || null,
          duv: (row["duv"] as string) || null,
          priority: (row["priority"] as string) || null,
          terminal: (row["terminal"] as string) || null,
          raw: cells,
        };
      });

    // sort by real arrival
    ships.sort((a, b) => (a.arrival_ts ?? Number.POSITIVE_INFINITY) - (b.arrival_ts ?? Number.POSITIVE_INFINITY));

    const payload = JSON.stringify({
      source: env.SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships,
      headersDetected: headersList, // debug
      keysDetected: keys,           // debug
    });

    const resp = new Response(payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...corsHeaders(origin),
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
    return resp;
  },
};
