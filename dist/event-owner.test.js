// Tests de la resolution du proprietaire d'un evenement entrant (POST /e).
//
// Ce chemin decide chez QUI un evenement est ecrit et QUEL workspace est debite. L'ancien chemin
// de transition par slug (couvert par une version anterieure de ce fichier) a disparu avec la
// colonne : seul l'Origin de la requete resout desormais un proprietaire.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveEventOwner, siteOriginFrom } from "./event-owner.js";
const OWNER = { workspace_id: "ws-1", project_id: "proj-1" };
/** Registre factice : un seul domaine connu. */
const lookup = {
    byOrigin: async (origin) => origin === "https://client.fr" ? OWNER
        : origin === "https://sans-projet.fr" ? { workspace_id: "ws-3", project_id: null }
            : null,
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
    test("resout par le Referer quand l'Origin est absent", async () => {
        const owner = await resolveEventOwner({ referer: "https://client.fr/une-page" }, lookup);
        assert.deepEqual(owner, OWNER);
    });
    test("domaine inconnu du registre : aucun proprietaire", async () => {
        const owner = await resolveEventOwner({ origin: "https://inconnu.fr" }, lookup);
        assert.equal(owner, null);
    });
    test("un domaine connu mais sans project_id n'est pas un proprietaire", async () => {
        // La segmentation repose entierement sur project_id : sans lui, l'evenement serait invisible
        // partout. Mieux vaut la quarantaine, d'ou il pourra etre rejoue une fois le domaine complete.
        const owner = await resolveEventOwner({ origin: "https://sans-projet.fr" }, lookup);
        assert.equal(owner, null);
    });
    test("ni Origin ni Referer : aucun proprietaire, pas d'appel au registre", async () => {
        let called = false;
        const spy = { byOrigin: async () => { called = true; return OWNER; } };
        const owner = await resolveEventOwner({}, spy);
        assert.equal(owner, null);
        assert.equal(called, false);
    });
});
//# sourceMappingURL=event-owner.test.js.map