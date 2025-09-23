// Cloudflare Worker: Porto de Santos "Navios Esperados – Carga"
// - Busca o HTML da página oficial
// - Extrai a tabela em streaming (HTMLRewriter)
// - Normaliza ETA -> ISO (timezone America/Sao_Paulo)
// - Ordena por ETA real no backend
// - Expõe JSON com cache + CORS

export interface Env {
  SOURCE_URL: string; // defina no wrangler.toml ou nas Vars do Worker
  API_KEY?: string;   // opcional (se quiser proteger por header x-api-key)
}

type Ship = {
  eta_text?: string;        // texto cru da célula ETA
  eta_iso?: string | null;  // ISO-8601 (ex.: 2025-03-14T09:30:00-03:00)
  eta_ts?: number | null;   // timestamp ms (Date.getTime)
  ship?: string;
  imo?: string;
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;
  cargo?: string | null;
  terminal?: string | null;
  priority?: string | null;
  raw?: string[];           // linha completa (fallback)
};

// Domínios que poderão consumir a API (ajuste para o seu site)
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

// ---- Util: parsing tolerante de números (comprimento/calado) ----
const toNumber = (s?: string) => {
  const n = s?.replace(",", ".").match(/[0-9]+(\.[0-9]+)?/)?.[0];
  return n ? Number(n) : null;
};

// ---- Util: parsing de datas em PT-BR ----
// Aceita formatos comuns no site, ex.: "14/03/2025 09:30", "14/03 09:30", "14/03", "14/03 9h", etc.
function parsePtBrDate(
  text?: string,
  now: Date = new Date(),
  tzOffsetMinutes: number = -180 // America/Sao_Paulo (UTC-3) — ajuste se necessário (horário de verão não vigente)
): { iso: string | null; ts: number | null } {
  if (!text) return { iso: null, ts: null };

  const t = text.normalize("NFKC").trim();

  // dd/mm[/yyyy] [hh[:mm] [h]]
  // Ex.: 07/09/2025 08:45 | 07/09 8h | 07/09
  const m = t.match(
    /(?<d>\d{1,2})[\/\-](?<m>\d{1,2})(?:[\/\-](?<y>\d{2,4}))?(?:\s+(?<hh>\d{1,2})(?::(?<mm>\d{1,2}))?\s*(?:h)?)?/i
  );
  if (!m || !m.groups) return { iso: null, ts: null };

  const day = Number(m.groups.d);
  const month = Number(m.groups.m);
  let year = m.groups.y ? Number(m.groups.y) : now.getFullYear();
  if (year < 100) year += 2000;

  let hh = m.groups.hh ? Number(m.groups.hh) : 0;
  let mm = m.groups.mm ? Number(m.groups.mm) : 0;

  // Validações básicas
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { iso: null, ts: null };
  }

  // Monta data em UTC a partir do "local" -03:00
  // Estratégia: cria a data como se fosse no fuso local alvo e converte para UTC.
  const utcTs =
    Date.UTC(year, month - 1, day, hh, mm, 0) + tzOffsetMinutes * 60 * 1000 * -1; // remove o offset para virar UTC
  const ts = utcTs; // já é ms epoch UTC
  const iso = new Date(ts).toISOString(); // ISO UTC

  // Mas para conveniência do cliente, queremos ISO com offset -03:00.
  // Converte para string com offset.
  const pad = (n: number, s = 2) => String(n).padStart(s, "0");
  const localTs = ts + tzOffsetMinutes * 60 * 1000; // aplica -03:00
  const dLoc = new Date(localTs);
  const isoLocal =
    `${pad(dLoc.getUTCFullYear(), 4)}-${pad(dLoc.getUTCMonth() + 1)}-${pad(dLoc.getUTCDate())}` +
    `T${pad(dLoc.getUTCHours())}:${pad(dLoc.getUTCMinutes())}:${pad(dLoc.getUTCSeconds())}-` +
    `${pad(Math.abs(tzOffsetMinutes) / 60)}:${pad(Math.abs(tzOffsetMinutes) % 60)}`;

  return { iso: isoLocal, ts };
}

// ---- Worker principal ----
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { method, headers } = req;
    const origin = headers.get("Origin");

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // (Opcional) proteção por header
    if (env.API_KEY) {
      const key = headers.get("x-api-key");
      if (key !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders(origin) },
        });
      }
    }

    // Cache CDN (10 min)
    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, cached);

    // Busca upstream
    const upstream = await fetch(env.SOURCE_URL, {
      headers: { "user-agent": "Mozilla/5.0 (data-fetch for internal dashboard)" },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Extrai linhas da primeira tabela do conteúdo
    const rows: string[][] = [];
    let currentRow: string[] | null = null;
    let colIndex = -1;

    const rewriter = new HTMLRewriter()
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
          currentRow[colIndex] += t.text.trim();
        },
      });

    await rewriter.transform(upstream).arrayBuffer();

    // Mapeamento heurístico das colunas -> campos
    // Ajuste os índices conforme a página (mantemos raw para fallback)
    const ships: Ship[] = rows
      .filter((r) => r.length > 1)
      .map((tds) => {
        const [etaCell, ship, imoMaybe, lengthMaybe, draftMaybe, navMaybe, cargoMaybe, priorityMaybe, terminalMaybe] = [
          tds[0],
          tds[1],
          tds[2],
          tds[3],
          tds[4],
          tds[5],
          tds[6],
          tds[7],
          tds[8],
        ];

        const { iso, ts } = parsePtBrDate(etaCell);

        return {
          eta_text: etaCell,
          eta_iso: iso,
          eta_ts: ts,
          ship,
          imo: imoMaybe && /^\d{7}$/.test(imoMaybe) ? imoMaybe : undefined,
          length_m: toNumber(lengthMaybe),
          draft_m: toNumber(draftMaybe),
          nav: navMaybe || null,
          cargo: cargoMaybe || null,
          priority: priorityMaybe || null,
          terminal: terminalMaybe || null,
          raw: tds,
        };
      });

    // Ordena por ETA real (nulos vão pro final)
    ships.sort((a, b) => {
      const at = a.eta_ts ?? Number.POSITIVE_INFINITY;
      const bt = b.eta_ts ?? Number.POSITIVE_INFINITY;
      return at - bt;
    });

    const payload = JSON.stringify({
      source: env.SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships,
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
