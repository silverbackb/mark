import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  migrate,
  insertEvent,
  listProjects,
  summary,
  funnel,
  compare,
  friction,
  journey,
  breakdown,
  purge,
  purgeOldEvents,
  registerSnippet,
  resolveUrl,
  resolveByUrl,
  insertUnresolvedEvent,
  listSnippets,
  recentEvents,
  LIMITS,
} from "./db.js";
import { resolveQueryWorkspaceId } from "./workspace-guard.js";
import { resolveEventOwner, siteOriginFrom, type Owner } from "./event-owner.js";

const PORT = parseInt(process.env.PORT ?? process.env.MARK_PORT ?? "7331", 10);
const PUBLIC_URL = (process.env.MARK_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// Workspace used by standalone stdio MCP (self-hosted). Cloud mode passes workspace_id per-request.
const MCP_WORKSPACE_ID = process.env.MARK_WORKSPACE_ID ?? "local";
// Retention par defaut alignee sur Trail (voir code/trail/packages/server/src/index.ts).
const RETENTION_DAYS = parseInt(process.env.MARK_RETENTION_DAYS ?? "365", 10);

// --- HTTP tracker script ---

// Le payload ne transporte plus aucun identifiant de compte : POST /e resout desormais le
// workspace et le client depuis l'Origin de la requete (voir event-owner.ts), exactement comme
// GET /mark.js resout deja ce meme tracker. Les embarquer ici serait redondant (le serveur les
// ignore) et c'etait justement le trou de securite ferme par le correctif C1 : un identifiant lu
// en clair dans le payload d'une page publique n'est jamais une preuve.
function trackerScript(): string {
  return `(function(){
  var k='_mark_sid';
  var sid=sessionStorage.getItem(k)||(Math.random().toString(36).slice(2)+Date.now().toString(36));
  sessionStorage.setItem(k,sid);
  var _eid=null,_tag=null;
  function send(evt,props){
    var payload={session_id:sid,event_name:evt,properties:props||{}};
    if(_eid) payload.entity_id=_eid;
    if(_tag) payload.tag=_tag;
    fetch('${PUBLIC_URL}/e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(function(){});
  }
  window.markjs={
    identify:function(id){ _eid=id||null; },
    setTag:function(t){ _tag=t||null; },
    track:send
  };
  // auto-track page view
  send('page_view',{title:document.title,url:location.pathname});
  // auto-track button/link clicks
  document.addEventListener('click',function(e){
    var el=e.target.closest('button,a,[role=button],input[type=submit],input[type=button]');
    if(!el) return;
    var label=(el.textContent||el.value||el.getAttribute('aria-label')||'').trim().slice(0,60);
    if(el.tagName==='A'&&el.href&&el.href.indexOf('tel:')===0){
      send('tel_click',{phone:el.href.replace('tel:','').trim(),label:label||undefined});
      return;
    }
    var tag=el.dataset.markEvent||null;
    send(tag||'click',{label:label||undefined,id:el.id||undefined,tag:el.dataset.markTag||undefined});
  });
  // auto-track form submits
  document.addEventListener('submit',function(e){
    var form=e.target;
    send('form_submit',{id:form.id||undefined,action:form.action||undefined});
  });
  // scroll depth (25/50/75/100)
  var _scrollFired={};
  window.addEventListener('scroll',function(){
    var el=document.documentElement;
    var scrollable=el.scrollHeight-el.clientHeight;
    if(scrollable<=0) return;
    var pct=Math.round(window.scrollY/scrollable*100);
    [25,50,75,100].forEach(function(t){
      if(pct>=t&&!_scrollFired[t]){_scrollFired[t]=true;send('scroll_depth',{percent:t});}
    });
  },{passive:true});
  // time on page
  var _start=Date.now();
  window.addEventListener('beforeunload',function(){
    send('page_exit',{seconds:Math.round((Date.now()-_start)/1000)});
  });
})();`;
}

// Le tag ne transporte plus rien : workspace, client et site sont tous resolus server-side depuis
// le domaine de la page (Origin/Referer, voir GET /mark.js et resolveByUrl dans db.ts). Il est
// donc strictement identique pour tous les clients et n'a jamais a etre retouche.
function htmlSnippet(): string {
  return `<script async src="${PUBLIC_URL}/mark.js"></script>`;
}

// Derive device / os / browser from the request User-Agent. Server-side so it
// applies to every ingested event without touching the client snippet, and so
// it can't be blocked or spoofed as easily as navigator.userAgent.
function parseUA(ua: string): { device: string; os: string; browser: string } {
  if (!ua) return { device: "unknown", os: "unknown", browser: "unknown" };
  const isTablet = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua);
  const isMobile = !isTablet && /Mobi|Android|iPhone|iPod|IEMobile|BlackBerry|Opera Mini/i.test(ua);
  const device = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  const os = /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Android/i.test(ua) ? "Android"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux"
    : "unknown";
  // Order matters: Edge and Opera UAs also contain "Chrome"; Chrome contains "Safari".
  const browser = /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Safari\//i.test(ua) ? "Safari"
    : "unknown";
  return { device, os, browser };
}



// --- HTTP server ---

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

// Taille maximale acceptee pour le corps d'un evenement. Un evenement analytics normal pese
// moins de 2 Ko : 64 Ko laisse une marge confortable tout en fermant la porte a un POST de
// plusieurs centaines de Mo qui ferait gonfler la RSS du process jusqu'a l'OOM Railway.
const MAX_BODY_BYTES = 64 * 1024;
// Delai maximal de reception du corps, pour qu'une connexion ouverte puis laissee muette ne
// retienne pas une socket indefiniment.
const BODY_TIMEOUT_MS = 10_000;

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

// Accumule le corps de la requete en bornant a la fois la taille et la duree. Rejette des le
// depassement plutot que de continuer a lire une charge qu'on refusera de toute facon.
function readBoundedBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        req.destroy();
        reject(new BodyTimeoutError("Body read timed out"));
      });
    }, BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(() => {
          req.destroy();
          reject(new BodyTooLargeError("Body too large"));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (e: Error) => finish(() => reject(e)));
  });
}

// Applique l'objet LIMITS, qui n'etait jusqu'ici utilise que dans les descriptions MCP et jamais
// a l'insertion. Deux traitements distincts, volontairement :
//   - les champs qui servent de CLE (event_name, tag, entity_id) sont refuses s'ils depassent :
//     les tronquer ferait pointer l'evenement vers une autre cle, donc un autre regroupement.
//     C'est le cas "echec vers le faux" que le projet interdit.
//   - les properties sont du contenu descriptif : on borne le nombre de cles et on tronque les
//     valeurs texte plutot que de perdre l'evenement entier.
function checkEventKeys(
  event_name: string, tag?: string, entity_id?: string,
): string | null {
  if (event_name.length > LIMITS.event_name_max) return `event_name exceeds ${LIMITS.event_name_max} chars`;
  if (tag && tag.length > LIMITS.tag_max) return `tag exceeds ${LIMITS.tag_max} chars`;
  if (entity_id && entity_id.length > LIMITS.entity_id_max) return `entity_id exceeds ${LIMITS.entity_id_max} chars`;
  return null;
}

function clampProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (Object.keys(out).length >= LIMITS.properties_max_keys) break;
    out[key] = typeof value === "string" && value.length > LIMITS.property_string_max
      ? value.slice(0, LIMITS.property_string_max)
      : value;
  }
  return out;
}

async function handleRequestAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, { ok: true, port: PORT });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mark.js") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    // Resolution par domaine (decision d'architecture SilverBackBase) : plus de wid en query
    // param, jamais a retoucher cote client. Origin est envoye par le navigateur sur les
    // requetes cross-origin (le cas normal ici, mark.silverbackbase.com != site du client) et
    // n'inclut jamais de chemin. A defaut (navigateurs qui l'omettent), on retombe sur Referer
    // et on n'en garde que l'origin (le chemin de la page visitee n'a pas a entrer en jeu :
    // project_id est enregistre au niveau du domaine, pas par page).
    const originHeader = (req.headers["origin"] as string | undefined) ?? "";
    const refererHeader = (req.headers["referer"] as string | undefined) ?? "";
    let siteOrigin = originHeader;
    if (!siteOrigin && refererHeader) {
      try {
        siteOrigin = new URL(refererHeader).origin;
      } catch {
        siteOrigin = "";
      }
    }

    if (!siteOrigin) {
      // Ni Origin ni Referer exploitable : on ne peut pas savoir a qui appartient ce domaine.
      // Script vide et inoffensif plutot qu'une erreur bruyante cote navigateur client.
      res.writeHead(200);
      res.end("/* mark: no Origin/Referer header, tracking disabled */");
      return;
    }

    // Seul ce controle de presence dans la table snippets justifie encore resolveByUrl ici : le
    // payload emis par le tracker ne porte plus rien a resoudre (voir trackerScript). Un domaine
    // absent recoit un script inoffensif plutot que des evenements qui partiraient en quarantaine
    // sans que personne ne le sache.
    let resolved: { workspace_id: string; project_id: string | null } | null = null;
    try {
      resolved = await resolveByUrl(siteOrigin);
    } catch (error) {
      console.error(`[mark] resolveByUrl a echoue pour l'origine "${siteOrigin}":`, error);
    }

    if (!resolved) {
      // Domaine inconnu de la table snippets (jamais enregistre via POST /register) : meme
      // reponse inoffensive, pas d'erreur qui casserait la page du client.
      res.writeHead(200);
      res.end("/* mark: domain not registered, tracking disabled */");
      return;
    }

    res.writeHead(200);
    res.end(trackerScript());
    return;
  }

  // --- Ingestion (public — no secret required, workspace_id in body) ---

  if (req.method === "POST" && url.pathname === "/e") {
    let body: string;
    try {
      body = await readBoundedBody(req);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        json(res, { error: "Payload too large" }, 413);
      } else if (e instanceof BodyTimeoutError) {
        json(res, { error: "Request timeout" }, 408);
      } else {
        json(res, { error: "Invalid request" }, 400);
      }
      return;
    }
    try {
      const parsed = JSON.parse(body) as {
        workspace_id?: string; session_id?: string; event_name?: string;
        properties?: Record<string, unknown>;
        tag?: string; entity_id?: string; ts?: number; project_id?: string;
      };
      const { workspace_id, session_id, event_name, properties, tag, entity_id, ts } = parsed;
      if (!session_id || !event_name) {
        json(res, { error: "Missing required fields: session_id, event_name" }, 400);
        return;
      }
      const limitError = checkEventKeys(event_name, tag, entity_id);
      if (limitError) {
        json(res, { error: limitError }, 400);
        return;
      }

      // --- Le proprietaire de l'evenement est resolu SERVEUR, jamais cru sur parole ---
      //
      // Cet endpoint est public. Tout identifiant present dans le corps (workspace_id, project_id)
      // est lisible dans le code source de n'importe quelle page equipee : le croire permettrait
      // d'injecter des evenements chez un client ET de declencher son debit jusqu'a epuiser son
      // solde. C'est le correctif C1, etendu au project_id qui est desormais la cle de segmentation.
      //
      // Seul chemin de resolution : Origin (fallback Referer) -> table snippets. Origin est un
      // en-tete interdit d'ecriture pour du JS de page, le tracker ne peut pas le falsifier. Sans
      // resolution -> quarantaine (202), sans ecriture ni debit — jamais de repli qui accepterait
      // une valeur du corps (c'etait exactement la porte laissee ouverte par l'ancien C1).
      //
      // Mode self-hosted : lu depuis la CONFIGURATION du serveur (MCP_WORKSPACE_ID, variable
      // d'environnement posee par l'operateur), jamais depuis le corps de la requete. Avant ce
      // correctif, ce mode etait detecte via `workspace_id === "local"` fourni par le corps : sur
      // le service cloud, n'importe qui pouvait donc envoyer {workspace_id:"local"} pour
      // contourner a la fois la resolution par Origin et le debit de facturation — un trou de
      // securite independant du slug, trouve en finalisant cette migration. En self-hosted, il n'y
      // a ni registre multi-tenant ni facturation a proteger : le project_id du corps y reste
      // digne de confiance (l'operateur est le seul appelant possible de sa propre instance).
      const isSelfHosted = MCP_WORKSPACE_ID === "local";
      let effectiveWorkspaceId: string;
      let effectiveProjectId: string | null;

      if (isSelfHosted) {
        effectiveWorkspaceId = MCP_WORKSPACE_ID;
        effectiveProjectId = parsed.project_id ?? null;
      } else {
        const headers = {
          origin: req.headers["origin"] as string | undefined,
          referer: req.headers["referer"] as string | undefined,
        };
        const siteOrigin = siteOriginFrom(headers);

        let owner: Owner | null = null;
        try {
          owner = await resolveEventOwner(headers, { byOrigin: resolveByUrl });
        } catch (error) {
          console.error(`[mark] resolution du proprietaire impossible (origin "${siteOrigin}"):`, error);
        }

        if (!owner) {
          // Domaine absent, inconnu, ou sans project_id enregistre. On ne devine pas, mais on ne
          // perd rien : rejouable des que le domaine est enregistre via POST /register.
          try {
            await insertUnresolvedEvent(siteOrigin || null, parsed);
          } catch (error) {
            console.error("[mark] mise en quarantaine impossible:", error);
          }
          json(res, { ok: true, quarantined: true }, 202);
          return;
        }

        effectiveWorkspaceId = owner.workspace_id;
        effectiveProjectId = owner.project_id;
        if (workspace_id && workspace_id !== effectiveWorkspaceId) {
          console.warn(
            `[mark] workspace_id du corps ignore : annonce "${workspace_id}", ` +
            `proprietaire reel "${effectiveWorkspaceId}"`,
          );
        }
      }

      // Fire billing callback if configured
      const eventDebitUrl = process.env.SILVERBACKBASE_EVENT_DEBIT_URL;
      const eventDebitSecret = process.env.SILVERBACKBASE_EVENT_DEBIT_SECRET;
      if (eventDebitUrl && eventDebitSecret && effectiveWorkspaceId !== "local") {
        try {
          const billRes = await fetch(eventDebitUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-event-secret": eventDebitSecret,
            },
            // effectiveWorkspaceId et non workspace_id : c'est le proprietaire reel resolu par
            // Origin qui est debite, jamais le workspace annonce par l'appelant (correctif C1).
            body: JSON.stringify({ workspace_id: effectiveWorkspaceId, event_name }),
          });
          if (billRes.status === 402) {
            json(res, { error: "Insufficient balance" }, 402);
            return;
          }
          // 401 or other errors → still accept event (don't block tracking on billing misconfiguration)
        } catch {
          // Network error → accept event anyway (don't break tracking)
        }
      }
      // Enrich with device/os/browser derived from the User-Agent.
      // Explicit props from the caller win on key conflict.
      const uaProps = parseUA((req.headers["user-agent"] as string | undefined) ?? "");
      const enriched = clampProperties({ ...uaProps, ...(properties ?? {}) });
      // effectiveWorkspaceId / effectiveProjectId : le proprietaire reel resolu ci-dessus, jamais
      // les valeurs annoncees dans le corps.
      await insertEvent(effectiveWorkspaceId, session_id, event_name, enriched, tag, entity_id, ts, effectiveProjectId);
      json(res, { ok: true });
    } catch {
      json(res, { error: "Invalid JSON" }, 400);
    }
    return;
  }

  // --- Query endpoints (workspace_id from x-workspace-id header) ---
  // Require x-internal-secret when configured (open in self-hosted mode)
  const internalSecret = process.env.MARK_INTERNAL_SECRET ?? "";
  // C'est la configuration (secret interne present) qui decide du mode, jamais la valeur
  // recue dans la requete.
  const cloudMode = internalSecret.length > 0;
  if (cloudMode && req.headers["x-internal-secret"] !== internalSecret) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }

  // En mode cloud, un x-workspace-id absent, vide ou blanc ne doit jamais retomber sur "",
  // qui est exactement le DEFAULT des lignes Mark historiques en base : une regression de la
  // passerelle lirait alors silencieusement un lot de donnees partage plutot que d'echouer.
  // Regle du projet : echec vers le vide, jamais vers le faux. En self-hosted (pas de secret
  // configure), le comportement existant est conserve.
  const widDecision = resolveQueryWorkspaceId(cloudMode, req.headers["x-workspace-id"] as string | undefined);
  if (!widDecision.ok) {
    json(res, { error: "Missing or empty x-workspace-id header" }, 401);
    return;
  }
  const wid = widDecision.workspaceId;

  // Enregistre le project_id d'un domaine pour le workspace authentifie (wid resolu depuis le
  // header, jamais depuis le corps — meme principe que le reste de ce bloc). Appele par la
  // passerelle silverbackbase-mcp, typiquement avec l'URL racine du site : project_id est une
  // notion de domaine, pas de page.
  if (req.method === "POST" && url.pathname === "/register") {
    let body: string;
    try {
      body = await readBoundedBody(req);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        json(res, { error: "Payload too large" }, 413);
      } else if (e instanceof BodyTimeoutError) {
        json(res, { error: "Request timeout" }, 408);
      } else {
        json(res, { error: "Invalid request" }, 400);
      }
      return;
    }
    try {
      const parsed = JSON.parse(body) as { project_id?: string; url?: string };
      const { project_id, url: siteUrl } = parsed;
      if (!project_id || !siteUrl) {
        json(res, { error: "Missing required fields: project_id, url" }, 400);
        return;
      }
      const reg = await registerSnippet(wid, siteUrl, project_id);
      json(res, { ok: true, project_id: reg.project_id, url: reg.url });
    } catch {
      json(res, { error: "Invalid JSON" }, 400);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/q/list") {
    json(res, await listProjects(wid));
    return;
  }

  if (req.method === "GET" && url.pathname === "/logs/recent") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
    // project_id optionnel : scope client, meme correctif que sur Trail.
    json(res, await recentEvents(wid, limit, url.searchParams.get("project_id")));
    return;
  }

  const summaryMatch = url.pathname.match(/^\/q\/summary\/(.+)$/);
  if (req.method === "GET" && summaryMatch) {
    const projectId = decodeURIComponent(summaryMatch[1]);
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const tag = url.searchParams.get("tag") ?? undefined;
    json(res, await summary(wid, projectId, isNaN(days) ? 7 : days, tag));
    return;
  }

  const funnelMatch = url.pathname.match(/^\/q\/funnel\/(.+)$/);
  if (req.method === "GET" && funnelMatch) {
    const projectId = decodeURIComponent(funnelMatch[1]);
    const stepsParam = url.searchParams.get("steps") ?? "";
    const steps = stepsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const tag = url.searchParams.get("tag") ?? undefined;
    if (steps.length < 2) {
      json(res, { error: "steps param requires at least 2 comma-separated event names" }, 400);
      return;
    }
    json(res, await funnel(wid, projectId, steps, isNaN(days) ? 30 : days, tag));
    return;
  }

  const compareMatch = url.pathname.match(/^\/q\/compare\/(.+)$/);
  if (req.method === "GET" && compareMatch) {
    const projectId = decodeURIComponent(compareMatch[1]);
    const pivot = url.searchParams.get("pivot") ?? "";
    if (!pivot || isNaN(new Date(pivot).getTime())) {
      json(res, { error: "pivot param required — ISO date e.g. 2026-06-01" }, 400);
      return;
    }
    const event = url.searchParams.get("event") ?? null;
    const daysBefore = parseInt(url.searchParams.get("days_before") ?? "14", 10);
    const daysAfter = parseInt(url.searchParams.get("days_after") ?? "14", 10);
    const tag = url.searchParams.get("tag") ?? undefined;
    json(res, await compare(wid, projectId, pivot, event, isNaN(daysBefore) ? 14 : daysBefore, isNaN(daysAfter) ? 14 : daysAfter, tag));
    return;
  }

  const frictionMatch = url.pathname.match(/^\/q\/friction\/(.+)$/);
  if (req.method === "GET" && frictionMatch) {
    const projectId = decodeURIComponent(frictionMatch[1]);
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const tag = url.searchParams.get("tag") ?? undefined;
    json(res, await friction(wid, projectId, isNaN(days) ? 30 : days, tag));
    return;
  }

  const journeyMatch = url.pathname.match(/^\/q\/journey\/(.+)$/);
  if (req.method === "GET" && journeyMatch) {
    const projectId = decodeURIComponent(journeyMatch[1]);
    const entity_id = url.searchParams.get("entity_id") ?? "";
    if (!entity_id) {
      json(res, { error: "entity_id param required" }, 400);
      return;
    }
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    json(res, await journey(wid, projectId, entity_id, isNaN(days) ? 30 : days));
    return;
  }

  const breakdownMatch = url.pathname.match(/^\/q\/breakdown\/(.+)$/);
  if (req.method === "GET" && breakdownMatch) {
    const projectId = decodeURIComponent(breakdownMatch[1]);
    const event_name = url.searchParams.get("event") ?? "";
    const property = url.searchParams.get("property") ?? "";
    if (!event_name || !property) {
      json(res, { error: "event and property params required" }, 400);
      return;
    }
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const tag = url.searchParams.get("tag") ?? undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 100);
    json(res, await breakdown(wid, projectId, event_name, property, isNaN(days) ? 30 : days, tag, limit));
    return;
  }

  if (req.method === "GET" && url.pathname === "/q/schema") {
    json(res, {
      limits: LIMITS,
      endpoints: [
        {
          method: "POST", path: "/e",
          body: { session_id: "string", event_name: "string", properties: "object?", tag: "string?", entity_id: "string?", ts: "number? (unix ms)" },
          description: "Ingest an event — owner resolved server-side from the Origin/Referer header, never from the body",
        },
        {
          method: "POST", path: "/register",
          body: { project_id: "string", url: "string (domain root, resolved server-side per workspace from x-workspace-id)" },
          description: "Register the project_id for a domain (authenticated, cloud mode only)",
        },
        { method: "GET", path: "/logs/recent", params: { limit: "number (default 50, max 200)", project_id: "string? (scope to one client)" }, description: "Recent events across all clients, or one if project_id is given" },
        { method: "GET", path: "/q/list", description: "List active clients" },
        { method: "GET", path: "/q/summary/:project_id", params: { days: "number (default 7)", tag: "string?" }, description: "Session and event overview" },
        { method: "GET", path: "/q/funnel/:project_id", params: { steps: "comma-separated event names (min 2)", days: "number (default 30)", tag: "string?" }, description: "Funnel conversion by step" },
        { method: "GET", path: "/q/compare/:project_id", params: { pivot: "ISO date", event: "string?", days_before: "number (default 14)", days_after: "number (default 14)", tag: "string?" }, description: "Compare behavior before vs after a date" },
        { method: "GET", path: "/q/friction/:project_id", params: { days: "number (default 30)", tag: "string?" }, description: "Drop-off points by event sequence" },
        { method: "GET", path: "/q/journey/:project_id", params: { entity_id: "string (required)", days: "number (default 30)" }, description: "All events for a specific entity" },
        { method: "GET", path: "/q/breakdown/:project_id", params: { event: "string (required)", property: "string (required)", days: "number (default 30)", tag: "string?", limit: "number (default 30, max 100)" }, description: "Group an event by a property value — e.g. page_view by url" },
      ],
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  handleRequestAsync(req, res).catch((e: unknown) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : "internal error" }));
    }
  });
}

function startHttpServer(): void {
  const server = createServer(handleRequest);
  server.listen(PORT, "::", () => {
    process.stderr.write(`[mark] HTTP server on port ${PORT} (public: ${PUBLIC_URL})\n`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`[mark] Port ${PORT} already in use — HTTP ingestion unavailable. Set MARK_PORT to override.\n`);
    } else {
      process.stderr.write(`[mark] HTTP server error: ${err.message}\n`);
    }
  });
}

// Purge d'age (C21), meme cadence que Trail (purgeOldTouchpoints) : une fois au demarrage puis
// toutes les 24h. purgeOldEvents est elle-meme bornee par lots et sure en cas de demarrage
// simultane de plusieurs instances (voir db.ts).
async function runRetentionPurge(): Promise<void> {
  try {
    const { removed } = await purgeOldEvents(RETENTION_DAYS);
    if (removed > 0) {
      process.stderr.write(JSON.stringify({
        service: "mark", event: "purge", removed, retention_days: RETENTION_DAYS,
        timestamp: new Date().toISOString(),
      }) + "\n");
    }
  } catch (e) {
    process.stderr.write(`[mark] purge failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// --- MCP helpers ---

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

// --- MCP server ---

async function main(): Promise<void> {
  await migrate();
  startHttpServer();

  await runRetentionPurge();
  setInterval(runRetentionPurge, 24 * 60 * 60 * 1000);

  const server = new McpServer({ name: "mark-mcp-server", version: "0.1.15" });

  server.registerTool(
    "mark_snippet",
    {
      title: "Get Tracking Snippet",
      description: `Generate the HTML <script> tag to embed in your app for event tracking.
The tag is identical for every client: Mark resolves the workspace and client (project_id) itself
from the domain of the page that loads it (Origin/Referer), so it never needs to be edited.
Optionally registers the URL → project_id association so it can be retrieved later with mark_resolve.

Paste the returned snippet before </body>. Once loaded:
- window.markjs.track(event_name, props) — record an event
- window.markjs.identify(entityId) — link all subsequent events to an entity (user ID, form ID, etc.)
- window.markjs.setTag(tag) — tag all subsequent events (e.g. "variant-a", "mobile")
Auto-tracking: page_view, clicks on buttons/links, tel_click (tel: links), form_submit, page_exit are recorded automatically.

Limits: event_name max ${LIMITS.event_name_max} chars, props max ${LIMITS.properties_max_keys} keys,
string values max ${LIMITS.property_string_max} chars.

Args:
  - project_id (string): Client this site belongs to
  - url (string, optional): URL of the site being instrumented — registers the URL→project_id mapping for future lookup, and is the condition for ingestion to attribute events to this client

Returns: { snippet, ingestion_url, usage, registered? }
  - snippet: single universal <script> tag, works identically in the <head> or a GTM Custom HTML tag`,
      inputSchema: z.object({
        project_id: z.string().min(1).max(200).describe("Client identifier this site belongs to"),
        url: z.string().url().optional().describe("URL of the site being instrumented — registers the domain → project_id mapping, condition for ingestion to attribute events"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, url }) => {
      const result: Record<string, unknown> = {
        snippet: htmlSnippet(),
        ingestion_url: `${PUBLIC_URL}/e`,
        usage: {
          track: `markjs.track('event_name', { optional: 'props' })`,
          identify: `markjs.identify('user-123') — link events to an entity`,
          setTag: `markjs.setTag('variant-a') — tag events for segmentation`,
        },
      };
      if (url) {
        const reg = await registerSnippet(MCP_WORKSPACE_ID, url, project_id);
        result.registered = reg;
      }
      return ok(result);
    }
  );

  server.registerTool(
    "mark_resolve",
    {
      title: "Resolve URL to Client",
      description: `Look up the client (project_id) registered for a given URL.
Use before instrumenting a site to check if it's already been set up, and retrieve the correct project_id.

Args:
  - url (string): URL to look up (exact match after normalization — trailing slash ignored, fragment ignored)

Returns: { url, project_id, created_at } if found, or { found: false } if no snippet is registered for this URL.

Use when: you're about to instrument a site and want to know which client it's already linked to.
Complement with mark_list_snippets to see all registered URLs.`,
      inputSchema: z.object({
        url: z.string().min(1).describe("URL to look up"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ url }) => {
      const row = await resolveUrl(MCP_WORKSPACE_ID, url);
      return ok(row ?? { found: false, url });
    }
  );

  server.registerTool(
    "mark_list_snippets",
    {
      title: "List Registered Snippets",
      description: `List all URL→client registrations, ordered by most recently created.

Returns: Array of { url, project_id, created_at }

Use when: you want to see which sites have been instrumented and which client each one belongs to.`,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ok(await listSnippets(MCP_WORKSPACE_ID))
  );

  server.registerTool(
    "mark_ingest",
    {
      title: "Inject Event",
      description: `Inject a synthetic event directly from the agent. Useful for testing, seeding, or recording agent-side actions.

Args:
  - project_id (string): Client identifier
  - session_id (string): Unique session identifier
  - event_name (string): Event name — same vocabulary as your instrumentation
  - properties (object, optional): Key-value metadata. Max ${LIMITS.properties_max_keys} keys, strings max ${LIMITS.property_string_max} chars.
  - tag (string, optional): Segment label (e.g. "variant-a", "mobile"). Max ${LIMITS.tag_max} chars.
  - entity_id (string, optional): Persistent entity identifier (user ID, form ID). Max ${LIMITS.entity_id_max} chars.
  - ts (number, optional): Custom timestamp as Unix ms — use to backdate or replay historical events.

Returns: { ok: true, project_id, event_name }`,
      inputSchema: z.object({
        project_id: z.string().min(1).max(200).describe("App or page identifier"),
        session_id: z.string().min(1).describe("Unique session identifier"),
        event_name: z.string().min(1).max(100).describe("Event name"),
        properties: z.record(z.unknown()).optional().describe("Optional key-value metadata"),
        tag: z.string().max(100).optional().describe("Segment label for A/B testing or filtering"),
        entity_id: z.string().max(200).optional().describe("Persistent entity ID (user, form, etc.) — links events across sessions"),
        ts: z.number().int().positive().optional().describe("Custom timestamp as Unix milliseconds — omit to use current time"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project_id, session_id, event_name, properties, tag, entity_id, ts }) => {
      try {
        await insertEvent(MCP_WORKSPACE_ID, session_id, event_name, (properties ?? {}) as Record<string, unknown>, tag, entity_id, ts, project_id);
        return ok({ ok: true, project_id, event_name });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.registerTool(
    "mark_list",
    {
      title: "List Active Clients",
      description: `List all clients (project_id) that have recorded events, with session and event counts.

Returns: Array of { project_id, sessions, events, last_event_ts }

Use when: you want to see what apps are currently being tracked before deeper analysis.`,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ok(await listProjects(MCP_WORKSPACE_ID))
  );

  server.registerTool(
    "mark_summary",
    {
      title: "Get App Summary",
      description: `High-level overview of a client: total sessions, event count, and top events by frequency.

Args:
  - project_id (string): Client identifier (see project_list)
  - days (number, optional): Lookback window in days (default 7, max 365)
  - tag (string, optional): Filter to events with this tag only — useful for comparing segments

Returns: { project_id, period, sessions, events, top_events[], tag? }

Use when: you want a quick health check. Call mark_friction or mark_funnel for deeper analysis.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        days: z.number().int().min(1).max(365).optional().default(7).describe("Lookback window in days (default 7)"),
        tag: z.string().max(100).optional().describe("Filter to events with this tag only"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, days, tag }) => ok(await summary(MCP_WORKSPACE_ID, project_id, days ?? 7, tag))
  );

  server.registerTool(
    "mark_funnel",
    {
      title: "Measure Funnel Conversion",
      description: `Measure conversion through an ordered list of events. The agent defines the funnel steps.

Args:
  - project_id (string): Client identifier (see project_list)
  - steps (string[]): Ordered event names forming the funnel (min 2 steps)
  - days (number, optional): Lookback window in days (default 30)
  - tag (string, optional): Filter to a specific segment — e.g. compare "variant-a" vs "variant-b" by calling twice

Returns: { project_id, steps, counts[], rates[], drop_at, tag? }
  - rates[]: conversion rate vs step 0 (0.0–1.0)
  - drop_at: step with the largest absolute drop-off

Examples:
  - mark_funnel("onboarding", ["page_view", "signup_start", "signup_complete"])
  - mark_funnel("checkout", ["add_to_cart", "checkout_start", "purchase"], 30, "variant-a")`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        steps: z.array(z.string().min(1)).min(2).describe("Ordered list of event names"),
        days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        tag: z.string().max(100).optional().describe("Filter to a specific segment (e.g. 'variant-a')"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, steps, days, tag }) => ok(await funnel(MCP_WORKSPACE_ID, project_id, steps, days ?? 30, tag))
  );

  server.registerTool(
    "mark_compare",
    {
      title: "Compare Before vs After",
      description: `Compare behavior before and after a date pivot. Measures impact of a change.

Args:
  - project_id (string): Client identifier (see project_list)
  - pivot (string): ISO date string as boundary (e.g. "2026-06-01")
  - event (string, optional): If provided, compares completion rate for this event; otherwise compares session counts
  - days_before (number, optional): Days to include before the pivot (default 14)
  - days_after (number, optional): Days to include after the pivot (default 14)
  - tag (string, optional): Filter to a specific segment

Returns: { before, after, delta, metric, tag? }
  - delta: e.g. "+47.9%" or "-12.3%"

Use when: you shipped a redesign, copy change, or fix and want to measure the behavioral impact.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        pivot: z.string().describe("ISO date string as comparison boundary (e.g. \"2026-06-01\")"),
        event: z.string().optional().describe("Compare completion rate for this event; otherwise compares session counts"),
        days_before: z.number().int().min(1).max(180).optional().default(14).describe("Days before the pivot (default 14)"),
        days_after: z.number().int().min(1).max(180).optional().default(14).describe("Days after the pivot (default 14)"),
        tag: z.string().max(100).optional().describe("Filter to a specific segment"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, pivot, event, days_before, days_after, tag }) => {
      if (isNaN(new Date(pivot).getTime())) {
        return err(`Invalid pivot date "${pivot}". Use ISO format e.g. "2026-06-01".`);
      }
      return ok(await compare(MCP_WORKSPACE_ID, project_id, pivot, event ?? null, days_before ?? 14, days_after ?? 14, tag));
    }
  );

  server.registerTool(
    "mark_friction",
    {
      title: "Find Drop-off Points",
      description: `Identify where users stop progressing. Events ordered by average occurrence time, each step shows sessions that stopped there.

Args:
  - project_id (string): Client identifier (see project_list)
  - days (number, optional): Lookback window in days (default 30)
  - tag (string, optional): Filter to a specific segment

Returns: { project_id, total_sessions, drop_events[], tag? }
  - drop_events[]: { event, sessions_reached, sessions_stopped_here, drop_rate }

Use when: you don't know which step is the problem — let Mark surface the friction point.
Then use mark_funnel to zoom in on the suspect step.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        tag: z.string().max(100).optional().describe("Filter to a specific segment"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, days, tag }) => ok(await friction(MCP_WORKSPACE_ID, project_id, days ?? 30, tag))
  );

  server.registerTool(
    "mark_journey",
    {
      title: "Get Entity Journey",
      description: `Retrieve all events for a specific entity (user, session group, or any ID you defined with identify()).
Ordered by timestamp — shows the complete behavioral sequence of that entity.

Args:
  - project_id (string): Client identifier (see project_list)
  - entity_id (string): The entity ID passed via markjs.identify() or mark_ingest(entity_id)
  - days (number, optional): Lookback window in days (default 30)

Returns:
  {
    "project_id": string,
    "entity_id": string,
    "total_events": number,
    "events": [{ "ts": number, "event_name": string, "session_id": string, "properties": object, "tag": string|null }]
  }

Use when: you want to replay or debug a specific user's path. Complement with mark_funnel for aggregate view.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        entity_id: z.string().min(1).max(200).describe("Entity ID to retrieve events for"),
        days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, entity_id, days }) => ok(await journey(MCP_WORKSPACE_ID, project_id, entity_id, days ?? 30))
  );

  server.registerTool(
    "mark_breakdown",
    {
      title: "Breakdown Event by Property",
      description: `Group an event by a property value and count sessions and occurrences per value.

The primary use case is page-level analysis: call with event_name="page_view" and property="url"
to see which pages were visited, how many sessions hit each one, and how many views they got.

Works for any event/property combination:
  - mark_breakdown("at2o", "page_view", "url")       → top pages by sessions
  - mark_breakdown("at2o", "click", "label")          → top clicked button labels
  - mark_breakdown("at2o", "form_submit", "id")       → which forms are submitted
  - mark_breakdown("at2o", "scroll_depth", "percent") → scroll depth distribution

Args:
  - project_id (string): Client identifier (see project_list)
  - event_name (string): Event to group (e.g. "page_view", "click")
  - property (string): Property key to group by (e.g. "url", "label", "percent")
  - days (number, optional): Lookback window in days (default 30)
  - tag (string, optional): Filter to a specific segment (e.g. "ads", "seo")
  - limit (number, optional): Max values to return (default 30, max 100)

Returns:
  {
    "project_id": string,
    "event_name": string,
    "property": string,
    "period": string,
    "total_sessions": number,
    "breakdown": [{ "value": string|null, "sessions": number, "events": number }],
    "tag"?: string
  }

Use when: you see a high event count in mark_summary and need to understand the distribution.
Complement with mark_funnel to measure conversion from a specific page.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier (project_id, see project_list)"),
        event_name: z.string().min(1).max(100).describe("Event name to group (e.g. \"page_view\", \"click\")"),
        property: z.string().min(1).max(100).describe("Property key to group by (e.g. \"url\", \"label\", \"percent\")"),
        days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        tag: z.string().max(100).optional().describe("Filter to a specific segment"),
        limit: z.number().int().min(1).max(100).optional().default(30).describe("Max values to return (default 30, max 100)"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, event_name, property, days, tag, limit }) =>
      ok(await breakdown(MCP_WORKSPACE_ID, project_id, event_name, property, days ?? 30, tag, limit ?? 30))
  );

  server.registerTool(
    "mark_purge",
    {
      title: "Purge Client Data",
      description: `Delete all event data for a client. Irreversible.

Args:
  - project_id (string): Client whose events are all deleted

Returns: { deleted: number }

WARNING: Always confirm with the user before calling this. Data cannot be recovered.`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Client identifier whose events are all deleted"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) => {
      try {
        return ok(await purge(MCP_WORKSPACE_ID, project_id));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mark] MCP server connected via stdio\n");
}

main().catch((e: unknown) => {
  process.stderr.write(`[mark] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
