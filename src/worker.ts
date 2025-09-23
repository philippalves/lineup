export interface Env {
  SOURCE_URL: string;
  API_KEY?: string; // opcional: proteger por x-api-key
}

type Ship = {
  imo?: string | null;
  ship?: string | null;        // raw[0]
  flag?: string | null;        // raw[1]
  length_m?: number | null;    // de raw[2]
  draft_m?: number | null;     // de raw[2]
  nav?: string | null;         // raw[3]
  arrival_text?: string | null;// raw[4]
  arrival_iso?: string | null;
  arrival_ts?: number | null;
  notice_code?: string | null; // raw[7]
  notice_en?: string | null;
  agency?: string | null;      // raw[6]
  operation?: string | null;   // heurística em raw[5]
  goods?: string | null;       // raw[8]
  weight?: string | null;      // raw[9]
  voyage?: string | null;      // raw[10]
  duv?: string | null;         // raw[11]
  duv_class?: string | null;   // raw[12]
  pier?: string | null;        // raw[13] (P)
  terminal?: string | null;    // raw[14]
  // NOVO:
  cargo_category?: "container" | "liquid" | "bulk" | "other" | null;
  cargo_category_en?: string | null;
  raw?: string[];
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
  const utc = Date.UTC(y, mo - 1, d, h, mi, 0) - tzOffsetMin * 60 * 1000;
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
  m = t.match(/^(\d{2,4})(\d+(?:\.\d+)?)$/);
  if (m) return { length: Number(m[1]), draft: Number(m[2]) };
  return { length: null, draft: null };
}

// --- CATEGORIZAÇÃO DE CARGA ---
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hasAny(hay: string, needles: string[]) {
  const H = norm(hay);
  return needles.some(n => H.includes(n));
}
const K_CONTAINER = [
  "container","conteiner","conteiners","conteineres","contener",
  "tecon","santos brasil","btp","ecoporto","dp world","terminal de conteiner","terminal de container"
];
const K_LIQUID = [
  "oleo","óleo","combustivel","combustível","diesel","gasolina","etanol","alcool","álcool","nafta","querosene","qsav",
  "gasoil","gasoleo","gasóleo","bunker","glp","lpg","gnl","lng","metanol","butanol","solvente","acido","ácido",
  "alamoa"
];
const K_BULK = [
  "granel","grao","graos","grãos","soja","milho","acucar","açucar","açúcar","fertiliz","ureia","ureia","sal",
  "minerio","minério","carvao","carvão","celulose","trigo","farelo","pellet","potassio","potássio","sulfato",
  "soda","cimento","clinquer","clínquer","coque","petcoke","mineral","ore","sugar","grain"
];

function classifyCargo(goods?: string | null, terminal?: string | null, pier?: string | null, agency?: string | null)
: { cat: "container" | "liquid" | "bulk" | "other", label: string } {
  const g = goods || "";
  const t = terminal || "";
  const p = pier || "";
  const a = agency || "";
  const bag = [g,t,p,a].filter(Boolean).join(" | ");

  if (hasAny(bag, K_CONTAINER)) return { cat: "container", label: "Container" };
  if (hasAny(bag, K_LIQUID))    return { cat: "liquid",    label: "Liquid (Oil)" };
  if (hasAny(bag, K_BULK))      return { cat: "bulk",      label: "Bulk" };
  return { cat: "other", label: "Other" };
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

    // Captura linhas de tabela
    const rows: string[][] = [];
    let cur: string[] | null = null, col = -1;

    const rw = new HTMLRewriter()
      .on("table tbody tr", { element() { cur = []; rows.push(cur!); col = -1; } })
      .on("table tbody tr td", {
        element() { if (!cur) return; col++; cur[col] = ""; },
        text(t) { if (!cur) return; cur[col] = (cur[col] + " " + t.text).trim(); }
      });

    await rw.transform(up).arrayBuffer();

    const good = rows.filter(r => r.filter(v => v?.trim()).length >= 12);

    const ships: Ship[] = good.map((cells) => {
      const shipName   = cells[0] ?? "";
      const flag       = cells[1] ?? "";
      const lenDraft   = cells[2] ?? "";
      const nav        = cells[3] ?? "";
      const arrival    = cells[4] ?? "";
      const col5       = cells[5] ?? "";
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

      const cat = classifyCargo(goods, terminal, pier, agency);

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
        cargo_category: cat.cat,
        cargo_category_en: cat.label,
        raw: cells,
        // aliases (se algum front antigo usar)
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
