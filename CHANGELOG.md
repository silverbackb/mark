## v0.2.1 — 2026-07-27

### Corrigé

Deux bugs trouvés en enregistrant le premier nouveau client depuis la sortie de la v0.2.0 —
présents aussi bien sur une base fraîche que sur toute base existante d'avant la v0.2.0, donc
concernant potentiellement toute installation self-hosted, pas seulement notre service cloud.

- **`mark_snippet`/`POST /register` échouait systématiquement** (`400 { error: "Invalid JSON" }`,
  message trompeur) sur toute table `snippets` créée avant l'introduction de `workspace_id` :
  `CREATE TABLE IF NOT EXISTS` ne rejoue pas sa clause `UNIQUE(workspace_id, url)` sur une table
  déjà existante, alors que `registerSnippet()` en a besoin pour son `ON CONFLICT`. `migrate()`
  ajoute désormais cette contrainte de façon idempotente si elle manque, sans jamais faire planter
  le démarrage du service en cas de doublons préexistants (log d'avertissement à la place).
- **Un domaine enregistré sans protocole ne se retrouvait plus jamais.** `canonicalDomain` (Root)
  est toujours stocké sans `https://`, mais un en-tête `Origin` de navigateur en a toujours un :
  l'ancien `normalizeUrl` retournait la forme sans protocole telle quelle dès que `new URL()`
  échouait, donc "mon-site.fr" et "https://mon-site.fr" ne matchaient jamais. Un client fraîchement
  enregistré restait alors invisible pour toujours, ses événements partant en quarantaine sans
  qu'aucun message n'indique pourquoi. `normalizeUrl` suppose désormais `https://` par défaut et
  reste testée (7 cas).

---

## v0.2.0 — 2026-07-27

### Rupture d'API — `slug` supprimé, `project_id` est l'identifiant

Mark identifiait ses clients par un `slug` choisi librement à l'installation, sans lien fiable
avec le domaine réel. Il identifie désormais chaque client par `project_id`, résolu server-side
depuis le domaine de la page (`Origin`/`Referer`), au même titre que le workspace.

**Ce qui casse :**
- Le tag `<script>` ne prend plus de paramètre `?slug=` ni `wid=` : il est strictement identique
  pour tous les clients (`<script async src=".../mark.js"></script>`), et se met à jour tout seul
  (`Cache-Control: no-store`).
- Les 7 outils MCP de lecture (`mark_summary`, `mark_funnel`, `mark_compare`, `mark_friction`,
  `mark_journey`, `mark_breakdown`, `mark_purge`) prennent `project_id` au lieu de `slug`.
- Les routes `/q/*` prennent `:project_id` dans leur chemin au lieu de `:slug`.
- `mark_snippet` ne prend plus `slug` : `project_id` (obligatoire) + `url` (optionnel, enregistre
  le domaine, condition pour que l'ingestion sache attribuer les événements).
- La colonne `slug` est supprimée des tables `events` et `snippets`. Une base existante migre
  automatiquement au démarrage jusqu'à la v0.1.x ; passer directement à la v0.2.0 sur une base
  jamais migrée créera le schéma sans cette colonne, sans étape supplémentaire.

**Sécurité :** `POST /e` ne fait plus jamais confiance à un `workspace_id` ou `project_id` fourni
dans le corps de la requête publique — les deux sont résolus depuis le domaine appelant. Un
événement dont le domaine n'est pas enregistré part dans une table de quarantaine (rejouable une
fois `mark_snippet`/`POST /register` appelé) plutôt que d'être perdu ou mal attribué.

**Self-hosted :** si la requête n'a ni `Origin` ni `Referer` exploitable (appel manuel, script de
test, pas un navigateur), le serveur retombe sur le `project_id` fourni dans le corps — un seul
opérateur possible sur sa propre instance, pas de registre multi-tenant à protéger. Ce repli ne
s'applique jamais quand `MARK_INTERNAL_SECRET` est configuré (mode cloud).

---

## v0.1.15 — 2026-07-07

### Corrigé
- Enrichissement `device` / `os` / `browser` côté serveur dans `POST /e` : dérivés du `User-Agent` de la requête et injectés dans les `properties` de chaque événement ingéré. Corrige le breakdown device qui renvoyait 100% de valeurs nulles (la propriété n'était collectée nulle part). Une valeur `device` explicite envoyée par l'appelant (`track()` custom) reste prioritaire. Non rétroactif : seuls les événements postérieurs au déploiement portent ces propriétés.

---

## v0.1.14 — 2026-06-27

### Ajouté
- Auto-tracking `tel_click` dans le snippet navigateur : les clics sur liens `<a href="tel:...">` déclenchent automatiquement un event `tel_click` avec `{ phone, label }` au lieu du `click` générique.

---

## v0.1.13 — 2026-06-24

### Ajouté
- Outil MCP `mark_breakdown` : groupe un événement par valeur de propriété et renvoie sessions + occurrences par valeur. Exemple : `mark_breakdown("slug", "page_view", "url")` liste les pages les plus visitées avec leurs sessions.
- Route HTTP `GET /q/breakdown/:slug?event=&property=&days=&tag=&limit=` correspondante.

---

## v0.1.12 — 2026-06-20

### Ajouté
- Snippet GTM compatible (`snippet_gtm`) dans `mark_snippet` : injection dynamique via `document.createElement('script')` pour les Custom HTML tags GTM.

### Corrigé
- Endpoint `POST /e` déplacé avant le guard `x-internal-secret` — le tracking navigateur n'était pas bloqué en prod mais la garde était mal ordonnée.
- Snippet: attribut `async` ajouté pour éviter le blocage du rendu.
- CLI `mark-init` : routage de `init` avant le chargement de la DB — corrige le crash `DATABASE_URL` sur `npx @silverbackbase/mark init`.

---

## v0.1.8 — 2026-06-13

### Ajouté
- Auto-tracking scroll depth (25 / 50 / 75 / 100 %) dans le snippet navigateur.

---

## v0.1.7 — 2026-06-12

### Ajouté
- Support Railway : écoute sur `PORT` env var (Railway) avec `MARK_PORT` en fallback
- `MARK_PUBLIC_URL` : URL publique injectée dans le snippet et les réponses `mark_snippet` (pour deploy distant)
- `MARK_DB_PATH` : chemin SQLite configurable (pour volumes Railway)
- Binding sur `::` (IPv6) pour compatibilité Railway

---

## v0.1.6 — 2026-06-12

### Corrigé
- Publication npm corrigée : le dist publié en v0.1.5 contenait encore l'ancien code `spoor`. Cette version shippe le bon dist.

---

## v0.1.5 — 2026-06-11

### Ajouté
- Registre URL → slug (`mark_snippet` accepte un param `url`, `mark_resolve`, `mark_list_snippets`)
- Table `snippets` avec déduplication sur l'URL normalisée

---

## v0.1.4 — 2026-06-10

### Modifié
- Skill `mark-sbb` mis à jour et distribué via le package npm

---

## v0.1.3 — 2026-06-09

### Ajouté
- Support `tag`, `entity_id`, `timestamp` override sur tous les events
- Tool `mark_journey` : replay du parcours complet d'une entité
- Auto-tracking : `page_view`, clics (`button`, `a`, `[role=button]`), `form_submit`, `page_exit`
- `window.markjs.identify(id)` et `window.markjs.setTag(tag)` dans le snippet navigateur

---

## v0.1.2 — 2026-06-08

### Ajouté
- CLI `mark-init` : installe le skill et enregistre le MCP dans Claude Code automatiquement (pattern Trail)
- Distribution du skill `mark-sbb` via le package npm dans `assets/skills/`

---

## v0.1.0 — 2026-06-06

### Ajouté
- Release initiale `@silverbackbase/mark`
- Serveur HTTP sur port 7331 (ingestion `/e`, query `/q/*`, snippet `/mark.js`)
- MCP stdio avec 8 outils : `mark_snippet`, `mark_ingest`, `mark_list`, `mark_summary`, `mark_funnel`, `mark_compare`, `mark_friction`, `mark_purge`
- SQLite local dans `~/.mark/mark.db` (WAL mode)
- Auto-tracking navigateur (page_view, clicks, form_submit, page_exit)
