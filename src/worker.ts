export interface Env {
  SOURCE_URL: string;
  API_KEY?: string;
}

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

const ALLOWED_ORIGINS = [
  "https://framer.com",
  "https://www.framer.com",
  "https://*.framer.app",      // projetos framer
  "http://localhost:5173",     // dev framer
  "http://localhost:8000",
  "http://127.0.0.1:5173"
];

function corsHeaders(origin: string | null) {
  const allow = origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    ALLOWED_ORIGINS.some(o => o.startsWith("https://*.") && origin.endsWith(o.slice("https://*".length)))
  );
  return {
    "Access-Control-Allow-Origin": allow ? origin! : "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400"
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { method, headers } = req;
    const origin = headers.get("Origin");

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // (Opcional) proteção por API key
    if (env.API_KEY) {
      const key = headers.get("x-api-key");
      if (key !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders(origin) }
        });
      }
    }

    // Cache na edge (10 min)
    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, cached);
    }

    // Busca a página de origem
    const upstream = await fetch(env.SOURCE_URL, {
      headers: { "user-agent": "Mozilla/5.0 (data-fetch for internal dashboard)" }
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders(origin) }
      });
    }

    // Parser em streaming com HTMLRewriter
    const rows: string[][] = [];
    let currentRow: string[] | null = null;
    let colIndex = -1;

    const rewriter = new HTMLRewriter()
      .on("table tbody tr", {
        element() {
          currentRow = [];
          rows.push(currentRow!);
          colIndex = -1;
        }
      })
      .on("table tbody tr td", {
        element() {
          if (!currentRow) return;
          colIndex++;
          currentRow[colIndex] = "";
        },
        text(t) {
          if (!currentRow) return;
          // concatena fragmentos de texto do mesmo <td>
          currentRow[colIndex] += t.text.trim();
        }
      });

    // Consumir o corpo para acionar os handlers
    await rewriter.transform(upstream).arrayBuffer();

    // Mapeia heurística de colunas → campos
    const toNumber = (s?: string) => {
      const n = s?.replace(",", ".").match(/[0-9]+(\.[0-9]+)?/)?.[0];
      return n ? Number(n) : null;
    };

    const ships: Ship[] = rows
      .filter(r => r.length > 1) // ignora linhas vazias
      .map((tds) => {
        // Ajuste de índices conforme o HTML do dia.
        const [eta, ship, imoMaybe, lengthMaybe, draftMaybe, navMaybe, cargoMaybe, priorityMaybe, terminalMaybe] = [
          tds[0], tds[1], tds[2], tds[3], tds[4], tds[5], tds[6], tds[7], tds[8]
        ];

        return {
          eta,
          ship,
          imo: imoMaybe && /^\d{7}$/.test(imoMaybe) ? imoMaybe : undefined,
          length_m: toNumber(lengthMaybe),
          draft_m: toNumber(draftMaybe),
          nav: navMaybe || null,
          cargo: cargoMaybe || null,
          priority: priorityMaybe || null,
          terminal: terminalMaybe || null,
          raw: tds
        };
      });

    const payload = JSON.stringify({
      source: env.SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships
    });

    const resp = new Response(payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...corsHeaders(origin)
      }
    });

    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
};
