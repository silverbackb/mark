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
