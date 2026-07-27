// Tests de la resolution du proprietaire d'un evenement entrant (POST /e).
//
// Ce chemin decide chez QUI un evenement est ecrit et QUEL workspace est debite. Avant la
// migration vers project_id, il reposait sur le slug envoye par le client, avec une branche
// permissive (« slug inconnu de la table snippets : on garde le workspace annonce dans le
// corps ») qui laissait ouverte l'injection que le correctif C1 pretendait fermer.
//
// Les deux exigences tenues ici sont contradictoires en apparence : aucun evenement client ne
// doit etre perdu, et aucun identifiant du corps de la requete ne doit etre cru. C'est la
// quarantaine qui les reconcilie : ne pas resoudre retourne null, l'appelant met de cote.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveEventOwner, siteOriginFrom } from "./event-owner.js";

const OWNER = { workspace_id: "ws-1", project_id: "proj-1" };
const AUTRE = { workspace_id: "ws-2", project_id: "proj-2" };

/** Registre factice : deux domaines connus, un slug legacy connu. */
const lookup = {
  byOrigin: async (origin: string) =>
    origin === "https://client.fr" ? OWNER
      : origin === "https://sans-projet.fr" ? { workspace_id: "ws-3", project_id: null }
      : null,
  bySlug: async (slug: string) => (slug === "legacy" ? AUTRE : null),
};

describe("siteOriginFrom", () => {
  test("prefere Origin", () => {
    assert.equal(siteOriginFrom({ origin: "https://a.fr", referer: "https://b.fr/page" }), "https://a.fr");
  });

  test("retombe sur l'origine du Referer, sans le chemin", () => {
    // Un compte est enregistre au niveau du domaine : le chemin de la page ne doit pas entrer en
    // jeu, sinon aucune resolution ne matcherait jamais.
    assert.equal(siteOriginFrom({ referer: "https://b.fr/une/page?x=1" }), "https://b.fr");
  });

  test("ne jette pas sur un Referer illisible", () => {
    assert.equal(siteOriginFrom({ referer: "pas-une-url" }), "");
  });

  test("sans en-tete, chaine vide", () => {
    assert.equal(siteOriginFrom({}), "");
  });
});

describe("resolveEventOwner", () => {
  test("resout par Origin quand le domaine est enregistre", async () => {
    const owner = await resolveEventOwner({ origin: "https://client.fr" }, lookup);
    assert.deepEqual(owner, OWNER);
  });

  test("l'Origin prime sur le slug envoye par le corps", async () => {
    // Le scenario d'injection : un appelant pose un slug appartenant a un autre client. Le
    // domaine reel doit gagner, sinon on ecrit les evenements chez la victime.
    const owner = await resolveEventOwner({ origin: "https://client.fr", slug: "legacy" }, lookup);
    assert.deepEqual(owner, OWNER);
  });

  test("retombe sur le slug quand l'Origin est absent", async () => {
    // Chemin de transition : trackers deja poses chez les clients, appels serveur a serveur.
    const owner = await resolveEventOwner({ slug: "legacy" }, lookup);
    assert.deepEqual(owner, AUTRE);
  });

  test("retombe sur le slug quand le domaine est inconnu du registre", async () => {
    const owner = await resolveEventOwner({ origin: "https://inconnu.fr", slug: "legacy" }, lookup);
    assert.deepEqual(owner, AUTRE);
  });

  test("un domaine connu mais sans project_id n'est pas un proprietaire", async () => {
    // La segmentation repose entierement sur project_id : sans lui, l'evenement serait invisible
    // partout. Mieux vaut la quarantaine, d'ou il pourra etre rejoue.
    const owner = await resolveEventOwner({ origin: "https://sans-projet.fr" }, lookup);
    assert.equal(owner, null);
  });

  test("slug inconnu : aucun proprietaire, jamais celui annonce par le corps", async () => {
    // C'est exactement l'ancienne branche permissive de C1, desormais fermee.
    const owner = await resolveEventOwner({ origin: "https://inconnu.fr", slug: "jamais-vu" }, lookup);
    assert.equal(owner, null);
  });

  test("ni Origin ni slug : aucun proprietaire", async () => {
    assert.equal(await resolveEventOwner({}, lookup), null);
  });

  test("slug ambigu : on ne choisit pas", async () => {
    // bySlug retourne null des qu'un slug designe plusieurs proprietaires (voir resolveBySlug
    // dans db.ts) : deviner reviendrait a facturer un client pour le trafic d'un autre.
    const ambigu = { ...lookup, bySlug: async () => null };
    assert.equal(await resolveEventOwner({ slug: "partage" }, ambigu), null);
  });
});
