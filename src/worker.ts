// src/worker.ts
export interface Env {
  SOURCE_URL?: string; // Se não setar, usa o padrão abaixo
  API_KEY?: string;    // Opcional: proteger com header x-api-key
}

// ===== CORS totalmente aberto (funciona no Framer Editor e Preview) =====
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

// ===== Tipos =====
type Category = "container" | "liquid" | "bulk" | "other";

type Ship = {
  // PRINCIPAIS (usados no Framer):
  imo?: string | null;            // ← extraído do campo "Terminal" numérico (7 dígitos)
  ship?: string | null;           // Vessel (nome)
  flag?: string | null;           // Bandeira (PT) - mantida por transparência
  flag_en?: string | null;        // Bandeira (EN) - traduzida
  arrival_text?: string | null;   // ETA (texto dd/mm hh:mm)
  arrival_iso?: string | null;    // ETA ISO local
  arrival_ts?: number | null;     // ETA epoch ms (para ordenação)
  notice_code?: string | null;    // EMB/DESC/EMBDESC
  notice_en?: string | null;      // Load / Unload / Load & Unload
  agency?: string | null;         // Agência
  pier?: string | null;           // Nome do terminal (coluna P)
  goods?: string | null;          // Nome da carga

  // EXTRAS (opcionais):
  length_m?: number | null;
  draft_m?: number | null;
  nav?: string | null;
  operation?: string | null;
  weight?: string | null;
  voyage?: string | null;
  duv?: string | null;
  duv_class?: string | null;
  terminal?: string | null;       // valor bruto da última coluna (origem do IMO)
  cargo_category?: Category | null;
  cargo_category_en?: string | null;
  raw?: string[];                 // linha crua para debug
};

// ===== Utilitários =====

// dd/mm[/yyyy] [hh[:mm]]
function parsePt(text?: string | null, now: Date = new Date(), tzOffsetMin = -180) {
  if (!text) return { iso: null as string | null, ts: null as number | null };
  const t = text.normalize("NFKC").trim();
  const m = t.match(
    /(?<d>\d{1,2})\/(?<mo>\d{1,2})(?:\/(?<y>\d{2,4}))?(?:\s+(?<h>\d{1,2})(?::(?<mi>\d{1,2}))?)?/i
  );
  if (!m?.groups) return { iso: null, ts: null };
  let y = m.groups.y ? Number(m.groups.y) : now.getFullYear();
  if (y < 100) y += 2000;
  const d = Number(m.groups.d),
    mo = Number(m.groups.mo);
  const h = m.groups.h ? Number(m.groups.h) : 0;
  const mi = m.groups.mi ? Number(m.groups.mi) : 0;

  // Constrói epoch local (America/Sao_Paulo ~ -03:00) de forma determinística
  const utc = Date.UTC(y, mo - 1, d, h, mi, 0) - tzOffsetMin * 60 * 1000;
  const ts = utc;

  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const lt = ts + tzOffsetMin * 60 * 1000;
  const dloc = new Date(lt);
  const iso =
    `${pad(dloc.getUTCFullYear(), 4)}-${pad(dloc.getUTCMonth() + 1)}-${pad(dloc.getUTCDate())}` +
    `T${pad(dloc.getUTCHours())}:${pad(dloc.getUTCMinutes())}:${pad(dloc.getUTCSeconds())}-` +
    `${pad(Math.abs(tzOffsetMin) / 60)}:${pad(Math.abs(tzOffsetMin) % 60)}`;
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

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// PT → EN (principais bandeiras do tráfego de Santos)
const FLAG_PT_EN: Record<string, string> = {
  "chipre": "Cyprus",
  "panama": "Panama",
  "liberiana": "Liberia",
  "liberia": "Liberia",
  "maltesa": "Malta",
  "bahamas": "Bahamas",
  "ilhas marshall": "Marshall Islands",
  "antiguana": "Antigua and Barbuda",
  "brasileira": "Brazil",
  "singapurense": "Singapore",
  "italiana": "Italy",
  "saudita": "Saudi Arabia",
  "uruguaia": "Uruguay",
  "argentina": "Argentina",
  "paraguaia": "Paraguay",
  "caboverdeana": "Cabo Verde",
  "cabo": "Cape Verde", // quando a tabela vem com "Cabo" abreviado
  // adicione conforme necessário…
};

function toEnglishFlag(flagPt?: string | null): string | null {
  if (!flagPt) return null;
  const key = norm(flagPt);
  return FLAG_PT_EN[key] || flagPt;
}

const K_CONTAINER = [
  "container", "conteiner", "tecon", "santos brasil", "btp", "ecoporto", "dp world",
  "terminal de conteiner", "terminal de container"
];
const K_LIQUID = [
  "oleo", "óleo", "combustivel", "combustível", "diesel", "gasolina", "etanol",
  "alcool", "álcool", "nafta", "qsav", "gasoil", "gasoleo", "gasóleo", "bunker",
  "glp", "lpg", "gnl", "lng", "metanol", "querosene", "solvente", "alamoa"
];
const K_BULK = [
  "granel", "grao", "graos", "grãos", "soja", "milho", "acucar", "açucar", "açúcar",
  "fertiliz", "ureia", "uréia", "sal", "minerio", "minério", "carvao", "carvão",
  "celulose", "trigo", "farelo", "pellet", "potassio", "potássio", "sulfato",
  "soda", "cimento", "clinquer", "clínquer", "coque", "petcoke", "sugar", "grain", "ore"
];

function hasAny(hay: string, needles: string[]) {
  const H = norm(hay);
  return needles.some((n) => H.includes(n));
}

function classifyCargo(
  goods?: string | null,
  terminal?: string | null,
  pier?: string | null,
  agency?: string | null
): { cat: Category; label: string } {
  const bag = [goods || "", terminal || "", pier || "", agency || ""].join(" | ");
  if (hasAny(bag, K_CONTAINER)) return { cat: "container", label: "Container" };
  if (hasAny(bag, K_LIQUID)) return { cat: "liquid", label: "Liquid (Oil)" };
  if (hasAny(bag, K_BULK)) return { cat: "bulk", label: "Bulk" };
  return { cat: "other", label: "Other" };
}

// Extrai IMO a partir do campo "Terminal" numérico ou da linha toda.
// Regras: se 8 dígitos começando em 0 → remove zero à esquerda; aceita 7 dígitos.
function extractImo(terminalField: string, allCells: string[]): string | null {
  const onlyDigits = terminalField.replace(/\D+/g, "");
  if (/^\d{8}$/.test(onlyDigits) && onlyDigits.startsWith("0")) {
    return String(Number(onlyDigits)); // remove zeros à esquerda → vira 7 dígitos
  }
  if (/^\d{7}$/.test(onlyDigits)) return onlyDigits;
  const m = allCells.join(" ").match(/\b(\d{7})\b/);
  return m ? m[1] : null;
}

// ===== Worker =====
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Proteção opcional por API Key
    if (env.API_KEY && req.headers.get("x-api-key") !== env.API_KEY) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    const SOURCE =
      env.SOURCE_URL ||
      "https://www.portodesantos.com.br/informacoes-operacionais/operacoes-portuarias/navegacao-e-movimento-de-navios/navios-esperados-carga/";

    // Cache CDN
    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, cached);

    // Busca a página oficial
    const upstream = await fetch(SOURCE, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; PortoSantosLineup/1.0)" },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    // Extrai todas as linhas de todas as tabelas da página
    const rows: string[][] = [];
    let cur: string[] | null = null;
    let col = -1;

    const rewriter = new HTMLRewriter()
      .on("table tbody tr", {
        element() {
          cur = [];
          rows.push(cur!);
          col = -1;
        },
      })
      .on("table tbody tr td", {
        element() {
          if (!cur) return;
          col++;
          cur[col] = "";
        },
        text(t) {
          if (!cur) return;
          cur[col] = (cur[col] + " " + t.text).trim();
        },
      });

    await rewriter.transform(upstream).arrayBuffer();

    // Filtra linhas muito vazias (ruído)
    const usable = rows.filter((r) => r.filter((v) => v?.trim()).length >= 12);

    // Mapeamento de colunas (observado na página):
    // [0]=Ship, [1]=Flag, [2]=Length/Draft, [3]=Nav, [4]=Arrival,
    // [5]=varia (às vezes código de nav), [6]=Agency, [7]=Notice,
    // [8]=Goods, [9]=Weight, [10]=Voyage, [11]=DUV, [12]=DUV Class,
    // [13]=P (nome terminal), [14]=Terminal (numérico; usamos p/ IMO)
    const ships: Ship[] = usable.map((cells) => {
      const shipName = cells[0] || "";
      const flagPt = cells[1] || "";
      const lenDraft = cells[2] || "";
      const nav = cells[3] || "";
      const arrival = cells[4] || "";
      const col5 = cells[5] || ""; // pode ser código; se for texto, tratamos como "operation"
      const agency = cells[6] || "";
      const notice = cells[7] || "";
      const goods = cells[8] || "";
      const weight = cells[9] || "";
      const voyage = cells[10] || "";
      const duvNum = cells[11] || "";
      const duvClass = cells[12] || "";
      const pier = cells[13] || "";
      const terminalRaw = cells[14] || "";

      const { length, draft } = parseLenDraft(lenDraft);
      const { iso, ts } = parsePt(arrival);
      const operation = /[A-Za-z]/.test(col5) && !/^\d[\d\- ]*$/.test(col5) ? col5 : null;

      // IMO a partir do "Terminal" numérico
      const imo = extractImo(terminalRaw, cells);

      const flagEn = toEnglishFlag(flagPt);
      const cat = classifyCargo(goods, terminalRaw, pier, agency);

      return {
        // principais
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
        pier: pier || null,
        goods: goods || null,

        // extras
        length_m: length,
        draft_m: draft,
        nav: nav || null,
        operation,
        weight: weight || null,
        voyage: voyage || null,
        duv: duvNum || null,
        duv_class: duvClass || null,
        terminal: terminalRaw || null,
        cargo_category: cat.cat,
        cargo_category_en: cat.label,
        raw: cells,
      };
    });

    const body = JSON.stringify(
      {
        source: SOURCE,
        updatedAt: new Date().toISOString(),
        count: ships.length,
        ships,
      },
      null,
      2
    );

    const resp = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...CORS,
      },
    });

    // grava no cache
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
