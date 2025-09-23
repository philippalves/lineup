// Minimal JS Worker – CORS aberto, sem API key, parser ajustado
export default {
  async fetch(req, env, ctx) {
    const CORS = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const SOURCE =
      "https://www.portodesantos.com.br/informacoes-operacionais/operacoes-portuarias/navegacao-e-movimento-de-navios/navios-esperados-carga/";

    // Cache simples de 10 min
    const cache = caches.default;
    const cacheKey = new Request(new URL(req.url).toString(), req);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, cached);

    const upstream = await fetch(SOURCE, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; PortoSantosLineup/1.0)" },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    // Coleta TODAS as tabelas
    const rows = [];
    let cur = null, col = -1;

    const rw = new HTMLRewriter()
      .on("table tbody tr", {
        element() { cur = []; rows.push(cur); col = -1; }
      })
      .on("table tbody tr td", {
        element() { if (!cur) return; col++; cur[col] = ""; },
        text(t)   { if (!cur) return; cur[col] = (cur[col] + " " + t.text).trim(); }
      });

    await rw.transform(upstream).arrayBuffer();

    // ignora linhas muito vazias
    const usable = rows.filter(r => r.filter(v => v && v.trim()).length >= 12);

    // Helpers
    const norm = s => (s||"").toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
      .replace(/[^\w ]+/g," ").replace(/\s+/g," ").trim();

    const FLAG_PT_EN = {
      "chipre":"Cyprus","panama":"Panama","liberiana":"Liberia","liberia":"Liberia",
      "maltesa":"Malta","bahamas":"Bahamas","ilhas marshall":"Marshall Islands",
      "antiguana":"Antigua and Barbuda","brasileira":"Brazil","singapurense":"Singapore",
      "italiana":"Italy","saudita":"Saudi Arabia","cabo":"Cape Verde"
    };
    const toFlagEn = pt => FLAG_PT_EN[norm(pt)] || pt || null;

    function parseLenDraft(s){
      if(!s) return {length:null,draft:null};
      const t=s.replace(",",".").trim();
      let m=t.match(/^\s*(\d{2,4})\s*[\/ ]\s*(\d+(?:\.\d+)?)\s*$/);
      if(m) return {length:+m[1], draft:+m[2]};
      m=t.match(/^(\d{2,4})(\d+(?:\.\d+)?)$/);
      if(m) return {length:+m[1], draft:+m[2]};
      return {length:null,draft:null};
    }

    function parsePt(text){
      if(!text) return {iso:null, ts:null};
      const m = text.trim().match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+(\d{1,2})(?::(\d{1,2}))?)?/);
      if(!m) return {iso:null, ts:null};
      let y = m[3] ? +m[3] : new Date().getFullYear(); if(y<100) y+=2000;
      const d=+m[1], mo=+m[2], h=+(m[4]||0), mi=+(m[5]||0);
      const tzMin = -180; // -03:00
      const utc = Date.UTC(y, mo-1, d, h, mi, 0) - tzMin*60*1000;
      const ts = utc;
      const pad=(n,w=2)=>String(n).padStart(w,"0");
      const lt = ts + tzMin*60*1000;
      const dt = new Date(lt);
      const iso = `${pad(dt.getUTCFullYear(),4)}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`+
                  `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}-${pad(Math.abs(tzMin)/60)}:${pad(Math.abs(tzMin)%60)}`;
      return {iso, ts};
    }

    function translateNotice(code){
      if(!code) return null;
      const t=code.toUpperCase();
      if(t.includes("EMB") && t.includes("DESC")) return "Load & Unload";
      if(t==="EMB")  return "Load";
      if(t==="DESC") return "Unload";
      return code;
    }

    const K_CONTAINER = ["container","conteiner","tecon","santos brasil","btp","ecoporto","dp world","terminal de conteiner","terminal de container"];
    const K_LIQUID    = ["oleo","óleo","combustivel","combustível","diesel","gasolina","etanol","alcool","álcool","nafta","qsav","gasoil","gasoleo","gasóleo","bunker","glp","lpg","gnl","lng","metanol","alamoa","querosene","solvente"];
    const K_BULK      = ["granel","grao","graos","grãos","soja","milho","acucar","açucar","açúcar","fertiliz","ureia","uréia","sal","minerio","minério","carvao","carvão","celulose","trigo","farelo","pellet","potassio","potássio","sulfato","soda","cimento","clinquer","clínquer","coque","petcoke","sugar","grain","ore"];
    const hasAny = (hay, list) => list.some(w => norm(hay).includes(w));

    function classify(goods, terminal, pier, agency){
      const bag = [goods||"", terminal||"", pier||"", agency||""].join(" | ");
      if(hasAny(bag,K_CONTAINER)) return {cat:"container", label:"Container"};
      if(hasAny(bag,K_LIQUID))    return {cat:"liquid",    label:"Liquid (Oil)"};
      if(hasAny(bag,K_BULK))      return {cat:"bulk",      label:"Bulk"};
      return {cat:"other", label:"Other"};
    }

    function extractImo(terminalField, cells){
      const only = (terminalField||"").replace(/\D+/g,"");
      if(/^\d{8}$/.test(only) && only.startsWith("0")) return String(+only); // tira zero à esquerda
      if(/^\d{7}$/.test(only)) return only;
      const m = cells.join(" ").match(/\b(\d{7})\b/);
      return m ? m[1] : null;
    }

    const ships = usable.map(cells => {
      const shipName = cells[0] || "";
      const flagPt   = cells[1] || "";
      const lenDraft = cells[2] || "";
      const nav      = cells[3] || "";
      const arrival  = cells[4] || "";
      const col5     = cells[5] || "";
      const agency   = cells[6] || "";
      const notice   = cells[7] || "";
      const goods    = cells[8] || "";
      const weight   = cells[9] || "";
      const voyage   = cells[10]|| "";
      const duvNum   = cells[11]|| "";
      const duvClass = cells[12]|| "";
      const pier     = cells[13]|| "";   // nome do terminal (P)
      const terminal = cells[14]|| "";   // campo com número (usamos p/ IMO)

      const { length, draft } = parseLenDraft(lenDraft);
      const { iso, ts } = parsePt(arrival);
      const operation = /[A-Za-z]/.test(col5) && !/^\d[\d\- ]*$/.test(col5) ? col5 : null;

      const imo = extractImo(terminal, cells);
      const flagEn = toFlagEn(flagPt);
      const cat = classify(goods, terminal, pier, agency);

      return {
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

        length_m: length, draft_m: draft, nav: nav || null, operation,
        weight: weight || null, voyage: voyage || null, duv: duvNum || null, duv_class: duvClass || null,
        terminal: terminal || null,
        cargo_category: cat.cat, cargo_category_en: cat.label,
        raw: cells
      };
    });

    const body = JSON.stringify({
      source: SOURCE,
      updatedAt: new Date().toISOString(),
      count: ships.length,
      ships
    });

    const resp = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
        ...CORS
      }
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
};
