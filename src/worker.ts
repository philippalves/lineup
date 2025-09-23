export interface Env {
  SOURCE_URL: string;
  API_KEY?: string; // opcional: se quiser proteger por header x-api-key
}

type Ship = {
  imo?: string | null;
  ship?: string | null;        // nome do navio (raw[0])
  flag?: string | null;        // raw[1]
  length_m?: number | null;    // derivado de raw[2]
  draft_m?: number | null;     // derivado de raw[2]
  nav?: string | null;         // "Cabo"/"Long" -> raw[3]
  arrival_text?: string | null;// raw[4] ex: "16/09/2025 00:54:00"
  arrival_iso?: string | null; // ISO -03:00
  arrival_ts?: number | null;  // epoch ms (ordenável)
  notice_code?: string | null; // raw[7] EMB / DESC / EMBDESC
  notice_en?: string | null;   // Load / Unload / Load & Unload
  agency?: string | null;      // raw[6]
  operation?: string | null;   // heurística em raw[5] (se não for só número)
  goods?: string | null;       // raw[8]
  weight?: string | null;      // raw[9]
  voyage?: string | null;      // raw[10]
  duv?: string | null;         // raw[11] (número)
  duv_class?: string | null;   // raw[12] ex.: "B"
  pier?: string | null;        // raw[13] (P: "ALAMOA", "35/37", ...)
  terminal?: string | null;    // raw[14] (código numérico)
  raw?: string[];              // linha original
};

const ALLOW = ["https://seachiosbrazil.com","https://www.seachiosbrazil.com"];
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && (ALLOW.includes(origin) || origin.endsWith(".seachiosbrazil.com")) ? origin : "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400",
  };
}

// dd/mm[/yyyy] [hh[:mm]]
function parsePt(
  text?: string | null,
  now: Date = new Date(),
  tzOffsetMin = -180
): { iso: string | null; ts: number | null } {
  if (!text) return { iso: null, ts: null };
  const t = text.normalize("NFKC").trim();
  const m = t.match(/(?<d>\d{1,2})\/(?<mo>\d{1,2})(?:\/(?<y>\d{2,4}))?(?:\s+(?<h>\d{1,2})(?::(?<mi>\d{1,2}))?)?/i);
  if (!m?.groups) return { iso: null, ts: null };
  let y = m.groups.y ? Number(m.groups.y) : now.getFullYear();
  if (y < 100) y += 2000;
  const d = Number(m.groups.d), mo = Number(m.groups.mo);
  const h = m.groups.h ? Number(m.groups.h) : 0;
  const mi = m.groups.mi ? Number(m.groups.mi) : 0;
  const utc = Date.UTC(y, mo - 1, d, h, mi, 0) - tzOffsetMin * 60 * 1000; // ts em UTC
  const ts = utc;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const lt = ts + tzOffsetMin * 60 * 1000;
  const dloc = new Date(lt);
  const iso =
    `${pad(dloc.getUTCFullYear(),4)}-${pad(dloc.getUTCMonth()+1)}-${pad(dloc.getUTCDate())}` +
    `T${pad(dloc.getUTCHours())}:${pad(dloc.getUTCMinutes())}:${pad(dloc.getUTCSeconds())}-` +
    `${pad(Math.abs(tzOffsetMin)/60)}:${pad(Math.abs(tzOffsetMin)%60)}`;
  return { iso, ts };
}

function translateNotice(code?: string | null) {
  if (!code) return null;
  const t = code.toUpperCase();
  if (t.includes("EMB") && t.includes("DESC")) return "Load & Unload";
  if (t === "EMB") return "Load";
  if (t === "DESC") return "Unload";
  return code;
}

// "183 10.5" | "183/10.5" | "18310.5"
function parseLenDraft(s?: string | null): { length: number | null; draft: number | null } {
  if (!s) return { length: null, draft: null };
  const t = s.replace(",", ".").trim();
  let m = t.match(/^\s*(\d{2,4})\s*[\/ ]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) return { length: Number(m[1]), draft: Number(m[2]) };
  m = t.match(/^(\d{2,4})(\d+(?:\.\d+)?)$/); // grudado: 18310.5 → 183 / 10.5
  if (m) return { length: Number(m[1]), draft: Number(m[2]) };
  return { length: null, draft: null };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    if (env.API_KEY && req.headers.get("x-api-key") !== env.API_KEY) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json", ...cors(origin) }
      });
    }

    // cache CDN
    const cache = caches.default;
    const key = new Request(new URL(req.url).toString(), req);
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, hit);

    const up = await fetch(env.SOURCE_URL, { headers: { "user-agent": "Mozilla/5.0 (worker)" } });
    if (!up.ok) {
      return new Response(JSON.stringify({ error: `upstream ${up.status}` }), {
        status: 502, headers: { "content-type": "application/json", ...cors(origin) }
      });
    }

    // Lê TODAS as linhas de TODAS as tabelas e depois filtramos por "linhas boas"
    const rows: string[][] = [];
    let cur: string[] | null = null, col = -1;

    const rw = new HTMLRewriter()
      .on("table tbody tr", { element() { cur = []; rows.push(cur!); col = -1; } })
      .on("table tbody tr td", {
        element() { if (!cur) return; col++; cur[col] = ""; },
        text(t) { if (!cur) return; cur[col] = (cur[col] + " " + t.text).trim(); }
      });

    await rw.transform(up).arrayBuffer();

    // Heurística: mantemos só linhas com "muitas" colunas não vazias (>= 12)
    const good = rows.filter(r => r.filter(v => v?.trim()).length >= 12);

    const ships: Ship[] = good.map((cells) => {
      const shipName   = cells[0] ?? "";
      const flag       = cells[1] ?? "";
      const lenDraft   = cells[2] ?? "";
      const nav        = cells[3] ?? "";
      const arrival    = cells[4] ?? "";
      const col5       = cells[5] ?? ""; // pode ser código; só vira "operation" se tiver letras
      const agency     = cells[6] ?? "";
      const notice     = cells[7] ?? "";
      const goods      = cells[8] ?? "";
      const weight     = cells[9] ?? "";
      const voyage     = cells[10] ?? "";
      const duvNum     = cells[11] ?? "";
      const duvClass   = cells[12] ?? "";
      const pier       = cells[13] ?? "";
      const terminal   = cells[14] ?? "";

      const { length, draft } = parseLenDraft(lenDraft);
      const { iso, ts } = parsePt(arrival);
      const operation = /[A-Za-z]/.test(col5) && !/^\d[\d\- ]*$/.test(col5) ? col5 : null;

      const imoMatch = cells.join(" ").match(/\b\d{7}\b/);
      const imo = imoMatch ? imoMatch[0] : null;

      return {
        imo,
        ship: shipName || null,
        flag: flag || null,
        length_m: length,
        draft_m: draft,
        nav: nav || null,
        arrival_text: arrival || null,
        arrival_iso: iso,
        arrival_ts: ts,
        notice_code: notice || null,
        notice_en: translateNotice(notice),
        agency: agency || null,
        operation,
        goods: goods || null,
        weight: weight || null,
        voyage: voyage || null,
        duv: duvNum || null,
        duv_class: duvClass || null,
        pier: pier || null,
        terminal: terminal || null,
        raw: cells,
        // aliases de compatibilidade (remova se não precisar)
        // @ts-ignore
        eta_text: arrival || null,
        // @ts-ignore
        eta_iso: iso,
        // @ts-ignore
        eta_ts: ts,
      };
    });

    const body = JSON.stringify({
      source: env.SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships,
    });

    const resp = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...cors(origin),
      },
    });
    ctx.waitUntil(cache.put(key, resp.clone()));
    return resp;
  },
};
