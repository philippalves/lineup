export interface Env {
  SOURCE_URL: string;
  API_KEY?: string; // opcional: proteger por x-api-key
}

type Category = "container" | "liquid" | "bulk" | "other";

type Ship = {
  // CAMPOS QUE VOCÊ VAI USAR NO FRAMER:
  imo?: string | null;                 // ← agora calculado a partir de 'terminal' (código numérico na página)
  ship?: string | null;                // nome do navio
  flag?: string | null;                // original (PT)
  flag_en?: string | null;             // ← NOVO: país em inglês
  arrival_text?: string | null;        // ETA (texto)
  arrival_iso?: string | null;         // ETA ISO
  arrival_ts?: number | null;          // ETA epoch ms (para sort)
  notice_code?: string | null;         // EMB/DESC/EMBDESC
  notice_en?: string | null;           // Load / Unload / Load & Unload
  agency?: string | null;              // agência
  pier?: string | null;                // ← nome do terminal (coluna P)
  goods?: string | null;               // nome da carga

  // CAMPOS AUXILIARES/EXTRAS (podem ser ignorados no front):
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;
  operation?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;
  duv_class?: string | null;
  terminal?: string | null;            // valor bruto da 15ª coluna (de onde extraímos o IMO)
  cargo_category?: Category | null;
  cargo_category_en?: string | null;
  raw?: string[];
};

const ALLOW = ["https://seachiosbrazil.com","https://www.seachiosbrazil.com"];
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && (ALLOW.includes(origin) || origin.endsWith(".seachiosbrazil.app")) ? origin : "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400",
  };
}

// ------ FUNÇÕES DE PARSE/UTIL ------

// dd/mm[/yyyy] [hh[:mm]]
function parsePt(text?: string | null, now: Date = new Date(), tzOffsetMin = -180) {
  if (!text) return { iso: null as string | null, ts: null as number | null };
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

// "183 10.5" | "183/10.5" | "18310.5"
function parseLenDraft(s?: string | null) {
  if (!s) return { length: null as number | null, draft: null as number | null };
  const t = s.replace(",", ".").trim();
  let m = t.match(/^\s*(\d{2,4})\s*[\/ ]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) return { length: Number(m[1]), draft: Number(m[2]) };
  m = t.match(/^(\d{2,4})(\d+(?:\.\d+)?)$/);
  if (m) return { length: Number(m[1]), draft: Number(m[2]) };
  return { length: null, draft: null };
}

function translateNotice(code?: string | null) {
  if (!code) return null;
  const t = code.toUpperCase();
  if (t.includes("EMB") && t.includes("DESC")) return "Load & Unload";
  if (t === "EMB") return "Load";
  if (t === "DESC") return "Unload";
  return code;
}

// Normalização para matching
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Flag PT→EN (mapeamento enxuto com países mais comuns no tráfego de Santos; fallback mantém original)
const FLAG_PT_EN: Record<string,string> = {
  "brasil":"Brazil","argentina":"Argentina","uruguai":"Uruguay","paraguai":"Paraguay","bolivia":"Bolivia","chile":"Chile","peru":"Peru","colombia":"Colombia",
  "venezuela":"Venezuela","equador":"Ecuador","suriname":"Suriname","guiana":"Guyana",
  "chipre":"Cyprus","panama":"Panama","liberia":"Liberia","malta":"Malta","bahamas":"Bahamas","ilhas marshall":"Marshall Islands","antigua e barbuda":"Antigua and Barbuda",
  "hong kong":"Hong Kong","china":"China","singapura":"Singapore","coreia do sul":"South Korea","coreia, republica da":"South Korea","correia do sul":"South Korea",
  "grecia":"Greece","grécia":"Greece","italia":"Italy","espanha":"Spain","portugal":"Portugal","franca":"France","frança":"France","reino unido":"United Kingdom",
  "alemanha":"Germany","países baixos":"Netherlands","paises baixos":"Netherlands","belgica":"Belgium","bélgica":"Belgium","noruega":"Norway","dinamarca":"Denmark",
  "suécia":"Sweden","suecia":"Sweden","finlandia":"Finland","russia":"Russia","turquia":"Turkey","india":"India","indonesia":"Indonesia","malasia":"Malaysia","malásia":"Malaysia",
  "emirados arabes unidos":"United Arab Emirates","emirados árabes unidos":"United Arab Emirates","arabia saudita":"Saudi Arabia","arábia saudita":"Saudi Arabia",
  "nigeria":"Nigeria","angola":"Angola","africa do sul":"South Africa","áfrica do sul":"South Africa",
  "bahrein":"Bahrain","kuwait":"Kuwait","qatar":"Qatar","irã":"Iran","ira":"Iran","iraque":"Iraq",
  "holanda":"Netherlands","egito":"Egypt","marrocos":"Morocco",
};

function toEnglishFlag(flagPt?: string | null): string | null {
  if (!flagPt) return null;
  const key = norm(flagPt);
  return FLAG_PT_EN[key] || flagPt;
}

// Categorias por palavras-chave (para você poder manter agrupamentos no front)
const K_CONTAINER = ["container","conteiner","tecon","santos brasil","btp","ecoporto","dp world","terminal de conteiner","terminal de container"];
const K_LIQUID = ["oleo","óleo","combustivel","combustível","diesel","gasolina","etanol","alcool","álcool","nafta","qsav","gasoil","gasoleo","gasóleo","bunker","glp","lpg","gnl","lng","metanol","alamoa","querosene","solvente"];
const K_BULK = ["granel","grao","graos","grãos","soja","milho","acucar","açucar","açúcar","fertiliz","ureia","uréia","sal","minerio","minério","carvao","carvão","celulose","trigo","farelo","pellet","potassio","potássio","sulfato","soda","cimento","clinquer","clínquer","coque","petcoke","sugar","grain","ore"];

function hasAny(hay: string, needles: string[]) {
  const H = norm(hay);
  return needles.some(n => H.includes(n));
}

function classifyCargo(goods?: string | null, terminal?: string | null, pier?: string | null, agency?: string | null)
: { cat: Category, label: string } {
  const bag = [goods||"", terminal||"", pier||"", agency||""].join(" | ");
  if (hasAny(bag, K_CONTAINER)) return { cat: "container", label: "Container" };
  if (hasAny(bag, K_LIQUID))    return { cat: "liquid",    label: "Liquid (Oil)" };
  if (hasAny(bag, K_BULK))      return { cat: "bulk",      label: "Bulk" };
  return { cat: "other", label: "Other" };
}

// Extrai IMO a partir do campo 'terminal' (coluna 15) ou da linha inteira.
// Regras: se 8 dígitos começando em 0 → remove zero à esquerda; aceita 7 dígitos.
function extractImo(terminalField: string, allCells: string[]): string | null {
  const onlyDigits = terminalField.replace(/\D+/g, "");
  if (/^\d{8}$/.test(onlyDigits) && onlyDigits.startsWith("0")) {
    return String(Number(onlyDigits)); // remove zeros à esquerda → pode virar 7 dígitos
  }
  if (/^\d{7}$/.test(onlyDigits)) return onlyDigits;
  // fallback: procurar 7 dígitos na linha inteira (inclui "IMO 1234567")
  const m = allCells.join(" ").match(/\b(\d{7})\b/);
  return m ? m[1] : null;
}

// ------ HANDLER ------

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

    // Extrai linhas de todas as tabelas
    const rows: string[][] = [];
    let cur: string[] | null = null, col = -1;

    const rw = new HTMLRewriter()
      .on("table tbody tr", { element() { cur = []; rows.push(cur!); col = -1; } })
      .on("table tbody tr td", {
        element() { if (!cur) return; col++; cur[col] = ""; },
        text(t) { if (!cur) return; cur[col] = (cur[col] + " " + t.text).trim(); }
      });

    await rw.transform(up).arrayBuffer();

    // Mantemos linhas com pelo menos ~12 colunas preenchidas
    const good = rows.filter(r => r.filter(v => v?.trim()).length >= 12);

    const ships: Ship[] = good.map((cells) => {
      const shipName   = cells[0] ?? "";
      const flagPt     = cells[1] ?? "";
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
      const pier       = cells[13] ?? "";   // ← nome do terminal
      const terminal   = cells[14] ?? "";   // ← campo do qual extrairemos o IMO

      const { length, draft } = parseLenDraft(lenDraft);
      const { iso, ts } = parsePt(arrival);
      const operation = /[A-Za-z]/.test(col5) && !/^\d[\d\- ]*$/.test(col5) ? col5 : null;

      // NOVO: IMO vindo do campo 'terminal' (com sanidade de 7 dígitos)
      const imo = extractImo(terminal, cells);

      // Flag em inglês
      const flagEn = toEnglishFlag(flagPt);

      // Categoria (mantida para futuros agrupamentos)
      const cat = classifyCargo(goods, terminal, pier, agency);

      return {
        // campos principais para o front:
        imo,
        ship: shipName || null,
        flag: flagPt || null,
        flag_en: flagEn,
        arrival_text: arrival || null,
        arrival_iso: iso,
        arrival_ts: ts,
        notice_code: notice || null,
        notice_en: translateNotice(notice),
        agency: agency || null,
        pier: pier || null,          // nome do terminal
        goods: goods || null,

        // extras:
        length_m: length,
        draft_m: draft,
        nav: nav || null,
        operation,
        weight: weight || null,
        voyage: voyage || null,
        duv: duvNum || null,
        duv_class: duvClass || null,
        terminal: terminal || null,  // mantém original, caso precise depurar
        cargo_category: cat.cat,
        cargo_category_en: cat.label,
        raw: cells,
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
