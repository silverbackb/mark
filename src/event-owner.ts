/**
 * Resolution du proprietaire d'un evenement entrant (POST /e).
 *
 * Isole de la couche HTTP et de la base pour etre testable seul : c'est le point du service ou une
 * erreur coute le plus cher (evenements attribues au mauvais client, et donc mauvais workspace
 * debite), et il n'existait aucun test dessus.
 *
 * Regle cardinale : rien de ce qui identifie un client ne vient du corps de la requete. Cet
 * endpoint est public, et tout identifiant qu'il accepterait sur parole serait lisible dans le
 * code source de n'importe quelle page equipee.
 */

export type Owner = { workspace_id: string; project_id: string };

export type OwnerLookup = {
  /** Resout un proprietaire depuis l'origine du site appelant (table snippets). */
  byOrigin: (origin: string) => Promise<{ workspace_id: string; project_id: string | null } | null>;
  /** Chemin de transition : resout depuis le slug encore envoye par les trackers deja poses. */
  bySlug: (slug: string) => Promise<Owner | null>;
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
export function siteOriginFrom(headers: { origin?: string; referer?: string }): string {
  const origin = headers.origin ?? "";
  if (origin) return origin;
  const referer = headers.referer ?? "";
  if (!referer) return "";
  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

/**
 * Retourne le proprietaire resolu, ou null s'il n'est pas determinable avec certitude.
 *
 * null n'est PAS une erreur : l'appelant met alors l'evenement en quarantaine plutot que de le
 * rejeter (il serait perdu, l'appel du tracker etant fire-and-forget) ou de l'attribuer au hasard
 * (il polluerait les donnees d'un client). Un proprietaire sans project_id est traite comme non
 * resolu : la segmentation repose desormais entierement dessus.
 */
export async function resolveEventOwner(
  input: { origin?: string; referer?: string; slug?: string },
  lookup: OwnerLookup
): Promise<Owner | null> {
  const siteOrigin = siteOriginFrom(input);

  if (siteOrigin) {
    const byOrigin = await lookup.byOrigin(siteOrigin);
    if (byOrigin?.project_id) {
      return { workspace_id: byOrigin.workspace_id, project_id: byOrigin.project_id };
    }
  }

  if (input.slug) {
    const bySlug = await lookup.bySlug(input.slug);
    if (bySlug?.project_id) return bySlug;
  }

  return null;
}
