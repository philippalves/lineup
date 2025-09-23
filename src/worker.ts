// Worker v3: robust table detection by header, clean mapping, normalization, English labels.

export interface Env {
  SOURCE_URL: string;
  API_KEY?: string;
}

/** Structured ship row we return */
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
  notice_code?: string | null;   // EMB/DESC/EMBDESC
  notice_en?: string | null;     // Load / Unload / Load & Unload
  agency?: string | null;
  operation?: string | null;
  goods?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;
  priority?: string | null;      // "P" column, if present
  terminal?: string | null;
  raw?: string[];                // full original cells as fallback
};

type TableBuf = { headers: string[]; rows: string[][] };

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

const toNumber = (s?: string | null) => {
  if (!s) return null;
  const n = s.replace(",", ".").match(/[0-9]+(?:\.[0-9]+)?/)?.[0];
  return n ? Number(n) : null;
};

// Parse dates like "23/09 17:40", "23/09/2025 08:00", "23/09"
function parsePtBrDate(text?: string | null, now: Date = new Date(), tzOffsetMinutes = -180) {
  if (!text) return { iso: null as string | null, ts: null as number | null };
  const t = text.normalize("NFKC").trim();
  const m = t.match(
    /(?<d>\d{1,2})[\/\-](?<m>\d{1,2})(?:[\/\-](?<y>\d{2,4}))?(?:\s+(?<hh>\d{1,2})(?::(?<mm>\d{1,2}))?\s*(?:h)?)?/i
  );
  if (!m || !m.groups) return { iso: null, ts: null };
  const day = Number(m.groups.d);
  const mon = Number(m.groups.m);
  let year = m.groups.y ? Number(m.groups.y) : now.getFullYear();
  if (year < 100) year += 2000;
  const hh = m.groups.hh ? Number(m.groups.hh) : 0;
  const mm = m.groups.mm ? Number(m.groups.mm) : 0;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59)
    return { iso: null, ts: null };

  const utc = Date.UTC(year, mon - 1, day, hh, mm, 0) - tzOffsetMinutes * 60 * 1000;
  const ts = utc;

  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const localTs = ts + tzOffsetMinutes * 60 * 1000;
  const dLoc = new Date(localTs);
  const isoLocal =
    `${pad(dLoc.getUTCFullYear(), 4)}-${pad(dLoc.getUTCMonth() + 1)}-${pad(dLoc.getUTCDate())}` +
    `T${pad(dLoc.getUTCHours())}:${pad(dLoc.getUTCMinutes())}:${pad(dLoc.getUTCSeconds())}-` +
    `${pad(Math.abs(tzOffsetMinutes) / 60)}:${pad(Math.abs(tzOffsetMinutes) % 60)}`;
  return { iso: isoLocal, ts };
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\/ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Map header text → semantic key
function headerKey(h: string): string | null {
  const n = norm(h);
  const map: Array<[string, string[]]> = [
    ["imo", ["imo"]],
    ["ship", ["navio ship", "navio", "ship"]],
    ["flag", ["bandeira flag", "bandeira", "flag"]],
    ["lengthdraft", ["com len cal draft", "length draft", "comprimento calado", "len draft"]],
    ["nav", ["nav"]],
    ["arrival", ["cheg arrival d m y", "chegada", "arrival"]],
    ["notice", ["carimbo notice", "notice", "carimbo"]],
    ["agency", ["agencia office", "agencia", "office", "agency"]],
    ["operation", ["operac operat", "operacao", "operation", "operat"]],
    ["goods", ["mercadoria goods", "mercadoria", "goods"]],
    ["weight", ["peso weight", "peso", "weight"]],
    ["voyage", ["viagem voyage", "viagem", "voyage"]],
    ["duv", ["duv"]],
    ["priority", ["p", "prioridade"]],
    ["terminal", ["terminal"]],
  ];
  for (const [key, needles] of map) {
    if (needles.some((s) => n.includes(s))) return key;
  }
  return null;
}

function translateNotice(code?: string | null): string | null {
  if (!code) return null;
  const t = code.toUpperCase();
  if (t === "EMB") return "Load";
  if (t === "DESC") return "Unload";
  if (t === "EMBDESC" || t === "EMB/DESC" || (t.includes("EMB") && t.includes("DESC"))) return "Load & Unload";
  return code;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });

    if (env.API_KEY) {
      if (req.headers.get("x-api-key") !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders(origin) },
        });
      }
    }

    // CDN cache
    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, cached);

    // Fetch upstream
    const upstream = await fetch(env.SOURCE_URL, {
      headers: { "user-agent": "Mozilla/5.0 (header-aware fetch)" },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Parse ALL tables; choose the best one by headers/width
    const tables: TableBuf[] = [];
    let current: TableBuf | null = null;
    let colIndex = -1;

    const rewriter = new HTMLRewriter()
      .on("table", {
        element() {
          current = { headers: [], rows: [] };
          tables.push(current);
        },
      })
      .on("table thead tr th", {
        element() {
          if (!current) return;
          current.headers.push("");
        },
        text(t) {
          if (!current) return;
          const i = current.headers.length - 1;
          current.headers[i] = (current.headers[i] + " " + t.text).trim();
        },
      })
      .on("table tbody tr", {
        element() {
          if (!current) return;
          current.rows.push([]);
          colIndex = -1;
        },
      })
      .on("table tbody tr td", {
        element() {
          if (!current) return;
          colIndex++;
          const row = current.rows[current.rows.length - 1];
          row[colIndex] = "";
        },
        text(t) {
          if (!current) return;
          const row = current.rows[current.rows.length - 1];
          row[colIndex] = (row[colIndex] + " " + t.text).trim();
        },
      });

    await rewriter.transform(upstream).arrayBuffer();

    // Score and pick table
    function scoreTable(tb: TableBuf) {
      const keys = tb.headers.map((h) => headerKey(h));
      const hit = keys.filter(Boolean).length;
      return { keys, hit, cols: Math.max(tb.headers.length, tb.rows[0]?.length || 0) };
    }

    let pickIdx = -1;
    let best = { hit: -1, cols: -1, keys: [] as (string | null)[] };
    for (let i = 0; i < tables.length; i++) {
      const s = scoreTable(tables[i]);
      // Prefer more recognized headers; tie-breaker: more columns
      if (s.hit > best.hit || (s.hit === best.hit && s.cols > best.cols)) {
        best = s;
        pickIdx = i;
      }
    }
    if (pickIdx === -1) {
      // fallback: largest table by columns
      pickIdx =
        tables
          .map((t, i) => ({ i, cols: Math.max(t.headers.length, t.rows[0]?.length || 0) }))
          .sort((a, b) => b.cols - a.cols)[0]?.i ?? 0;
      best = scoreTable(tables[pickIdx]);
    }

    const tb = tables[pickIdx] || { headers: [], rows: [] };
    const keys = best.keys.length ? best.keys : tb.headers.map(() => null);

    // Map each row to Ship
    const ships: Ship[] = tb.rows
      .filter((r) => r.length > 1)
      .map((cells) => {
        const get = (wanted: string) => {
          const idx = keys.findIndex((k) => k === wanted);
          return idx >= 0 ? (cells[idx] ?? "") : "";
        };

        const lengthdraft = get("lengthdraft");
        let length_m: number | null = null;
        let draft_m: number | null = null;
        if (lengthdraft) {
          const m = lengthdraft.replace(",", ".").match(/^\s*([0-9]+(?:\.[0-9]+)?)?\s*\/\s*([0-9]+(?:\.[0-9]+)?)?\s*$/);
          if (m) {
            length_m = m[1] ? Number(m[1]) : null;
            draft_m = m[2] ? Number(m[2]) : null;
          }
        }

        const arrival_text = get("arrival") || null;
        const { iso: arrival_iso, ts: arrival_ts } = parsePtBrDate(arrival_text);

        const notice_code = get("notice") || null;
        const notice_en = translateNotice(notice_code);

        // IMO: try column; if not present, scan any 7-digit
        let imo: string | null = null;
        const colImo = get("imo");
        if (colImo) {
          const m = colImo.match(/\b\d{7}\b/);
          if (m) imo = m[0];
        } else {
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
          ship: get("ship") || null,
          flag: get("flag") || null,
          length_m,
          draft_m,
          nav: get("nav") || null,
          arrival_text,
          arrival_iso,
          arrival_ts,
          notice_code,
          notice_en,
          agency: get("agency") || null,
          operation: get("operation") || null,
          goods: get("goods") || null,
          weight: get("weight") || null,
          voyage: get("voyage") || null,
          duv: get("duv") || null,
          priority: get("priority") || null,
          terminal: get("terminal") || null,
          raw: cells,
        };
      });

    // Sort by arrival time (unknowns last)
    ships.sort((a, b) => (a.arrival_ts ?? Number.POSITIVE_INFINITY) - (b.arrival_ts ?? Number.POSITIVE_INFINITY));

    const payload = JSON.stringify({
      source: env.SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships,
      headersDetected: tb.headers,
      keysDetected: keys,
      pickedTableIndex: pickIdx,
    });

    const resp = new Response(payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...corsHeaders(origin),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
