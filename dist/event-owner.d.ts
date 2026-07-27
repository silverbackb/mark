/**
 * Resolution du proprietaire d'un evenement entrant (POST /e).
 *
 * Isole de la couche HTTP et de la base pour etre testable seul : c'est le point du service ou une
 * erreur coute le plus cher (evenements attribues au mauvais client, et donc mauvais workspace
 * debite), et il n'existait aucun test dessus.
 *
 * Regle cardinale : rien de ce qui identifie un client ne vient du corps de la requete. Cet
 * endpoint est public, et tout identifiant qu'il accepterait sur parole serait lisible dans le
 * code source de n'importe quelle page equipee. Le seul chemin de resolution est desormais
 * l'Origin de la requete (le chemin par slug, transitoire, a disparu avec la colonne).
 */
export type Owner = {
    workspace_id: string;
    project_id: string;
};
export type OwnerLookup = {
    /** Resout un proprietaire depuis l'origine du site appelant (table snippets). */
    byOrigin: (origin: string) => Promise<{
        workspace_id: string;
        project_id: string | null;
    } | null>;
};
/**
 * Origine du site appelant. `Origin` est un en-tete interdit d'ecriture pour du JS de page : le
 * tracker ne peut pas le falsifier. `Referer` ne sert que de secours pour les navigateurs qui
 * omettent `Origin`, et on n'en garde que l'origine : le chemin de la page visitee n'entre pas en
 * jeu, un compte est enregistre au niveau du domaine.
 *
 * Ce n'est pas de l'authentification : un appel hors navigateur peut forger n'importe quel
 * en-tete. La garantie reelle est ailleurs : le corps de la requete ne decide de rien, seul le
 * registre decide.
 */
export declare function siteOriginFrom(headers: {
    origin?: string;
    referer?: string;
}): string;
/**
 * Retourne le proprietaire resolu, ou null s'il n'est pas determinable avec certitude.
 *
 * null n'est PAS une erreur : l'appelant met alors l'evenement en quarantaine plutot que de le
 * rejeter (il serait perdu, l'appel du tracker etant fire-and-forget) ou de l'attribuer au hasard
 * (il polluerait les donnees d'un client). Un proprietaire sans project_id est traite comme non
 * resolu : la segmentation repose entierement dessus.
 */
export declare function resolveEventOwner(input: {
    origin?: string;
    referer?: string;
}, lookup: OwnerLookup): Promise<Owner | null>;
export type PostEventDecision = {
    kind: "insert";
    workspace_id: string;
    project_id: string | null;
} | {
    kind: "quarantine";
};
/**
 * Decide quoi faire d'un evenement POST /e une fois le proprietaire (eventuellement) resolu par
 * Origin. Extrait de handleRequestAsync et teste isolement : cette zone a deja produit deux
 * regressions de suite (mode self-hosted detecte sur le mauvais signal, puis self-hosted qui
 * shortcut la resolution par Origin et perdait le project_id de ses evenements navigateur).
 *
 * Ordre non negociable :
 *   1. Un proprietaire resolu par Origin gagne TOUJOURS, cloud ou self-hosted : c'est la seule
 *      source qui fonctionne pour un evenement emis par un vrai navigateur, quel que soit le mode.
 *   2. Seulement si Origin echoue, le self-hosted (une instance, un operateur, pas de facturation
 *      a proteger) peut faire confiance au project_id du corps — utile pour un appel manuel
 *      (curl, script de test) qui n'a naturellement pas d'Origin.
 *   3. Le cloud (multi-tenant, facture) n'a aucun repli quand Origin echoue : quarantaine.
 */
export declare function decidePostEvent(owner: Owner | null, isSelfHosted: boolean, selfHostedWorkspaceId: string, bodyProjectId: string | null | undefined): PostEventDecision;
//# sourceMappingURL=event-owner.d.ts.map