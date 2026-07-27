// Regression exacte trouvee en production le 2026-07-27 : canonicalDomain (registre Root, source
// de mark_snippet) est toujours stocke SANS protocole ("debarras-easy.fr"), alors qu'un en-tete
// Origin de navigateur en a TOUJOURS un. L'ancien normalizeUrl retournait la forme sans protocole
// telle quelle des que new URL() echouait, produisant une entree snippets.url qu'aucun Origin reel
// ne pouvait jamais matcher : le client restait en quarantaine malgre un enregistrement reussi.
//
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Necessite DATABASE_URL pour importer db.ts (throw au chargement du module si absent) : valeur
// factice, jamais utilisee par ce test (normalizeUrl ne touche pas au reseau). Import dynamique
// pour que l'affectation ci-dessus s'execute avant, un `import` statique serait hisse avant elle.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { normalizeUrl } = await import("./db.js");

describe("normalizeUrl", () => {
  test("domaine nu sans protocole -> https:// ajoute", () => {
    // Le cas exact du bug : canonicalDomain envoye par mark_snippet.
    assert.equal(normalizeUrl("debarras-easy.fr"), "https://debarras-easy.fr");
  });

  test("URL deja complete : protocole et hostname conserves, www retire", () => {
    assert.equal(normalizeUrl("https://www.debarras-easy.fr"), "https://debarras-easy.fr");
  });

  test("slash final retire, avec ou sans protocole", () => {
    assert.equal(normalizeUrl("debarras-easy.fr/"), "https://debarras-easy.fr");
    assert.equal(normalizeUrl("https://debarras-easy.fr/"), "https://debarras-easy.fr");
  });

  test("un domaine nu et son equivalent avec protocole normalisent au meme resultat", () => {
    // C'est exactement la propriete qui manquait : resolveByUrl doit retrouver un client
    // enregistre via un canonicalDomain nu quand un navigateur envoie un Origin complet.
    assert.equal(normalizeUrl("debarras-easy.fr"), normalizeUrl("https://debarras-easy.fr"));
  });

  test("espaces de bord ignores", () => {
    assert.equal(normalizeUrl("  debarras-easy.fr  "), "https://debarras-easy.fr");
  });

  test("port conserve", () => {
    assert.equal(normalizeUrl("http://localhost:7331"), "http://localhost:7331");
  });

  test("un chemin non racine est conserve (hors trailing slash)", () => {
    // normalizeUrl ne garantit PAS a elle seule "le project_id est enregistre au niveau du
    // domaine, pas de la page" : c'est l'appelant (mark_snippet, POST /register) qui doit
    // toujours passer un domaine racine. Ici on verifie juste ce que la fonction fait reellement.
    assert.equal(normalizeUrl("https://debarras-easy.fr/services/debarras-maison"), "https://debarras-easy.fr/services/debarras-maison");
  });
});
