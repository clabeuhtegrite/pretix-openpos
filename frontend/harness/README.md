# Banc d'essai visuel

Les tests rendent l'app dans jsdom, qui n'a pas de pixels : ils disent qu'un
bouton existe, jamais qu'il tient sur l'écran. Ce dossier sert à regarder
l'app pour de vrai — c'est là qu'on a vu qu'un clavier d'encaissement demande
d'être fait défiler sur un téléphone tenu en largeur, et qu'une tablette tenue
en hauteur n'obtient que deux colonnes de produits.

Le vrai `App` tourne, contre un serveur bouchonné dans `main.tsx` : aucun
composant n'est remplacé, donc ce qui s'affiche ici est ce qui s'affiche au
bar.

## S'en servir

```sh
npm run dev
# puis http://localhost:5174/static/pretix_openpos/pwa/harness.html?browser=1
```

Paramètres d'URL, cumulables :

| Paramètre | Effet |
|---|---|
| `role=pos` / `role=door` | le rôle attribué à l'appareil |
| `card=terminal` | un lecteur SumUp est attribué à cette caisse |
| `terminal=paid` / `failed` / `stalled` / `reprice` | ce que fait le lecteur (défaut : il attend la carte) |
| `theme=light` / `theme=dark` | force la palette |
| `offline=1` | le serveur ne répond plus |
| `queue=3` | trois ventes en attente dans la file |
| `photos=1` | une photo sur un produit sur deux |
| `checkout=fail` | le serveur refuse d’enregistrer la vente |
| `testmode=1` | événement en mode test |
| `update=1` | le serveur annonce une version plus récente |
| `events=one` / `blocked` / `mixed` | les événements que l’appareil atteint : le seul où il est ; plus un sans Open POS ; deux ouverts plus un sans Open POS (défaut : deux ouverts) |
| `load=refused` / `series` | l’événement de l’appareil ne s’ouvre pas : Open POS désactivé dessus, ou une série sans date ce soir |

`browser=1` est nécessaire : sans lui l'app affiche l'écran d'installation.

## Captures et mesures

`shoot.mjs` prend des captures, `measure.mjs` relève des tailles réelles
(colonnes de la grille, hauteur du clavier, ce qui dépasse de l'écran). Les
deux ont besoin de Playwright, volontairement absent des dépendances : il
télécharge un navigateur à l'installation, ce que la CI n'a pas à subir pour
un outil qu'on lance à la main.

```sh
npx playwright@latest --version   # installe le paquet une fois
node harness/measure.mjs
node harness/shoot.mjs '[{"name":"grille","size":"tablet"}]'
```

Tailles disponibles : `tablet` (1280×800), `tabletP` (800×1280),
`phoneL` (844×390), `phoneP` (390×844).

Les captures atterrissent dans `harness/shots/`, ignoré par git. `BASE` change
l'URL visée, `OUT` le dossier de sortie, `CHROMIUM` le binaire (utile là où
Playwright n'a pas téléchargé le sien).
