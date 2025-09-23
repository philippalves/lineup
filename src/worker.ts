export interface Env {
  SOURCE_URL: string;
  API_KEY?: string;
}

type Ship = {
  imo?: string | null;
  ship?: string | null;         // nome do navio
  flag?: string | null;
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;          // Cabo / Long
  arrival_text?: string | null; // "dd/mm/yyyy hh:mm"
  arrival_iso?: string | null;  // ISO -03:00
  arrival_ts?: number | null;   // epoch ms (para ordenar)
  notice_code?: string | null;  // EMB / DESC / EMBDESC
  notice_en?: string | null;    // Load / Unload / Load & Unload
  agency?: string | null;
  operation?: string | null;    // quando existir texto na coluna 5
  goods?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;          // número
  duv_class?: string | null;    // ex.: B
  pier?: string | null;         // P (ex.: ALAMOA, 35/37…)
  terminal?: string | null;     // código numérico do terminal
  raw?: string[];
};

// CORS
const ALLOW = ["https://seachiosbrazil.com","https://www.seachiosbrazil.com"];
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && (ALLOW.includes(origin) || origin.endsWith(".framer.app")) ? origin : "*",
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
  const m = t.match(
    /(?<d>\d{1,2})\/(?<mo>\d{1,2})(?:\/(?<y>\d{2,4}))?(?:\s+(?<h>\d{1,2})(?::(?<mi>\d{1,2}))?)?/i
  );
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

// tenta decodificar "Length/Draft"
// formatos esperados: "183 10.5" | "183/10.5" | "18310.5"
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

    // cache
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

    // Captura a TABELA PRINCIPAL (tbody tds) como linhas cruas
    const rows: string[][] = [];
    let cur: string[] | null = null, col = -1;

    const rw = new HTMLRewriter()
      .on("table tbody tr", { element() { cur = []; rows.push(cur!); col = -1; } })
      .on("table tbody tr td", {
        element() { if (!cur) return; col++; cur[col] = ""; },
        text(t) { if (!cur) return; cur[col] = (cur[col] + " " + t.text).trim(); }
      });

    await rw.transform(up).arrayBuffer();

    // Heurística: consideramos “linha válida” se tiver pelo menos 12-13 colunas
    const good = rows.filter(r => r.filter(v => v?.trim()).length >= 12);

    const ships: Ship[] = good.map((cells) => {
      // índice fixo baseado no seu exemplo de raw[]
      const shipName   = cells[0] ?? "";
      const flag       = cells[1] ?? "";
      const lenDraft   = cells[2] ?? "";
      const nav        = cells[3] ?? "";
      const arrival    = cells[4] ?? "";
      const col5       = cells[5] ?? ""; // às vezes vem algo; se for texto "grande", tratamos como operação
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

      // Operation: só aceita se não for apenas números/hífens
      const operation = /[A-Za-z]/.test(col5) && !/^\d[\d\- ]*$/.test(col5) ? col5 : null;

      // IMO: procura qualquer 7 dígitos na linha
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
        // alias para retrocompatibilidade (se algum front esperar eta_*)
        // remove se não precisar:
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

