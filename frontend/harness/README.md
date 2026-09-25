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
| `terminal=paid` / `failed` / `stalled` / `reprice` | ce que fait le lecteur (défaut : il attend la carte) ; *Annuler le paiement* met deux secondes et demie à répondre, comme le vrai serveur qui arrête le lecteur puis relit SumUp |
| `theme=light` / `theme=dark` | force la palette |
| `offline=1` | le serveur ne répond plus |
| `queue=3` | trois ventes en attente dans la file |
| `scans=3` | trois scans faits hors ligne en attente, dont un refus |
| `redeem=fail` | le réseau lâche sous le scan : la porte répond avec sa liste embarquée, et les scans en attente ne partent pas |
| `photos=1` | une photo sur un produit sur deux |
| `checkout=fail` | le serveur refuse d’enregistrer la vente |
| `testmode=1` | événement en mode test |
| `update=1` | le serveur annonce une version plus récente ; laissée sans y toucher, l’app se recharge seule au bout de 20 s à la porte, d’une minute à la caisse |
| `events=one` / `blocked` / `mixed` | les événements que l’appareil atteint : le seul où il est ; plus un sans Open POS ; deux ouverts plus un sans Open POS (défaut : deux ouverts) |
| `load=refused` / `series` / `cdn` | l’événement de l’appareil ne s’ouvre pas : Open POS désactivé dessus, une série sans date ce soir, ou un pare-feu devant pretix qui répond 403 par sa propre page (sans un mot de pretix) |
| `takings=empty` / `nights` / `series` | la recette de l’événement (Réglages → Détail de la recette) : rien de vendu ; un festival sur deux soirées, avec une vente du back-office ; une date d’une série (défaut : une soirée complète) |
| `drawer=closed` / `open` / `stale` / `counted` / `moved` | une caisse espèces est attribuée à l’appareil : fermée, ouverte avec une entrée et une sortie, ouverte depuis un autre jour, comptée et prête à fermer, comptée puis une vente passée ; l’ouvrir, la compter et la fermer dans l’app la font vraiment changer d’état |
| `slow=1` | le serveur met deux secondes et demie à répondre : ce que montre chaque écran pendant qu’il attend (chargement, réessai, catalogue rechargé, scan à la porte) |
| `update=fail` | comme `update=1`, et la nouvelle version ne se télécharge pas : la barre le dit, l’app reste sur la sienne |
| `cancel=already` / `backoffice` / `lost` | ce que le serveur répond à une annulation (Historique) : la vente l’était déjà, sous une autre clé ; elle l’a été depuis le back-office ; la première réponse se perd en route, et la vente relue « annulée » propose *Afficher l’annulation* |
| `camera=busy` | une autre app tient la caméra à l’ouverture du scanner : le cadre rouge et *Réessayer la caméra*, qui la trouve libre |
| `cached=1` | configuration, catalogue et liste embarquée déjà sur l’appareil : avec `offline=1`, une caisse rouverte pendant une coupure plutôt qu’un premier lancement sans réseau |
| `snapshot=21:14` / `yesterday` | l’heure à laquelle la liste embarquée a été tirée, que la porte affiche hors ligne (défaut : celle du jeu d’essai) |

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
