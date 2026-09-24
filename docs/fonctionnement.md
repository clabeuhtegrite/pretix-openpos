# Fonctionnement de pretix-openpos

Documentation de fonctionnement du plugin, version 0.22.1. Elle couvre trois
choses, dans cet ordre : ce que le plugin ajoute à pretix, comment le mettre en
service, et ce qui se passe exactement quand un bénévole encaisse.

Pour l'argumentaire, le périmètre et ce qui est délibérément absent (hors ligne,
remboursements, impression), voir le [README](../README.md).

---

## 1. Vue d'ensemble

Le produit est en deux morceaux qui ne partagent aucun code :

| Morceau | Où il vit | Ce qu'il fait |
|---|---|---|
| **Plugin pretix** (`pretix_openpos/`) | Dans le process pretix | Canal de vente, API caisse, journal, écrans back-office |
| **PWA** (`frontend/`) | Dans le navigateur de la tablette | Catalogue, panier, pavé numérique, scan, recette |

La PWA est compilée par Vite dans le répertoire statique du plugin
(`pretix_openpos/static/pretix_openpos/pwa/`) et servie par Django. Il n'y a pas
de second serveur à déployer : **un seul conteneur pretix**, qui sert le back-office,
l'API et la caisse.

```
Tablette / téléphone                        Serveur pretix
┌──────────────────────────┐               ┌──────────────────────────────────┐
│  PWA React + TypeScript  │               │  pretix_openpos                  │
│                          │  Device token │                                  │
│  écran de vente          │──────────────▶│  GET  /openpos/config            │
│  panier (centimes)       │               │  GET  /openpos/catalog           │
│  pavé de paiement        │◀──────────────│  POST /openpos/checkout          │
│  scan QR (jsQR)          │  commande +   │  GET  /openpos/summary           │
│  historique + annulation │  verdict      │  GET  /openpos/attendance        │
│  recette de l'événement  │               │  GET  /openpos/history           │
│  caisse espèces          │               │  POST /openpos/cancel            │
│                          │               │  GET  /openpos/drawer (+4 POST)  │
└──────────────────────────┘               │  ├─ OrderCreateSerializer        │
        localStorage :                     │  ├─ journal PosSale (chaîné)     │
        token, caissier                    │  └─ perform_checkin()            │
                                           └──────────────────────────────────┘
```

Deux principes gouvernent tout le reste :

1. **Le client n'envoie jamais de prix.** Il envoie des identifiants de produit
   et des quantités ; le serveur seul décide de ce que ça coûte.
2. **Chaque encaissement porte une clé d'idempotence.** Un timeout qui avait en
   réalité abouti renvoie la vente d'origine au lieu d'en créer une seconde.

---

## 2. Ce que le plugin ajoute à pretix

Tout est branché par signaux dans [signals.py](../pretix_openpos/signals.py), lui-même
chargé par `PluginApp.ready()` ([apps.py](../pretix_openpos/apps.py)).

### 2.1 Un canal de vente `openpos`

[channels.py](../pretix_openpos/channels.py) déclare un `SalesChannelType`. C'est la
manière native de pretix pour séparer le catalogue du guichet de celui de la
billetterie en ligne : chaque produit porte une case « Open POS » dans
*Disponibilité*.

Attention au défaut, qui n'est pas celui qu'on suppose : pretix met un produit
sur **tous** les canaux tant qu'on ne lui dit pas le contraire, donc tout le
catalogue remonte à la caisse au départ. Les cases ne servent qu'aux produits
qu'on restreint — pour en garder un hors du guichet, ou pour en créer un qui
n'existe *que* là.

Propriétés notables :

- `default_created = True` — le canal est créé pour chaque organisateur, la case
  apparaît sans configuration manuelle. (Pour les organisateurs créés *avant*
  l'installation du plugin, `get_pos_channel()` le crée à la volée au premier
  appel API.)
- `multiple_allowed = False` — un seul canal caisse par organisateur ; distinguer
  les stands est un sujet de reporting, traité par le device.
- `unlimited_items_per_order = True` — un bénévole vend plus d'articles d'un coup
  qu'un client web n'a le droit d'en mettre au panier.
- `discounts_supported = False`, `customer_accounts_supported = False` — les
  remises automatiques et les comptes client sont des mécaniques web.
- `required_event_plugin = "pretix_openpos"` — le canal disparaît des événements
  qui ne font pas de caisse.

### 2.2 Deux moyens de paiement

[payment.py](../pretix_openpos/payment.py) enregistre `openpos_cash` et
`openpos_card`. Ils existent pour une seule raison : que la répartition
espèces/carte apparaisse dans les vues et rapports natifs de pretix, sans que la
caisse tienne une comptabilité parallèle.

Une vente carte est de ce point de vue une vente carte, qu'elle ait été validée
par le lecteur d'une caisse ou prise sur le téléphone d'un bénévole. Ce qui
distingue les deux — la transaction SumUp, et de quoi la rembourser — vit à
côté, dans `PosTerminalPayment` (§5quinquies), plutôt que dans le journal :
le journal dit ce que le tiroir a fait.

L'argent est **toujours encaissé avant** que la commande n'existe, donc ces
prestataires ne participent jamais à un tunnel de paiement interactif :
`is_allowed()` renvoie `False` en dur (jamais proposés dans la boutique),
`is_enabled` renvoie `True` (pour que l'identifiant se résolve quand l'API crée
une commande déjà payée).

`payment_control_render()` affiche « reçu / rendu » sur la page de commande du
back-office.

`openpos_card` sait aussi **rendre l'argent depuis pretix** : pour une carte
qu'un lecteur de l'organisateur a encaissée, `payment_refund_supported()` fait
proposer « Montant total » dans la fenêtre de remboursement de pretix, et
`execute_refund()` envoie le remboursement à SumUp, comme la caisse le fait
quand elle annule (§5bis, *Une vente annulée depuis pretix*). Pas pour une carte
prise sur le téléphone de quelqu'un, ni pour une carte déjà remboursée, ni en
partie. Sous chaque remboursement carte de la page de commande,
`refund_control_render()` affiche la transaction SumUp et, pour un remboursement
que SumUp a refusé, sa réponse.

### 2.3 Un profil de sécurité pour les devices

[security.py](../pretix_openpos/security.py) déclare `OpenPosSecurityProfile`, une
liste blanche d'endpoints. Un token de device vit dans le navigateur d'une
tablette posée sur un comptoir : il faut partir du principe qu'il fuitera. Le
profil par défaut de pretix accorde lecture/écriture sur *toutes* les commandes
de tous les événements visibles ; celui-ci réduit à :

- le cycle de vie du device (`initialize` implicite, `info`, `update`, `roll`,
  `revoke`, `eventselection`) ;
- la lecture des événements (nom, devise) ;
- les dix-sept endpoints Open POS du §8, caisse espèces comprise ;
- `checkinrpc.redeem` et `checkinrpc.search` pour le scan à la porte.

### 2.4 Le journal

[models.py](../pretix_openpos/models.py).

Le plugin ne tient **aucun prix**. Un produit vaut ce que pretix dit qu'il vaut,
à la porte comme dans la boutique. Le plugin a porté pendant un temps une table
de prix à lui, un tarif guichet par produit, et c'est précisément ce qui rendait
la recette illisible : un même produit, deux prix, et rien sur une ligne vendue
pour dire lequel avait été facturé. Vendre plus cher à la porte est désormais un
*produit*, limité au canal `openpos` et tarifé dans pretix comme les autres — ce
qui fait que la recette d'un produit est la recette d'un produit, quel que soit
le poste qui l’a encaissé. Voir §3.2 pour la mise en place.

**`PosSale`** — le journal, en ajout seul. Une ligne par vente, jamais modifiée,
jamais supprimée : `save()` sur une ligne existante et `delete()` lèvent une
`ValueError`. Chaque ligne porte :

| Champ | Rôle |
|---|---|
| `seq` | Compteur sans trou, par événement, à partir de 1 |
| `device`, `device_serial`, `device_name` | La caisse. Dénormalisé pour survivre à la suppression du device |
| `cashier` | Étiquette libre saisie dans l'app, pour distinguer deux bénévoles sur une même tablette ; sur une ligne écrite par le back-office, le compte pretix ou le jeton d'API qui a agi |
| `order`, `order_code` | La commande pretix. Dénormalisé : les commandes de test sont purgeables |
| `testmode` | Écrit à la création, pas déduit après coup (voir §6.4) |
| `positions` | Instantané JSON de ce qui a été vendu, lisible même si le produit est renommé ou supprimé |
| `idempotency_key` | Unique par événement |
| `kind` | `sale`, `cancellation`, `deposit_refund` (consigne rendue, §5quater) ou `reactivation` (§5bis) : une annulation est une ligne neuve, jamais une modification |
| `cancels_seq` | Pour une annulation, le `seq` de la ligne qu'elle contrepasse ; pour une réactivation, celui de l'annulation qu'elle défait |
| `reason` | Le motif saisi par l'opérateur, pour qui lira le journal plus tard |
| `previous_hash`, `hash`, `hash_version` | La chaîne d'intégrité |

Deux modèles de réglage s'y ajoutent, chacun décrit là où il sert :
**`PosDevice`** dit à quoi sert un appareil (§2.7) et **`PosCategory`** dit
quel poste vend une catégorie (§2.7bis). La caisse espèces en ajoute trois —
**`PosDrawer`** (un tiroir réel), **`PosDrawerSession`** (une ouverture, du fond
de caisse à la fermeture) et **`PosDrawerEntry`** (le journal du tiroir, chaîné
lui aussi) — décrits au §5septies. Une vente porte l'ouverture de caisse dans
laquelle son argent est entré, dans le champ `drawer_session`.

### 2.5 Huit écrans de back-office

[views.py](../pretix_openpos/views.py), [arrivals.py](../pretix_openpos/arrivals.py),
[devices.py](../pretix_openpos/devices.py),
[sumup_views.py](../pretix_openpos/sumup_views.py) et
[drawer_views.py](../pretix_openpos/drawer_views.py), montés par
[urls.py](../pretix_openpos/urls.py).

| URL | Écran | Permission exigée |
|---|---|---|
| `/control/event/<org>/<ev>/openpos/` | Réglages (liste de contrôle d'accès) | `event.settings.general:write` |
| `…/openpos/categories/` | Qui vend quoi : la catégorie réservée au bar ou à la porte | `event.items:write` |
| `…/openpos/sales/` | Journal des ventes + recette par caisse et par produit | `event.orders:read` |
| `…/openpos/arrivals/` | Arrivées de la soirée : entrés, pas venus, arrivées par quart d'heure, scans par appareil, refus par motif | `event.orders:read` |
| `/control/organizer/<org>/openpos/arrivals/` | Arrivées : une ligne par soirée, et l'heure d'arrivée sur toutes les soirées passées | `event.orders:read` sur ≥ 1 événement |
| `/control/organizer/<org>/openpos/devices/` | Appareils de caisse : rôle, lecteur et caisse espèces de chacun | `organizer.devices:write` |
| `/control/organizer/<org>/openpos/sumup/` | Lecteurs de carte : le compte SumUp et ses lecteurs | `organizer.devices:write` |
| `/control/organizer/<org>/openpos/drawers/` | Caisses espèces : les tiroirs, l'historique de chacun et le rapport de chaque soirée (§5septies) | `organizer.devices:write` ; en lecture, `event.orders:read` sur **tous** les événements |

La page Ventes porte aussi une action, `…/openpos/sales/catch-up/` (POST,
`event.orders:write`), qui écrit au journal les annulations que pretix a faites
sans lui (§5bis).

Les quatre derniers sont au niveau *organisateur*, et pas par événement : une
caisse est appairée une fois, un lecteur et un tiroir appartiennent à
l'association, et « à quelle heure les gens arrivent-ils ? » est une question
qui porte sur toutes les soirées passées — chacune ayant en plus sa page à elle.
Les écrans matériels sont gardés par la permission des devices de pretix — qui
peut appairer une caisse peut dire à quoi elle sert.

Sept d'entre eux ont leur entrée dans le menu latéral de pretix : *Qui vend
quoi*, *Ventes* et *Arrivées* sous **Open POS** dans celui de l'événement, les
quatre écrans d'organisateur dans celui de l'organisateur. Un lien n'y apparaît
qu'à qui a la permission de l'écran derrière lui, et le menu **Open POS**
n'apparaît pas du tout à qui ne peut en ouvrir aucun. Le huitième, *Réglages*,
reste sur la carte du plugin, sous *Paramètres → Plugins*.

Les deux écrans Arrivées sont strictement en lecture, et lisent le calcul de
l'écran de porte ([attendance.py](../pretix_openpos/attendance.py)) : une soirée
ne peut pas avoir deux réponses.

- **Celui de l'événement** dit la soirée à qui la relit. En tuiles : les
  *entrés* sur les billets attendus, les *pas venus* (*pas encore arrivés* tant
  que la soirée dure), le *quart d'heure de plus forte affluence*, les *refusés*
  avec leur premier motif, et *sur place* dès qu'une sortie est scannée — avec
  le moment où la salle a été la plus pleine. Puis, nuit par nuit (de 6 h à
  6 h, comme la recette), les arrivées par quart d'heure — par demi-heure au-delà
  de douze heures d'ouverture —, empilées *prévente* / *vendus sur place* quand
  il y a des deux, avec leur tableau et leur cumul ; le détail par produit ; les
  scans par appareil (admis, refusés, hors ligne), chaque appareil menant à
  son historique dans pretix ; les refus par motif, dans les mots de pretix, qui
  mènent aux check-ins filtrés sur ce motif. Une *arrivée* est le premier
  passage d'un billet d'admission sur la liste : un billet ressorti puis rentré
  n'arrive qu'une fois, si bien que les arrivées d'une soirée font exactement
  ses *entrés*, et que les refus par motif font exactement la colonne *refusés*
  des téléphones. Un billet vendu en caisse arrive au moment de sa vente,
  puisque c'est la caisse qui fait entrer son acheteur ; il compte parmi les
  vendus sur place, sans être un scan. Dans une série, la page montre une date
  — celle qu'on choisit, sinon celle de ce soir — et la liste celle qu'on
  choisit, sinon celle de la caisse. Elle compte les billets comme pretix et la
  porte les comptent, check-ins automatiques et mode test compris.
- **Celui de l'organisateur** commence par une ligne par soirée commencée —
  chaque événement, et chaque date d'une série —, la plus récente en haut, avec
  ses entrés, ses attendus, ses ventes sur place et son quart d'heure de pointe,
  qui mène à la page de la soirée. Une soirée finie garde ses chiffres un quart
  d'heure en cache ; une soirée en cours est recomptée à chaque affichage.
  Suit l'histogramme des scans d'entrée réussis par heure locale de l'événement
  sur toutes les soirées passées, le pic et le creux. Les check-ins
  automatiques, les commandes en mode test, les scans refusés et les scans de
  sortie n'y comptent pas : cet histogramme mesure des personnes qui franchissent
  une porte. Une équipe limitée à certains événements ne voit que ces
  événements-là.

Les graphiques sont des SVG rendus côté serveur, stylés par une feuille
statique — la CSP du back-office interdit les styles inline, et un `<style>`
bloqué rend chaque rectangle SVG noir par défaut. Leurs coordonnées arrivent au
gabarit déjà écrites : en français, Django écrirait `507,8`, qu'un attribut SVG
lit comme deux nombres.

### 2.6 L'app elle-même

[pwa.py](../pretix_openpos/pwa.py) sert trois choses sous `/openpos/` plutôt que
depuis `/static/` :

- **`/openpos/`** — la coquille HTML, URL stable, marque-page-able, installable.
  Volontairement non authentifiée : le bundle ne contient aucun secret.
- **`/openpos/manifest.webmanifest`** — pour que `start_url` et `scope` pointent
  sur cette URL.
- **`/openpos/sw.js`** — un service worker ne peut contrôler que les URL situées
  à son niveau ou en dessous. Servi depuis `/static/…`, il ne pourrait jamais
  contrôler `/openpos/`. Servi avec `no-cache` : un worker périmé est la façon
  classique de rester bloqué sur un vieux build. Un CDN placé devant pretix peut
  réécrire cet en-tête — Cloudflare, par exemple, impose un `max-age` de 12 h et
  garde le fichier en cache de bordure : après un déploiement qui touche `sw.js`,
  purger ce chemin.

### 2.7 Un rôle par appareil

La même app tourne au bar et à la porte, mais ce ne sont pas le même poste. Un
appareil peut donc se voir attribuer un **rôle**, dans *Open POS → Appareils de
caisse*, au niveau de l'organisateur — là où pretix garde ses devices, parce
qu'une caisse est appairée une fois et vend pour l'événement du soir.

| Rôle | Écran d'accueil | Ce qu'il peut faire |
|---|---|---|
| *Non attribué* | la grille | les deux, comme avant ce réglage |
| **Caisse** | la grille | vendre, encaisser ; pas de bouton porte |
| **Porte** | le scanner | scanner, et *Vendre* pour un billet sur place |

Un appareil sans rôle se comporte exactement comme avant : la grille, avec la
porte à un doigt. C'est ce qui fait que déployer ce découpage ne change rien
tant que personne n'a choisi — y compris en pleine soirée.

Le rôle est stocké côté serveur ([models.py](../pretix_openpos/models.py),
`PosDevice`), et pas dans l'app, et ce n'est pas un détail d'implémentation.
C'est ce qui rend tenable la règle ci-dessous : une app est une page dans un
navigateur, sur une tablette posée sur un comptoir. Elle peut être périmée —
une caisse restée ouverte pendant le déploiement l'est par construction — ou
simplement modifiée. Une règle qu'elle s'appliquerait à elle-même ne serait pas
une règle.

**Une caisse à qui un lecteur de carte est attribué ne peut pas encaisser en
carte sans ce lecteur.** Le champ `sumup_reader_id` porte cette attribution ;
dès qu'il est rempli, `/checkout/` refuse tout `payment_type: "card"` avec le
code `terminal_required`, et l'app affiche le refus plutôt que de laisser
valider. Le refus vaut aussi pour une vente rejouée depuis la file hors ligne,
seul endroit de cet endpoint où une vente déjà payée est refusée : un paiement
lecteur passe par le cloud de SumUp, donc une caisse sans réseau n'a pas pu en
démarrer un, et enregistrer celui-là reviendrait à écrire un paiement carte que
personne ne peut retrouver.

Le lecteur s'attribue sur ce même écran, dans la colonne *Lecteur de carte*, et
seulement à une caisse : un lecteur appartient à un poste, et une porte encaisse
la carte sur le téléphone de quelqu'un. Deux caisses ne peuvent pas se partager
un lecteur non plus — les deux règles sont vérifiées à l'enregistrement, pas
suggérées. La liste déroulante est remplie depuis le compte SumUp de
l'organisateur ; le §5quinquies décrit ce qui se passe ensuite.

### 2.7bis Ce qu'un appareil a le droit de vendre

Le rôle dit sur quel écran un appareil s'ouvre. Il ne disait rien, jusqu'ici, de
ce qu'il pouvait vendre : un bénévole à la porte qui sort d'un scan et passe sur
*Vendre* tombait sur toute la grille, la bière une ligne sous l'entrée.

Une **catégorie de produits** peut donc être réservée à un poste, dans
*Open POS → Qui vend quoi*, par événement.

| Réservée à | Ce que ça fait |
|---|---|
| *Toutes les caisses* | rien : c'est l'état de départ de toute catégorie |
| **La caisse du bar seulement** | un appareil de rôle *porte* ne la voit plus et ne peut plus la vendre |
| **La porte seulement** | l'inverse |

Le réglage est porté par la **catégorie**, pas par l'appareil, et c'est le fond
du choix. Un appareil est appairé une fois pour toutes, une catégorie appartient
à un événement : une liste de catégories rangée sur l'appareil nommerait des
lignes que l'événement suivant n'a pas, et la lecture honnête de « aucune de ces
catégories n'existe ici » est « rien n'est réservé ». La restriction s'éteindrait
donc toute seule à l'événement suivant, sans qu'aucun écran ne le dise. Accrochée
à la catégorie, elle ne s'éteint que là où quelqu'un n'a effectivement rien dit.
En prime, c'est une réponse par catégorie au lieu d'une par appareil : une
tablette prêtée à la porte à neuf heures reçoit un rôle, et le catalogue suit.

Deux défauts, tous les deux dans le même sens — ne rien casser tant que personne
n'a rien demandé :

- **Un appareil sans rôle vend tout**, quoi qu'on réserve. C'est le cas de tout
  appareil appairé avant que les rôles existent, et lui retirer des produits sur
  la foi d'un rôle que personne ne lui a donné serait une régression le jour du
  déploiement, sans qu'aucun écran ait changé.
- **Un produit sans catégorie reste sur toutes les caisses.** Il n'y a pas de
  ligne pour le réserver. L'écran le dit à l'endroit où on s'en apercevrait
  autrement : « j'ai tout réservé et la porte montre encore les T-shirts ».

Comme pour le lecteur de carte, c'est le **serveur** qui refuse, pas la grille.
La grille plus courte est la moitié polie de la règle et c'est elle qui évite
l'erreur ; `/checkout/` refuse la même ligne avec le code `category_not_sold` et
un message qui nomme la catégorie. Une app périmée ou modifiée ne gagne donc
rien à envoyer le panier quand même.

**Sauf une vente déjà payée.** Une vente rejouée depuis la file hors ligne est
enregistrée, pas refusée, et c'est le contraire de ce que fait le lecteur de
carte au même endroit. La différence est ce que coûtent les deux refus. Un
paiement lecteur ne peut pas avoir eu lieu hors réseau, donc l'accepter
reviendrait à écrire un paiement carte que personne ne peut retrouver. Ici
l'argent est dans le tiroir de toute façon : refuser le laisserait là sans
aucune trace, ce qui est exactement l'état que ce journal existe pour éviter. Et
la lecture ordinaire du cas est ennuyeuse — une tablette qui a vendu des bières
avant qu'on lui donne le rôle *porte*, et qui rejoue après.

La vente est donc écrite, **marquée et dite** :

- la ligne de journal porte `outside_role: true`, qui survit à la catégorie
  rendue libre la semaine suivante ;
- la réponse de `/checkout/` porte `off_role` ;
- l'historique de la commande reçoit une entrée
  `pretix_openpos.order.off_role` qui nomme la caisse, le produit et la
  catégorie — c'est la seule que quelqu'un lira.

Les deux boutons qui ne sont pas des produits suivent la catégorie de leur
produit comme les autres : une porte qui ne vend que des billets ne se voit plus
proposer *Consigne rendue*. Offrir le bouton puis refuser la vente mettrait un
bénévole devant un refus avec un client en face, ce qui est pire que de ne pas
l'offrir.

---

## 3. Mise en service (pas à pas)

### 3.1 Installer le plugin

```bash
pip install "pretix-openpos @ git+https://github.com/clabeuhtegrite/pretix-openpos"
python -m pretix migrate
python -m pretix rebuild
```

Le paquet n'est pas sur PyPI, donc l'installation se fait depuis le dépôt.
Épingler un commit (`…pretix-openpos@<sha>`) si on préfère ne pas suivre `main`.

En Docker/Kubernetes, [`deploy/Dockerfile`](../deploy/Dockerfile) intègre le plugin
à l'image officielle :

```bash
cd frontend && npm run build && cd ..
docker build --platform linux/amd64 -f deploy/Dockerfile -t registry/pretix-openpos:0.22.1 .
```

Deux pièges :

- **Compiler le front d'abord.** Le bundle PWA est généré, pas versionné. Une
  image construite sans lui démarre très bien, puis renvoie des 500 sur le
  JavaScript de la caisse.
- **`--platform linux/amd64` sur un Mac Apple Silicon.** Une image arm64 se
  construit, se pousse, passe tous les contrôles de manifeste, puis se fait
  refuser par le kubelet au moment du pull sur un nœud amd64.

### 3.2 Configurer l'événement

1. **Activer le plugin** — *Paramètres → Plugins → Open POS*.
2. **Rendre les produits vendables au guichet** — sur chaque produit, sous
   *Disponibilité*, cocher le canal **Open POS**. Un produit qui n'existe *que*
   sur place se crée en ne cochant que ce canal.
3. **Tarifer les produits** — dans pretix, sur le produit lui-même. La caisse
   facture ce prix-là, sans exception. Pour vendre plus cher à la porte qu'en
   prévente, créer un **produit à part** coché sur le seul canal Open POS
   (« Entrée sur place », par exemple) plutôt que de chercher un second prix :
   la recette reste lisible, un nom valant un prix.

   > **En venant d'une version antérieure à la 0.15.** Le plugin tenait jusque-là
   > un second prix par produit, dans un écran *Prix sur place* qui n'existe plus.
   > La migration `0008` supprime ces lignes, et rien ne peut les ramener : là où
   > un tarif sur place différait du prix pretix, le prix facturé à la caisse
   > change au redémarrage. Avant de les effacer, la migration les écrit dans
   > **l'historique de l'événement** (*Historique*, une entrée par événement, à la
   > date de la mise à jour), qui nomme les produits ayant changé de prix et
   > compte les autres. C'est la seule copie qui survit à la mise à jour, et c'est
   > le premier endroit à regarder après avoir déployé cette version.

4. **Choisir la liste de contrôle d'accès** — *Open POS → Réglages*, dans le
   menu *Paramètres* de la carte du plugin, sur la page de l'étape 1 : le menu
   **Open POS** de la barre latérale ne mène qu'aux deux autres écrans de
   l'événement. Les billets vendus sont pointés sur cette liste immédiatement.
   Laisser vide pour vendre sans pointer.
5. **Boutons supplémentaires** — *Open POS → Réglages*, section du bas. Les deux
   sont éteints tant qu'aucun produit ne leur est affecté :
   - **Produit pour les ventes libres** : active le bouton *Montant libre*, où
     le caissier saisit un montant et un motif. Créez un produit « Divers » à
     0 €, avec un quota (illimité) et le canal Open POS.
   - **Produit de consigne** : active le bouton *Retour consigne*. La consigne
     elle-même se vend comme n'importe quel produit ; ce réglage n'ajoute que le
     retour. Voir §5quater.

   Remettre un de ces menus sur « aucun » éteint la fonction, et c'est tout.
   Jusqu'à la 0.17.0, enregistrer la page avec un menu sur « aucun » empêchait
   la caisse de s'ouvrir : le réglage était relu comme un nombre.

6. **Réserver les catégories, si besoin** — *Open POS → Qui vend quoi*. Facultatif
   et sans effet tant qu'on n'y touche pas : chaque catégorie part sur *toutes les
   caisses*. Réserver *Bar* à la caisse et *Entrées* à la porte est la mise en
   place courante ; elle ne prend effet que sur les appareils à qui un rôle a été
   donné (§3.3 et §2.7bis).

**Copier une soirée.** Un événement créé en copiant un autre (*Copier la
configuration depuis…* dans l'assistant de pretix) reprend la configuration
Open POS, pointée sur **ses propres** liste et produits : la liste de contrôle
d'accès, les produits montant libre et consigne, et *Qui vend quoi*. pretix
recopie les réglages tels quels puis laisse chaque plugin remettre ses
références d'aplomb (signal `event_copy_data`), ce qu'Open POS ne faisait pas
avant la 0.17.0 : la copie gardait les numéros de l'ancien événement, et la
soirée copiée ne pointait plus les billets vendus, perdait ses deux boutons et
revendait la bière à la porte, sans rien qui le dise. Un événement copié avec
une version antérieure se répare en rechoisissant la liste et les deux produits
dans *Open POS → Réglages* et en refaisant *Qui vend quoi*.

### 3.3 Créer une caisse

Sous *Organisateur → Devices → Créer* :

- donner accès à l'événement (ou à tout l'organisateur) ;
- choisir le profil de sécurité **Open POS** ;
- pretix affiche un QR d'appairage et le code en texte.

Un device peut vendre pour plusieurs événements : tout événement auquel il a accès
et où le plugin est activé se choisit dans *Réglages → Événement* de l'app, que
sa boutique soit en ligne ou non, et changer d'événement ne demande pas de
réappairer. Le champ est toujours affiché : avec un seul événement, il le nomme
et dit où en ouvrir d'autres (*Appareils → cet appareil*) ; un événement que
l'appareil atteint mais où Open POS n'est pas activé y est nommé, avec l'endroit
où l'activer, au lieu d'être passé sous silence. Changer d'événement vide le
panier, et demande d'abord confirmation si ce panier porte un avoir.

Puis, sous *Organisateur → Open POS → Appareils de caisse*, dire à quoi sert cet
appareil : **Caisse** pour le bar, **Porte** pour l'entrée. Laisser *non
attribué* est un choix valable et c'est l'état par défaut — l'appareil fait
alors les deux, comme avant l'existence de ce réglage. Voir le §2.7.

Si cette caisse a un lecteur de carte, c'est aussi ici qu'on le lui donne, une
fois le compte SumUp renseigné sous *Open POS → Lecteurs de carte*. Voir le
§5quinquies.

### 3.4 Installer la caisse sur la tablette

1. Ouvrir `https://votre-pretix/openpos/` dans Safari ou Chrome.
2. Ajouter à l'écran d'accueil (l'app affiche les instructions exactes selon
   l'OS — c'est l'écran `InstallGate`).
3. Lancer depuis l'icône, puis scanner le QR d'appairage (ou coller le code).

**Pourquoi ce filtre.** Ouverte dans un onglet, l'app affiche les instructions
d'installation au lieu de la caisse : en mode installé on a le plein écran, pas
de barre d'adresse, et le wake lock empêche l'écran de s'éteindre en plein
service. Échappatoire volontaire : ouvrir une fois `/openpos/?browser=1` autorise
définitivement l'usage en onglet sur cet appareil — être verrouillé hors de sa
caisse le soir d'un événement est une panne pire qu'un bénévole dans un onglet.

**Nommer l'app.** L'étiquette sous l'icône vaut « Open POS » par défaut :

```bash
python -m pretix shell -c "from pretix.base.settings import GlobalSettingsObject; GlobalSettingsObject().settings.set('openpos_app_name', 'Votre lieu')"
```

C'est un réglage global (le manifeste est servi depuis une URL unique). Les
appareils déjà installés gardent l'ancien nom jusqu'à réinstallation de l'icône.

### 3.5 Android et iOS : ce qui diffère réellement

La caisse tourne sur les deux, mais pas par accident — les deux plateformes ne
proposent ni les mêmes API ni les mêmes gestes, et chaque écart est traité :

| Sujet | Android (Chrome) | iOS (Safari) |
|---|---|---|
| Installation | `beforeinstallprompt` intercepté : l'écran d'accueil propose un vrai bouton **Installer** | Aucun équivalent : les trois étapes Partager → Sur l'écran d'accueil restent la seule voie, et sont affichées telles quelles |
| Détection du mode installé | `display-mode: standalone` | `navigator.standalone`, qu'Apple n'a jamais remplacé — les deux sont consultés |
| Geste **retour** | Ferme le panneau ouvert, pas la caisse (chaque panneau empile une entrée d'historique) | N'existe pas |
| Lecture des QR | jsQR, jamais `BarcodeDetector` | Idem — l'API est derrière un drapeau sur 17 et cassée depuis 18 |
| Écran allumé | Wake Lock | Wake Lock depuis Safari 16.4 ; absent avant, on s'en passe sans rien dire. Le mode économie d'énergie le refuse — c'est un verrou de veille, pas un blocage du bouton latéral |
| Vibration au refus | Oui | Non — l'API n'existe pas sur iOS ; le verdict rouge reste la réponse |
| Lampe au scan | Bouton 🔦 quand la caméra en a une | Aucune API : pas de bouton |
| Encoche / barre de gestes | `env(safe-area-inset-*)` sur toutes les couches plein écran | Idem, `viewport-fit=cover` dans le shell |
| Clavier logiciel | Redimensionne la vue | La recouvre : les panneaux à saisie se calent en haut d'écran pour rester visibles dans les deux cas |

Le geste retour mérite un mot : dans une PWA installée, l'historique ne contient
qu'une entrée, donc un retour ferme **l'application** — panier en cours compris.
Chaque panneau ouvert empile donc une entrée et la retire en se fermant, si bien
que le retour veut dire « ferme ça » tant que quelque chose est ouvert. Le
panneau de paiement est délibérément exclu : sortir d'un encaissement à moitié
saisi par réflexe n'est pas quelque chose qu'on met à un geste de distance.

---

## 4. Le déroulé d'une vente

### 4.1 Côté app

1. **Appairage** — `POST /api/v1/device/initialize` échange le code à usage
   unique contre un token durable. L'app appelle ensuite
   `GET /organizers/<org>/openpos/` pour ne proposer que les événements où Open
   POS est réellement activé (un device peut avoir accès à un événement sans que
   l'organisateur y ait ouvert de caisse). Un seul résultat → sélection
   automatique. Le tout est rangé dans `localStorage` sous `openpos.pairing.v1`.
   Que la boutique de l'événement soit en ligne n'entre pas en compte : c'est
   l'affaire du public, aucun endpoint de la caisse ne l'a jamais demandé, et un
   événement en préparation ou qui ne vend qu'à l'entrée est justement de ceux où
   l'on porte une caisse. Le filtre a existé jusqu'en 0.15.2, et un appareil
   ayant accès à deux événements n'en montrait alors qu'un, sans sélecteur.
2. **Chargement** — `config/` et `catalog/` en parallèle. Un 401/403 (device
   révoqué ou supprimé, plugin désactivé sur l'événement) affiche le motif du
   serveur avec deux issues, *Réessayer* et *Dépairer* — sans jamais effacer
   l'appairage de lui-même. Une version antérieure le faisait ; or un CDN ou un
   pare-feu devant pretix répond avec ces mêmes codes quand il conteste une
   requête, et une caisse qui se serait dépairée là-dessus en pleine soirée ne
   se récupère qu'avec un nouveau code frappé au back-office. Quand l'appareil
   a d'autres événements, l'écran d'erreur les propose aussi, sous *ou changer
   d'événement* : sans cela une caisse restée sur un événement qui ne s'ouvre
   plus (Open POS désactivé, série sans date ce soir) n'avait que *Réessayer*
   ou *Dépairer*, alors que l'événement du soir était à un geste. Le catalogue en
   cache n'est pas utilisé non plus dans ce cas : un device révoqué qui
   vendrait sur un vieux catalogue serait refusé à la première vente, devant
   le client.
   Au même moment, si l'app n'est plus celle que pretix a enregistrée pour ce
   device (une nouvelle version, ou une mise à jour du système), elle le lui
   dit par `POST /api/v1/device/update`, l'endpoint natif que pretixSCAN
   appelle après ses propres mises à jour. C'est ce qu'affiche la colonne
   logiciel de la liste des appareils de l'organisateur, qui restait sinon
   figée sur la version de l'appairage. Rien n'est envoyé quand rien n'a
   changé, parce que pretix inscrit une ligne dans l'historique du device à
   chaque fois ; ce qui a été dit est rangé sous `openpos.deviceReport.v1`.
   Un envoi qui n'atteint pas le serveur est refait au retour du réseau ; une
   réponse, même un refus, attend la prochaine ouverture.
3. **Panier** — les montants sont manipulés en **centimes entiers** côté client,
   jamais en flottants. Les quantités sont plafonnées par le stock restant quand
   le quota est fini ; le nombre affiché sur une ligne est un bouton qui ouvre
   les douze quantités d'un coup, une tournée de six ne se tape donc pas en six
   appuis (§5sexies). L'affichage suit ce qu'il y a dedans : en écran étroit le
   panier occupe la hauteur qu'il lui faut, jusqu'à 60 % de l'espace, et c'est la
   grille au-dessus qui cède du terrain — le total et le bouton d'encaissement
   restent visibles en toutes circonstances.
4. **Paiement** — l'ouverture du panneau **frappe la clé d'idempotence**. Le pavé
   numérique se lit en centimes : taper 1-2-3-4 signifie 12,34 €, il n'y a pas de
   virgule à rater dans la file. Boutons rapides : *Appoint*, 5, 10, 20, 50 ;
   celui dont le montant est celui reçu passe au vert, pour qu'un appui se voie
   même quand il n'y a pas de monnaie à rendre. Le rendu de monnaie s'affiche en
   direct.
5. **Envoi** — `POST checkout/` avec la clé, les lignes, le type de paiement, le
   montant reçu, le nom du caissier et `expected_total`.

Sur une caisse à qui un lecteur de carte est attribué, choisir *Carte* insère
deux étapes avant celle-ci : le panier part sur le lecteur, et la vente n'est
envoyée qu'une fois le paiement validé. Le §5quinquies décrit la séquence.

### 4.2 Côté serveur

[api/views.py](../pretix_openpos/api/views.py), méthode `checkout()` :

```
1.  Rejeu ?           PosSale avec cette clé d'idempotence ?
                      → oui : renvoyer la vente d'origine, 200, replayed=true. Fin.

2.  Résolution        Chaque ligne doit être un produit filter_available(channel=openpos).
                      Variante inconnue/inactive → 400. Produit à variantes sans
                      variante → 400.

3.  Tarification      resolve_price() : prix de la date, sinon prix variante,
                      sinon prix produit. Le total est calculé ici, et nulle part ailleurs.

4.  Contrôle          expected_total ≠ total → 400 avec code "price_changed" et le
                      nouveau montant. Rien n'a été encaissé.

5.  Monnaie           espèces et reçu < total → 400. Sinon rendu = reçu − total.

┌── transaction atomique ────────────────────────────────────────────────┐
│ 6.  Commande        OrderCreateSerializer, status "p" (payée), provider │
│                     openpos_cash|openpos_card, send_email=False,        │
│                     sales_channel=openpos, une position par unité.      │
│ 7.  Journal         PosSale.record() : chaîne sur la ligne précédente.  │
│ 8.  Renvoi          journal_seq écrit dans le payment.info_data.        │
└────────────────────────────────────────────────────────────────────────┘

9.  Après commit      order_placed, order_paid, log_action, facture si l'événement
                      en génère. Hors transaction : un échec ici ne doit jamais
                      annuler une commande déjà payée par le client.

10. Contrôle d'accès  perform_checkin() sur chaque position d'admission.
                      Best-effort : l'argent est dans le tiroir, un pointage raté
                      est remonté à l'app, jamais une raison d'échouer la vente.

11. Réponse           201 + code de commande, seq du journal, rendu, checked_in,
                      checkin_errors.
```

L'app affiche alors **« Faites entrer »** si des billets ont été pointés, sinon
**« Vente enregistrée »**.

### 4.3 Détails qui comptent dans cette séquence

**Une position par unité.** Trois billets = trois positions dans la commande,
chacune avec son propre QR — pas une ligne de quantité 3.

**Seuls les produits d'admission sont pointés.** Une liste de contrôle d'accès
avec `all_products=True` accepte volontiers un porte-clefs ou un t-shirt, et
pretix l'enregistrera consciencieusement. Mais « pointé » veut dire que le
porteur a franchi une porte, et une ligne de merchandising n'a pas de porte.
Sans ce filtre, la caisse annonçait aussi « faites entrer » après une vente
purement boutique.

**Le client entre quoi que dise la liste, mais le pointage n'est forcé que s'il
le faut.** Il est d'abord tenté normalement (`questions_supported=False` : une
question obligatoire ne doit pas bloquer la porte), et forcé seulement si pretix
le refuse — une règle de la liste, un produit qu'elle ne prend pas — ce que la
ligne dit alors comme le passage forcé qu'il est. pretix lit `force` comme « cet
appareil était hors ligne » : quand chaque billet vendu en caisse était forcé,
chacun apparaissait dans l'historique des check-ins et dans l'export comme un
scan hors ligne, et la seule marque capable de distinguer les vrais ne voulait
plus rien dire. Une vente encaissée hors ligne, elle, est forcée d'emblée — elle
l'a bien été — et pointée à **l'heure de la vente**, pas à celle de la reprise.

**Le compteur `seq` est réclamé de façon optimiste.** Deux caisses peuvent
committer en même temps ; c'est la contrainte unique `(event, seq)` qui arbitre,
et chaque tentative tourne dans son propre savepoint pour qu'une collision
n'empoisonne pas la transaction qui crée la commande. Ce comportement est
indulgent sur SQLite et impitoyable sur PostgreSQL — d'où
[`dev/concurrency_test.py`](../dev/concurrency_test.py).

---

## 5. Le mode contrôle d'accès

Bouton *Contrôle* de la barre supérieure, visible dès que l'événement a au moins
une liste. C'est [CheckinScreen.tsx](../frontend/src/components/CheckinScreen.tsx).

- **Scan continu** par la caméra arrière, décodage **jsQR** en JavaScript à
  ~8 images/s sur une image réduite à 640 px de côté. Pas de `BarcodeDetector` :
  sur iOS, l'API Shape Detection est derrière un drapeau dans les Réglages sur
  17 et cassée depuis 18 — une caisse sur iPhone ne scannerait jamais rien.
- **Verdict lisible à bout de bras** : vert 4 s, rouge 8 s, et un appui sur le
  verdict le referme aussitôt — le délai ne protège que l'opérateur qui n'a pas
  encore levé les yeux, il ne retient jamais une file qui avance. Un même code
  est ignoré pendant 6 s, fenêtre glissante : un billet resté devant l'objectif
  est redécodé dès que le scan reprend, et le resoumettre répondrait « déjà
  scanné » à une entrée parfaitement valable. Le garde-fou dure donc forcément
  plus longtemps que le verdict qu'il doit couvrir.
- **Vibration sur refus** : Android vibre, iOS n'expose rien de tel et ne vibre
  pas. C'est un rappel, jamais la réponse — celle-ci reste l'écran rouge.
- **Lampe** : bouton 🔦 dans la barre, affiché **uniquement si la caméra en a
  une** (`track.getCapabilities().torch`). Android l'expose depuis longtemps,
  Safari depuis iOS 17.4 — la présence du bouton dépend donc de l'appareil et de
  la version, et les capabilities sont la seule source honnête. Après chaque
  bascule, l'état réel est relu (`getSettings().torch`) : une contrainte
  `advanced` est best-effort par spécification, et un bouton qui n'allume rien
  se retire au lieu d'insister.
- **Trois verdicts, pas deux.** Vert « Entrée autorisée » quand quelqu'un entre.
  Rouge avec le motif quand c'est refusé. Et **bleu « Enregistré · pas une
  entrée »** quand le scan est accepté pour un produit qui ne fait entrer
  personne — ce qu'une liste en `all_products` autorise très bien pour un
  t-shirt. Le compteur les sépare (« 3 admis · 2 refusés · 1 sans entrée ») et
  l'effectif ne bouge pas : les mêmes règles que côté vente, où un panier de
  boissons affiche « Vente enregistrée » et non « Laissez entrer ».
  La liste des produits d'admission vient de `config/` (`admission_items`) et
  couvre **tout l'événement**, pas seulement ce qui est vendable au guichet : un
  billet vendu en ligne doit être reconnu comme une entrée. Un produit absent de
  cette liste est traité comme une admission — annoncer « pas une entrée » à
  quelqu'un qui tient un billet valable serait la pire des erreurs.
- **L'appel est celui de pretix** (`checkinrpc/redeem`), pas un endpoint maison :
  le moteur de règles, les secrets révoqués ou bloqués et les motifs de refus
  exacts viennent de pretix plutôt que d'une réimplémentation qui dériverait.
  L'explication que pretix joint à un refus par règle (une plage horaire, par
  exemple) est affichée sous le motif ; un motif que cette version ne connaît
  pas s'affiche « Refusé », jamais sous forme de clé technique.
- **`questions_supported: false`** : la caisse n'a pas d'écran de questions, donc
  pretix refuse avec un motif explicite au lieu de renvoyer un « incomplet »
  inexploitable.
- **Recherche par nom** (`checkinrpc/search`) quand un code ne passe pas : nom
  partiel, e-mail ou code de commande dans un seul champ.
- **QR uniquement.** jsQR ne lit ni Code128 ni PDF417 ; un billet imprimé avec un
  code-barres non-QR doit passer par un lecteur douchette en mode clavier.

### 5.1 Le compteur de présents

Le second bouton du bas — un quart de la barre, la recherche par nom gardant le
reste — affiche en continu le nombre de **personnes actuellement sur place**.
Le chiffre vient du serveur (`openpos/attendance/`), jamais d'un décompte tenu
dans le navigateur : plusieurs portes scannent le même événement, et les billets
vendus au guichet sont pointés à la vente. Une caisse qui compterait ses propres
scans ne connaîtrait qu'un tiers de la salle.

Il se rafraîchit **toutes les 60 s**, et **1,2 s après chaque scan accepté** —
assez tard pour qu'une rafale de billets ne fasse qu'une requête, assez tôt pour
que le compteur ait bougé quand l'opérateur relève les yeux du verdict.

Un appui ouvre le détail : le total en gros, puis un organigramme qui montre d'où
il sort.

```
                   ┌──────────────────┐
                   │ Billets attendus │   positions valables sur la liste
                   │       220        │   (payées, + en attente si la liste
                   └────────┬─────────┘    les inclut), admission seulement
              ┌─────────────┴─────────────┐
     ┌────────▼────────┐        ┌─────────▼──────────┐
     │     Entrés      │        │ Pas encore arrivés │
     │       141       │        │         79         │
     └────────┬────────┘        └────────────────────┘
        ┌─────┴─────┐
┌───────▼──────┐ ┌──▼────────┐
│  Sur place   │ │ Ressortis │   scan de sortie postérieur au dernier
│     128      │ │    13     │   scan d'entrée
└──────────────┘ └───────────┘
```

Le dernier niveau n'apparaît que si la liste enregistre des sorties — sans quoi
« entrés » et « sur place » sont le même chiffre, et l'organigramme le dit
directement. Suivent une barre de remplissage, puis le détail par produit.

**Seuls les produits « billet d'admission » sont comptés.** Une liste de contrôle
en `all_products` accepte volontiers un t-shirt et pretix enregistre le scan,
mais une file de merchandising n'a pas de porte : compter ces scans répondrait à
« combien d'objets ont été scannés » quand la question posée est « combien de
personnes sont dans la salle ». C'est aussi le seul écart possible avec les
chiffres du back-office pretix, donc les scans hors admission sont affichés à
part plutôt que passés sous silence.

Le calcul des présents est celui de pretix (`CheckinList.positions_inside_query`),
pas une reprise maison : entrée puis sortie puis nouvelle entrée, la personne est
dedans.

Dans une série, les chiffres suivent une date, comme le compteur du scanneur
(§5.2) : celle de la liste si elle est réservée à une date, sinon celle que la
caisse vend ce soir. Une liste ouverte à toutes les dates comptait, jusqu'à la
0.21.1, les billets de toute la saison — trois mille attendus, à une porte qui
en attend deux cents ce soir.

La page *Arrivées* du back-office (§2.5) lit ce même calcul : ses *entrés* sont
ceux du téléphone.

### 5.2 Le compteur du scanneur

Sous les boutons, deux lignes :

- **« Cet appareil : 64 admis · 3 refusés »**, suivi de « 1 sans entrée » pour
  un t-shirt scanné et de « 2 à envoyer » pour les scans que pretix n'a pas
  encore reçus ;
- **« Cet événement, toutes portes : 196 admis »**.

Ce compteur était tenu par l'écran, et repartait à zéro dès que l'app se
rechargeait — ce qu'iOS fait à une app laissée un moment en arrière-plan : c'est
le retour des scanneurs de la première soirée. Il vient maintenant de pretix, par
le bloc `scans` de `attendance/`, compté sur les lignes de check-in de tout
l'événement, quel que soit le jour du scan. La 0.18.0 ne comptait que la soirée,
depuis 6 h comme le relevé de caisse, et un téléphone qui avait fait entrer
soixante-dix personnes y lisait zéro les jours suivants. Ce qui est compté :

- un **scan** est un check-in arrivé par l'API de scan avec un code
  (`raw_source_type` renseigné), de cette app ou de pretixSCAN. Le pointage fait
  à la vente n'en est pas un, ni un pointage automatique ;
- entrées seulement, sur toutes les listes de l'événement. Dans une série, le
  compteur suit une date : celle de la liste si elle est réservée à une date,
  comme les autres chiffres de la liste, sinon celle que la caisse vend ce soir
  (la plus proche s'il n'y en a pas ce soir). Il compte les scans des portes de
  cette date, et ceux de ses billets passés à une porte ouverte à toutes les
  dates ;
- **admis** : accepté pour un produit d'admission ; **refusés** : tous les
  refus, y compris ceux envoyés après coup ; **sans entrée** : accepté pour un
  produit qui ne fait entrer personne ; **hors ligne** : parmi les admis, ceux
  que pretix a reçus après coup — marqués comme tels (`force_sent`), ou arrivés
  plus de deux minutes après le scan, le seuil de pretix, pour ceux qu'une
  version plus ancienne envoyait sans marque.

L'app y ajoute ce que le serveur ne peut pas encore savoir : les scans répondus
depuis la dernière lecture, et ceux qui attendent dans la file, de quelque soir
qu'ils datent. Le dernier chiffre reçu est gardé sur l'appareil, par événement,
et une reprise qui envoie des scans l'y reporte : une app rechargée sans réseau
rouvre sur le chiffre de l'événement, pas sur zéro. Pendant qu'une reprise vide
la file, le compteur ne redescend pas : les scans envoyés restent comptés
jusqu'à ce que le chiffre du serveur les compte.

Le détail de l'effectif (bouton 👥) ajoute un tableau **par appareil** : entrés,
refusés, hors ligne, le plus actif en tête, les scans du back-office sur une
ligne à part. C'est la lecture qui répond à « a-t-on perdu des scans ? » : un
téléphone dont la ligne est plus courte que ce que son bénévole se rappelle a
fait entrer des gens dont pretix n'a jamais entendu parler.

---

## 5bis. Historique et annulation

Bouton 🧾 de la barre supérieure. C'est
[HistoryPanel.tsx](../frontend/src/components/HistoryPanel.tsx), servi par
`openpos/history/` et `openpos/cancel/`.

### Ce que la caisse montre

Les écritures de **tout l'événement**, **de cette caisse seule**. Pas du jour
calendaire : une soirée passe minuit, et couper l'historique à 00:00 le viderait
en plein service, précisément quand une correction devient probable. Au-delà de
100 écritures, la caisse affiche les plus récentes et le dit (`truncated`).
Une annulation se lit d'un coup d'œil : cadre pointillé, montant négatif en
ambre, « annule la #13 » ; la vente contrepassée porte la mention « annulée ».
Une caisse ne corrige donc que ses propres erreurs ; les autres se corrigent sur
leur propre appareil, ou en back-office. Élargir ce pouvoir à toutes les caisses
serait une autre fonctionnalité, avec d'autres conséquences.

### Ce qu'une annulation fait vraiment

Rien n'est jamais modifié ni supprimé. Corriger une commande produit **trois
documents**, là où un tableur aurait changé une ligne :

1. **La vente d'origine** reste au journal, octet pour octet — son hash continue
   de vérifier, et la chaîne avec lui.
2. **L'annulation** : `cancel_order()` de pretix, donc les mêmes effets que
   depuis le back-office — statut `canceled`, secrets de billets invalidés,
   entrée de log signée par le device, et surtout **l'avoir** émis pour la
   facture s'il y en avait une. Un `OrderRefund` marqué `done` enregistre que
   l'argent est ressorti, sans quoi pretix continuerait d'afficher le paiement
   comme encaissé. Puis une **ligne neuve** au journal, de montant négatif,
   pointant sur le `seq` de la vente et portant le motif saisi.
3. **La nouvelle vente**, si l'opérateur corrige : une commande neuve, sa propre
   facture, sa propre ligne de journal.

Conséquence directe : les recettes restent **la somme de la colonne**. Une
annulation étant négative, le tiroir se réconcilie sans arithmétique — et la
recette le dit explicitement (« 2 ventes annulées, −15,00 € : déjà déduites de
tous les montants ici »), parce qu'une caisse qui semble manquer exactement le
montant d'une vente annulée ne manque rien du tout.

### L'argent ne bouge qu'une fois

Après l'annulation, la caisse ne réclame **pas** de rendre la somme : elle
propose deux issues, et l'argent ne circule que sur l'une d'elles.

- **« Corriger la commande »** remet les articles au panier et garde l'avoir en
  mémoire. À l'encaissement, le panneau affiche « À payer 15,00 € / Avoir HWMKJ
  −18,00 € / **À rendre 3,00 €** » — ou « Reste à encaisser » dans l'autre sens.
  Personne ne compte 18 € hors du tiroir pour en réencaisser 15 aussitôt.
- **« Rendre 18,00 € et terminer »** clôt le dossier quand il n'y a rien à
  corriger. Le montant est écrit sur le bouton, pas dans un avertissement à
  côté : c'est le geste qui le porte.

La commande neuve vaut son plein montant et est enregistrée comme telle —
l'avoir est une affaire de tiroir, pas de commande. Le `cash_given` envoyé au
serveur vaut donc avoir + espèces reçues, si bien que le rendu calculé par le
serveur est exactement celui que l'opérateur compte, et que le journal se lit
comme ce qui s'est passé : un avoir imputé sur une vente neuve.

### Ce que la caisse ne fait pas à votre place

- **L'argent physique, tant qu'aucun lecteur n'est en jeu.** Espèces :
  « Rendez 3,00 € sur la caisse. » Carte prise sur le téléphone de quelqu'un :
  « Remboursez 3,00 € sur le TPE » — là, le plugin ne pilote rien et prétendre
  le contraire serait pire que se taire. Une vente encaissée sur le lecteur
  d'une caisse, en revanche, se rembourse toute seule (§5quinquies).
- **Le remboursement partiel.** Une vente s'annule en entier. Reprendre les
  articles au panier, en retirer un et réencaisser fait le même travail, avec
  une piste écrite en trois documents plutôt qu'une modification silencieuse.

### Une vente annulée depuis pretix

Une vente de caisse peut aussi s'annuler hors de la caisse : bouton *Annuler* de
la commande dans le back-office, API de pretix, annulation d'un événement
entier. pretix prévient le plugin (`order_canceled`), qui écrit alors lui-même
l'annulation au journal ([backoffice.py](../pretix_openpos/backoffice.py)) :

- **une ligne neuve**, comme depuis la caisse, qui contrepasse la vente et, s'il
  y en avait, la consigne rendue dans le même panier — le client avait payé le
  net, c'est le net qui sort de la recette ;
- **au nom de qui a annulé** : le compte pretix (son nom, à défaut son e-mail),
  ou le nom du jeton d'API ; vide quand pretix ne nomme personne, un client qui
  annule lui-même par exemple. Le commentaire saisi devient le motif ;
- **sur aucune caisse** : la page Ventes la range sur sa propre ligne,
  *back-office pretix*, et le relevé d'une caisse ne la compte pas, puisque rien
  n'est sorti de son tiroir. Le total de la soirée, lui, baisse ;
- **frais d'annulation gardés** : la ligne ne contrepasse que le reste, et porte
  les frais comme une ligne à part, pour que la colonne tombe juste sur ce que
  pretix garde.

La caisse voit ensuite la vente « annulée » et ne propose plus de l'annuler.
Quand c'est la caisse qui annule, rien de tout cela ne se déclenche : elle
écrit sa propre ligne, avec sa clé, une seule fois.

**L'argent.** pretix enchaîne sur sa fenêtre de remboursement. Espèces : rien ne
change, on rembourse à la main. Carte encaissée sur un lecteur : la ligne
*Terminal de paiement (Open POS)* propose « Montant total », déjà cochée ;
valider demande à SumUp de rembourser la transaction **en entier**, sans le
lecteur ni la carte, exactement comme `cancel/` le fait pour la caisse. SumUp
refuse : pretix marque le remboursement échoué, la page Ventes le liste, et la
réponse de SumUp s'affiche (§5quinquies, *Annuler une vente carte*). SumUp
ne répond pas : le message demande de vérifier la transaction dans l'app SumUp
avant de recommencer, puisque la demande a pu passer. Rembourser une partie
seulement se fait depuis l'app SumUp. Si personne ne rembourse, l'annulation
reste au journal : c'est pretix qui dit ce qui est vendu, et la commande y
apparaît avec un montant à rembourser.

**Un remboursement sans annulation.** *Créer un remboursement* sur une commande
payée coche par défaut *Marquez la commande comme en attente…*, et propose *Ne
faites rien…* : la carte est remboursée, la commande reste, et pretix ne
prévient pas le plugin. Jusqu'à la 0.22.0, la recette comptait donc encore une
vente dont le client avait récupéré l'argent. Depuis la 0.22.1, un remboursement
carte que SumUp accepte depuis pretix écrit lui-même la contrepassation au
journal, sur la ligne *back-office pretix*, au nom de qui a remboursé, et
l'historique de la commande le dit. L'API de pretix sans `mark_canceled` passe
par le même chemin. Une vente déjà contrepassée ne l'est jamais deux fois : le
bouton *Annuler la commande* de la page de commande annule avant le
remboursement, qui trouve la ligne écrite ; l'option *Annuler la commande. Tous
les billets…* de la fenêtre de remboursement, comme `mark_canceled` dans l'API,
rembourse d'abord, et c'est l'annulation qui trouve la ligne écrite.

**La réactivation.** Une commande annulée puis réactivée dans pretix revient
*payée* si personne ne l'avait remboursée : une ligne `reactivation` défait
alors l'annulation, la vente compte de nouveau, et la caisse peut de nouveau
l'annuler. Si l'argent était reparti, pretix la remet *en attente* : le client a
son argent, le journal garde l'annulation, et l'historique de la commande le
dit.

**Avant la 0.20.0**, le plugin n'écoutait pas pretix. Une vente annulée dans le
back-office restait donc dans la recette. La page Ventes les liste sous
*Annulées dans pretix, encore comptées ici*, et le bouton *Les écrire au
journal* (droit de modifier les commandes) les annule au journal **à la date où
pretix les avait annulées**, au nom de qui l'avait fait. La même liste rattrape
une annulation que le plugin n'aurait pas pu écrire sur le moment ; l'historique
de la commande le signale alors.

Ce qui ne suit pas : une commande **modifiée** dans pretix (un article retiré
par *Modifier les produits*) garde sa vente entière au journal. Pour corriger un
panier, on annule et on réencaisse.

### Les factures des ventes au guichet

**Activées par défaut**, et c'est le plugin qui s'en charge, pas les règles de
l'événement. La raison tient en une phrase : sans facture, pas d'avoir — donc
une annulation ne produirait qu'une contrepassation et un remboursement, ce qui
est correct mais incomplet.

Or les réglages de pretix ne pouvaient pas répondre à cette question. La
facturation se règle par événement (`invoice_generate` : jamais, à la demande,
**à la main depuis le back-office**, à la commande, au paiement) et par canal de
vente (`invoice_generate_sales_channels`, dont le défaut ne liste que la
boutique). « À la main » est un choix parfaitement sensé pour une billetterie en
ligne et absurde pour un guichet : personne n'ouvre le back-office pour chaque
bière vendue à une porte.

Le plugin répond donc pour **son** canal et pour lui seul
([invoicing.py](../pretix_openpos/invoicing.py)) : la case « Émettre une facture
pour les ventes au guichet » (*Open POS → Réglages*) signifie « une vente au
guichet est facturée », quoi que fasse l'événement par ailleurs. La boutique en
ligne garde exactement les règles qu'on lui a données. Décocher rend la main aux
réglages de pretix.

La case est cochée à l'activation du plugin sur un événement (hook `installed`),
et un événement où personne n'a jamais touché ce réglage est traité comme cochée
— vérifié sur un événement en `invoice_generate = "admin"` avec le seul canal
`web` : la vente produit sa facture et l'annulation son avoir, sans qu'aucun
autre réglage n'ait bougé.

### Garde-fous

| Cas | Réponse |
|---|---|
| Vente d'une autre caisse | 400, « cette vente a été faite sur une autre caisse » |
| Vente déjà annulée | 400, et le bouton n'est de toute façon plus proposé |
| Rejeu de la même requête | 200 avec `replayed: true`, la première annulation est renvoyée |
| Commande purgée (mode test) | 400 : le journal survit à la commande, pas l'inverse |
| pretix refuse l'annulation | 400 avec le motif de pretix, tel quel |

---

## 5ter. Le mode hors ligne

Une coupure réseau pendant un événement ne doit pas arrêter la caisse. Tout
continue : on vend, on encaisse, on scanne. Ce qui change, c'est que le serveur
l'apprend plus tard — et la difficulté n'est pas de continuer à fonctionner,
c'est que la reprise soit vérifiable.

### Comment la caisse sait qu'elle est coupée

Pas par `navigator.onLine` : il décrit une interface réseau, pas un serveur, et
sur le wifi d'une salle un téléphone est très souvent « en ligne » sur une borne
qui ne mène nulle part. La vérité vient des requêtes elles-mêmes — toute réponse
du serveur remet en ligne, toute panne de transport **et tout 5xx** mettent hors
ligne — et un `HEAD` sur `/openpos/` toutes les 10 s sert de sonde tant que la
caisse se croit coupée. Les événements du navigateur ne sont qu'un signal pour
aller vérifier.

### Ce qui continue de marcher

| | Hors ligne |
|---|---|
| Vendre | Oui, au tarif embarqué ; la vente part en file d'attente |
| Rendre la monnaie | Oui, calculé localement |
| Scanner un billet | Oui, contre la **liste embarquée** (`openpos/offline/`), chargée dès l'appairage pour la liste de la porte — pas seulement à l'ouverture du scan — et rafraîchie toutes les 5 min tant qu'il y a du réseau |
| Redémarrer la caisse | Oui : catalogue et configuration du dernier chargement sont conservés par événement |
| Historique, annulation, effectif | Non — ils demandent le serveur, et l'écran le dit |

Un scan tenté en ligne qui n'aboutit pas — réseau coupé pendant le scan, pretix
qui redémarre, pas de réponse en 8 s — est répondu de la même façon, contre la
liste embarquée, et gardé sous le `nonce` avec lequel il était parti : si la
requête était bien arrivée, pretix reconnaît le rejeu au lieu de compter la
personne deux fois. Il finissait sur un message d'erreur au bout de 30 s, sans
être gardé nulle part, alors que la personne était déjà entrée. Le verdict dit
« Hors ligne · gardé sur l'appareil » chaque fois que c'est le téléphone qui a
répondu.

Une vente encaissée pendant la coupure porte **le prix que la caisse avait en
mémoire**. C'est le seul endroit de tout le plugin où un prix vient du client, et
c'est assumé : le client a payé cette somme, c'est un fait, pas une proposition.
Le bloc `offline` de `checkout/` est ce qui l'autorise, et rien d'autre — un prix
envoyé sans lui reste refusé en 400.

### La reprise

À la reconnexion, la file part **dans l'ordre, une écriture à la fois**, et
seulement si personne n'est en train d'encaisser. Trois règles gouvernent tout :

1. **On ne retire de la file que ce que le serveur a pris.** Chaque écriture
   porte la clé qui la rend idempotente — clé d'idempotence pour une vente,
   `nonce` pour un scan. Une réponse perdue au retour coûte une requête en trop,
   jamais une vente en double : vérifié, un rejeu d'une vente déjà synchronisée
   ne crée aucune ligne.
2. **5xx et panne réseau = « pas maintenant ».** L'écriture garde sa place et la
   reprise s'arrête là. Seul un 4xx est un refus motivé du serveur.
   *Se tromper dans ce sens coûte une requête ; se tromper dans l'autre sort une
   vente encaissée de la file et elle n'arrive jamais — c'est le bug qu'une
   première version de ce code avait, trouvé en coupant vraiment le serveur.*
3. **Aucun refus n'est avalé.** Une écriture refusée passe dans une liste qui
   survit aux redémarrages et reste affichée jusqu'à ce qu'un humain la traite.

Un scan part comme pretix attend qu'un scan hors ligne parte : **forcé**, avec
son heure d'origine. pretix l'enregistre quoi qu'il répondrait maintenant — la
personne est entrée sur la réponse donnée à ce moment-là — et le **marque comme
scan hors ligne** : icône de nuage et heure de réception dans l'historique des
check-ins, colonne dans l'export « Journal d'enregistrement ». Un billet passé
entre-temps à une autre porte y figure comme un passage forcé, pas comme le refus
de quelqu'un qui est déjà dans la salle. Un **refus** donné hors ligne part
aussi, vers `failed_checkins`, l'endpoint de pretix pour ça (celui de
pretixSCAN) : il apparaît comme « Échec en mode hors connexion », rattaché au
billet quand le code en désigne un. En ligne, pretix écrit lui-même chaque refus ;
hors ligne, rien n'en gardait trace.

La reprise part dès que le réseau revient, puis est retentée toutes les 15 s
tant que quelque chose attend. Une requête qui échoue aussitôt suivie d'une qui
passe ne se voit pas comme un retour du réseau : vérifié contre un vrai pretix,
des scans restaient ainsi sur le téléphone, réseau revenu, jusqu'à la
réouverture de l'app. Pour la même raison, la liste embarquée n'est pas
rechargée plus d'une fois par minute sur un réseau qui va et vient.

Une vente qui appartient à **un autre événement** — la caisse a changé
d'événement avec une file non vide — n'est ni envoyée ici ni bloquante : elle est
enjambée, comptée, et le panneau dit à quel événement elle attend de revenir. Un
scan, lui, part quel que soit l'événement de la caisse : il désigne sa liste, et
la liste son événement.
Elle arrêtait la reprise autrefois, ce qui suffisait à figer toute la file
derrière elle, avec un badge qui comptait et un bouton « Envoyer maintenant » qui
n'envoyait rien sans expliquer pourquoi.

Le panneau de synchronisation (badge de la barre supérieure) montre à tout
moment ce qui reste à envoyer, ce que le dernier envoi a fait, et deux choses
qu'il faut lire :

- **Écarts de tarif** — « BQSTY : Plein tarif encaissé 13,00, le tarif dit
  14,00 ». Un prix a bougé dans le back-office pendant que la caisse ne pouvait
  pas l'apprendre. Personne ne peut corriger ça depuis la caisse ; le taire
  serait pire.
- **Entrées contestées** — « Untel est entré hors ligne, mais le billet a été
  refusé à l'envoi : billet inconnu ». Forcé, un scan n'est plus refusé que pour
  ce qu'un passage forcé ne franchit pas. La personne est dans la salle de toute
  façon ; c'est le prix d'un scan hors ligne, et l'organisateur doit le savoir.

### Ce que ça enregistre côté serveur

Une vente rejouée est une vente normale, à trois détails près : la ligne de
journal porte `offline = True`, son `datetime` est **l'heure réelle de la vente**
(pas celle de la reprise), et le paiement de la commande porte cette même heure.
La commande, elle, est bien créée à la reprise — c'est la vérité, et le journal
garde l'autre moitié. Un scan rejoué porte lui aussi son horodatage d'origine,
et la marque hors ligne de pretix.

**Et elle n'est pas refusée parce que le catalogue a bougé.** L'argent est dans
le tiroir et le billet dans une main : refuser à ce moment n'annule pas la vente,
ça la laisse dans un navigateur, hors de pretix *et hors du journal* — c'est-à-dire
exactement là où un journal en ajout seul existe pour qu'elle ne soit pas. Donc
un rejeu est créé avec `force`, et résolu sur tout ce que l'événement connaît
encore plutôt que sur le seul catalogue du jour :

| Ce qui a changé pendant la coupure | Vente en direct | Vente rejouée |
|---|---|---|
| Quota épuisé | refusée (rien n'a été encaissé) | enregistrée |
| Produit retiré du canal Open POS | refusée | enregistrée |
| Déclinaison désactivée | refusée | enregistrée |
| Produit ou déclinaison qui n'a jamais existé | refusée | refusée |
| Tarif modifié | prix serveur appliqué | prix encaissé conservé, écart signalé |

Un survendu reste un survendu : c'est un fait à réconcilier après la soirée, et
`offline = True` est précisément ce qui permet de retrouver ces lignes-là.

### Les limites, dites franchement

- **La file vit sur l'appareil.** Tablette perdue ou effacée avant la reprise,
  ventes perdues. `navigator.storage.persist()` est demandé pour réduire le
  risque d'éviction, mais il n'y a pas de miracle : l'appareil *est* le registre
  tant qu'il n'a pas parlé.
- **Le scan hors ligne ne voit que sa liste embarquée.** Un billet vendu en ligne
  pendant la coupure y est absent : il sera refusé à la porte. Un billet déjà
  scanné à une autre porte pendant la coupure sera accepté ici, et enregistré par
  pretix comme un passage forcé. Et la liste embarquée ne répond **que pour sa
  propre porte** : changer de liste pendant la coupure affiche « pas de liste
  embarquée » plutôt que de faire entrer les invités de l'autre porte.
- **Pas de moteur de règles hors ligne.** Les règles de check-in de pretix
  (horaires, quotas d'entrée) ne s'appliquent pas à un scan hors ligne : la
  personne est entrée sur la réponse du téléphone, et la reprise l'enregistre
  comme un passage forcé. Un billet **bloqué**, ou présenté hors de sa
  **période de validité**, est en revanche refusé hors ligne comme en ligne : la
  liste embarquée le dit, et l'heure est celle du téléphone au moment du scan.
  Avant la 0.18.0, il passait.
- **Pas d'annulation hors ligne.** Un avoir demande le serveur.
- **Un rejeu peut encore être refusé**, mais seulement pour une raison qui ne
  vient pas de la soirée : une file corrompue en stockage (les lignes ne
  totalisent pas ce qui a été encaissé), une vente datée dans le futur, ou une
  vente vieille de plus de sept jours — à ce stade c'est une restauration de
  sauvegarde, pas une coupure réseau. Le refus part alors dans la liste affichée
  jusqu'à ce qu'un humain la traite.

---

## 5quater. Montant libre et consigne

Deux boutons qui n'existent pas tant qu'un produit ne leur est pas affecté dans
*Open POS → Réglages*. Ils apparaissent alors en tête de la grille, avant le
catalogue et hors des onglets : ni l'un ni l'autre n'appartient à une catégorie,
et tous les deux doivent rester à un doigt quel que soit l'onglet ouvert. Ils
sont dessinés en pointillés plutôt qu'en plein, pour qu'une main qui vise une
bière ne tombe pas dessus.

### Le montant libre

Pour ce qui n'a pas de produit : un verre cassé, un don, une assiette à un
stand. Le caissier tape un montant sur le même pavé que l'encaissement — 1-2-3-4
donne 12,34 — et un **motif**, obligatoire. Le bouton *Ajouter au panier* reste
éteint tant qu'il manque l'un des deux.

La ligne va au panier comme une autre, avec le motif pour étiquette : « Divers »
serait le même mot sur toutes et ne répondrait à rien. Deux montants libres font
deux lignes, même au même prix, parce que ce sont deux choses différentes.

Ce que ça produit côté serveur :

- la position de commande est booquée sur le produit désigné, au montant tapé ;
- le **motif est écrit sur la ligne du journal**, donc dans l'export CSV
  (`3× Divers — verre cassé`), qui est le registre qui survit à la commande ;
- il est aussi recopié dans le **commentaire de la commande** pretix, pour être
  lisible depuis le back-office sans ouvrir le journal.

Les garde-fous sont au §6.1. Le seul point de conception à retenir : une
correction d'annulation reprend une ligne de montant libre **telle qu'elle a été
écrite**, prix compris, au lieu de la re-tarifer depuis le catalogue comme les
autres — il n'y a aucun tarif d'où la reprendre, et le prix du produit support
est un zéro de convention.

### La consigne

La consigne **se vend comme n'importe quel produit** : créez « Consigne
gobelet » à 1 €, canal Open POS, un quota, et elle est dans la grille. Rien de
particulier là-dedans.

Le retour, lui, ne peut pas être une ligne de commande pretix : **le total d'une
commande ne peut pas passer sous zéro**, et la file de fin de soirée, ce sont des
gens qui rendent leurs gobelets sans rien acheter. Il est donc enregistré comme
une écriture de journal à part, de type `deposit_refund`, montant négatif,
**sans commande**.

Ce que ça donne pour « quatre bières et je rends trois gobelets » :

| # | Type | Commande | Montant |
|---|---|---|---|
| 41 | `sale` | CMD8K | 12,00 € |
| 42 | `deposit_refund` | — | −3,00 € |

Le client pose 9 €. Le journal garde les deux événements séparés : quatre bières
vendues à 12 €, et 3 € sortis pour des gobelets rendus. Le tiroir reste la somme
pure de la colonne `total` — 12 − 3 = 9 — comme il l'est déjà avec les
annulations. C'est l'invariant sur lequel tout le reste tient.

**La commande pretix, elle, vaut 9 €**, parce que c'est ce qui a été payé pour
elle : les quatre bières restent quatre bières de lignes de commande, à 12 €, et
la consigne rendue est une ligne de frais négative de −3 € à côté — la forme que
pretix utilise lui-même pour une carte cadeau utilisée. La recette du bar n'est
donc pas minorée : les 12 € sont toujours là, en lignes de commande.

C'est un changement par rapport aux versions ≤ 0.11.0, où la commande valait les
12 € des bières. Le compte de pretix était alors gonflé de chaque consigne rendue
— contre le tiroir, et contre SumUp sur un panier carte, puisque le lecteur ne
prélève que le net. Et l'annulation rendait ces 12 € : SumUp ne rembourse que sa
propre transaction, soit 9 €, et la caisse annonçait « déjà remboursé » — le
client repartait avec 3 € de moins que ses gobelets. Maintenant les quatre
chiffres concordent : le lecteur, la commande, l'encaissement et le
remboursement.

Si le panier passe sous zéro, la ligne de frais s'arrête à la vente : une
commande pretix ne peut pas valoir moins que rien. Le reste demeure où vit déjà
un retour sans vente, dans l'écriture de journal, hors de toute commande.

Trois conséquences à connaître :

- **Le rendu de monnaie se calcule sur le net.** Un billet de 10 € contre 9 € à
  payer, pas contre les 12 € que vaut la commande. Se tromper là-dessus rend le
  mauvais montant, devant le client, à chaque fois.
- **Un panier qui passe sous zéro n'encaisse rien.** Le pavé disparaît, le
  panneau affiche *À rendre*, et `cash_given` part à `null` : aucun billet n'a
  traversé le comptoir.
- **Une consigne se rend en espèces, et c'est une contrainte du réseau, pas un
  choix.** Un remboursement carte se fait toujours *contre une transaction
  d'origine* : l'API de SumUp n'a qu'un seul point d'entrée,
  `POST /v1.0/merchants/{code}/payments/{transaction_id}/refunds`, et le montant
  ne peut pas dépasser celui de cette transaction. Il n'existe pas de
  remboursement libre où le client présente sa carte et repart avec 3 €. Or rien
  ne rattache trois gobelets rendus en fin de soirée à la tournée qui les a
  vendus. Le tiroir est donc la seule sortie possible pour un retour de
  consigne. Ce qui se rembourse par API, et très bien, c'est **l'annulation
  d'une vente carte** : la transaction est connue, elle se rembourse totalement
  ou partiellement, sans le TPE et sans la carte du client.
- **Un retour ne s'annule pas depuis la caisse.** Il n'y a pas de commande à
  avoirer. Reprendre la consigne, c'est une consigne vendue, et c'est déjà un
  appui sur la grille.

Deux limites assumées :

- **Rendre une consigne ne remet pas de stock.** Le quota du produit de consigne
  est consommé à la vente et n'est pas rendu au retour : mettez-le en illimité.
- **Annuler une vente mixte contre-passe les deux moitiés.** Le client a posé le
  net sur le comptoir : lui rendre la vente sans reprendre la consigne laisserait
  le tiroir court du montant de la consigne pour le reste de la soirée, un écart
  que personne ne peut expliquer à 1 h 30. L'écriture de contre-passage de la
  consigne dérive sa clé de celle de l'annulation, donc une annulation rejouée ne
  la repasse pas deux fois. Ce que la caisse ne fait pas à votre place : reprendre
  les gobelets, qui sont chez le client.

---

## 5quinquies. Le lecteur de carte SumUp

Une caisse à qui un lecteur est attribué encaisse la carte **sur ce lecteur**,
et le serveur n'enregistre pas une vente carte que le lecteur n'a pas validée.
C'est la règle qui justifie tout le reste de cette section.

Le lecteur retenu est le **SumUp Solo**, piloté par la *Cloud API* de SumUp. Un
lecteur Bluetooth s'appaire avec l'application du fabricant, pas avec une page
web : il ne peut pas être piloté depuis la PWA. La Cloud API, elle, prend une
requête HTTP côté serveur et fait sonner le lecteur. Elle couvre le Solo et le
Go, pas le Solo Lite ; le Solo doit être en firmware 3.3.24.3 ou plus récent.

**Un lecteur piloté par l'API est détaché de l'application SumUp Paiements.**
Il n'y a donc pas de repli sur l'app du téléphone en pleine soirée sans le
réappairer. C'est le seul vrai inconvénient du montage, et il vaut d'être connu
avant la soirée plutôt que pendant.

### Mise en route

1. *Organisateur → Open POS → Lecteurs de carte* : coller le **code marchand**
   (visible dans le tableau de bord SumUp, du genre `MH4H92C7`) et une **clé
   d'API** créée sous *Paramètres → Pour les développeurs → Clés d'API*. La clé
   est stockée sur le serveur, n'est jamais renvoyée dans la page, ne part
   jamais vers une caisse, et n'apparaît pas dans le journal de l'organisateur —
   seul le nom des champs modifiés y est écrit.
2. Sur le lecteur : menu → connecter à une application. Il affiche un **code
   d'appairage**, valable quelques minutes. Le coller dans le formulaire
   *Appairer un lecteur*.
3. SumUp répond avant que le lecteur physique n'ait acquitté, ce qui prend
   quelques secondes : l'écran dit *En attente du lecteur* plutôt que *Appairé*,
   et il suffit de recharger.
4. *Open POS → Appareils de caisse* : donner ce lecteur à la caisse, dans la
   colonne *Lecteur de carte*.

### Le déroulé d'un paiement

Deux temps, et c'est ce découpage qui fait que la carte et la commande ne
peuvent pas diverger.

1. La caisse poste le panier sur `terminal/start`. **Le serveur le tarife, garde
   ce qu'il a tarifé** (`PosTerminalPayment.positions`), et met ce total sur le
   lecteur. Il refuse tout de suite un produit épuisé, un produit qui n'est pas
   en vente au guichet, et un panier qui ne doit rien.
2. La caisse interroge `terminal/status` toutes les deux secondes. Quand SumUp
   dit que l'argent a bougé, la caisse poste la vente sur `checkout/` avec **la
   même clé d'idempotence**. Le serveur retrouve le paiement, vérifie qu'il
   appartient à cet appareil, et construit la commande **depuis le panier
   épinglé** — pas depuis ce que l'app renvoie.

Une modification de tarif entre les deux temps ne change donc rien : la commande
vaut ce que la carte a payé. Une app qui enverrait un panier au lecteur et un
autre au journal fait enregistrer le premier.

### Ce qui n'est jamais cru

Le webhook de SumUp **n'est pas signé**. Sa notification porte un identifiant
d'événement, un identifiant de transaction, un code marchand et un mot du genre
« successful », et rien qui authentifie tout ça. Il est donc traité comme un
coup de coude et rien de plus : il *déclenche* une interrogation de l'API
Transactions, sur une connexion authentifiée, et c'est cette réponse-là qui est
écrite. Un webhook forgé peut, au mieux, faire faire une lecture plus tôt que
prévu.

Il s'ensuit que le webhook est **facultatif** : l'interrogation périodique fait
le même travail, une ou deux secondes plus tard. Une installation que SumUp ne
peut pas joindre — un pretix derrière un VPN, un portable sur le wifi d'une
salle — encaisse exactement pareil. Le serveur ne demande d'ailleurs pas de
`return_url` du tout si `SITE_URL` n'est pas en HTTPS : SumUp refuserait
l'appel, et un encaissement refusé devant un client coûte plus cher qu'une
seconde d'attente.

L'URL de rappel porte un jeton aléatoire par organisateur. Ce n'est pas la
frontière de sécurité — le paragraphe ci-dessus l'est — mais ça évite que la
lecture puisse être déclenchée par quiconque connaît le slug.

### « On n'a pas pu demander » n'est pas « ça a échoué »

C'est la distinction sur laquelle repose tout le reste, et elle est tenue des
deux côtés :

- **Côté serveur**, une erreur SumUp qui vaut la peine d'être retentée — un
  timeout, une coupure, un 5xx — n'écrit rien. Écrire « échoué » perdrait un
  paiement passé pendant qu'un câble était débranché : de l'argent encaissé,
  aucune vente, et rien à montrer.
- **Côté caisse**, perdre le serveur en pleine attente n'affiche jamais un
  refus. Le lecteur répond à SumUp, pas à la tablette : l'écran dit que le
  paiement suit son cours et qu'il ne faut pas l'encaisser une seconde fois.
  Seul le serveur met fin à l'attente.

Quitter un paiement en cours demande deux appuis : un pour retirer le panier du
lecteur, un pour revenir. Et ce que répond l'annulation, c'est ce qui s'est
réellement passé — une carte présentée dans la même seconde est un paiement, et
la caisse est prévenue plutôt que de laisser partir un client qui a payé.

### Un paiement que personne ne paie

L'API Transactions n'a rien tant qu'aucune carte n'a été présentée. Seule, elle
ne distingue pas « le client cherche sa carte » de « le caissier a appuyé sur
*Arrêter* » ou « le client est reparti ». Le serveur garde donc aussi
l'identifiant de la **demande** posée sur le lecteur (`checkout_id`, dans la
réponse de SumUp au lancement) et, tant qu'il n'existe pas de transaction, il
demande à SumUp où en est cette demande
(`GET /v0.1/merchants/{m}/readers/{r}/checkout/{checkout_id}`) :

- **échouée** ou **annulée** — l'interruption a atteint le lecteur, ou la
  demande a expiré sans personne devant — clôt le paiement tout de suite. La
  caisse peut passer en espèces, et un lecteur partagé se libère pour l'autre
  caisse sans attendre les cinq minutes ;
- **réussie** attend la transaction, qui porte l'identifiant dont un
  remboursement aura besoin ;
- **en attente**, ou pas de réponse, ne change rien.

La transaction reste interrogée la première et reste celle qui fait foi : une
carte présentée au dernier moment est un paiement, quoi que dise la demande. Un
paiement lancé avant la 0.17.0 n'a pas d'identifiant de demande et se règle
comme avant, par la seule API Transactions.

### Quand le lecteur refuse la demande

SumUp refuse de poser un montant sur un lecteur **hors ligne** (éteint, ou hors
de portée du wifi) et sur un lecteur **encore occupé** : il garde chaque lecteur
une minute après chaque demande acceptée, carte présentée ou non, si bien qu'un
paiement arrêté puis relancé aussitôt est refusé. La caisse le dit en ces
termes — « Le lecteur de carte est hors ligne. Vérifiez qu'il est allumé et
connecté, puis réessayez », « Le lecteur de carte traite encore la demande
précédente. Réessayez dans une minute » — et non plus par un « SumUp a refusé
cette demande » qui ne disait rien à personne. Rien n'a été posé sur le
lecteur : le paiement est clos, *Réessayer* repart d'une clé neuve, et les
espèces restent possibles.

### Ce que le lecteur ne fait pas

- **Un panier qui rend de l'argent.** SumUp ne rembourse que contre une
  transaction d'origine (voir §5quater) : il n'y a aucun moyen d'envoyer de
  l'argent vers une carte que rien ne justifie. Le retour de consigne se rend en
  espèces, et la caisse le dit avant de demander une carte au client.
- **Un panier réglé sur un avoir.** Le lecteur encaisserait le panier entier
  alors que la caisse détient déjà l'argent du client. En espèces, les deux
  moitiés se règlent d'un seul geste. C'est refusé, avec le motif à l'écran.
- **Une vente rejouée depuis la file hors ligne.** Un paiement lecteur passe par
  le cloud de SumUp : une caisse sans réseau n'a pas pu en démarrer un.

### Annuler une vente carte

C'est le cas où le remboursement s'automatise entièrement. La transaction est
connue, donc `cancel/` la rembourse **en totalité, par API, sans le lecteur et
sans la carte du client**, et répond ce qu'il en est :

| `card_refund` | Ce que ça veut dire | Ce que la caisse affiche |
|---|---|---|
| `none` | Espèces, ou carte prise sur le téléphone de quelqu'un | Le montant à rendre, comme avant |
| `done` | SumUp a accepté le remboursement | *Déjà remboursé sur la carte du client*, rien à rendre |
| `already` | C'était déjà fait | Idem |
| `failed` | **L'argent est toujours sur la carte du client** | Un bandeau rouge, et quoi faire : rembourser depuis l'app SumUp |

Une correction de commande après une annulation carte ne porte donc **pas
d'avoir** : l'argent est reparti. Le panier corrigé s'encaisse en entier.

Un remboursement refusé se relance depuis pretix : *Créer un remboursement* sur
la commande propose la carte, et SumUp est redemandé (§5bis, *Une vente annulée
depuis pretix*). Une fois passé, la vente quitte la liste des remboursements
refusés de la page Ventes ; le remboursement échoué reste dans l'historique de
la commande, comme pretix le garde.

**Pourquoi SumUp refuse.** Le tableau de bord SumUp refuse le même
remboursement sans dire pourquoi. Depuis la 0.22.1, le plugin garde la réponse
de SumUp sur le remboursement échoué : son statut HTTP et ses propres mots,
`409 · The transaction is not refundable in its current state` par exemple,
jamais la clé d'API. Elle s'affiche sous le remboursement sur la page de
commande, dans la colonne *Réponse de SumUp* de la page Ventes, et à la suite
du message dans la fenêtre de remboursement de pretix. La caisse, elle, garde
son bandeau : ce qu'il y a à faire ne dépend pas du motif.

La demande de remboursement total porte un corps JSON vide, `{}`, comme le
client officiel de SumUp (`sumup-go`) l'envoie ; jusqu'à la 0.22.0 elle n'en
portait aucun.

SumUp répond `201` à un remboursement qu'il accepte. Jusqu'à la 0.17.0, le
plugin n'attendait que `200` ou `204` et annonçait donc `failed` pour un
remboursement passé : le bandeau rouge envoyait rembourser une seconde fois
depuis l'app SumUp un client déjà remboursé.

Dans l'historique de la commande, le remboursement apparaît comme pretix
l'écrit lui-même : *créé*, puis *effectué* ou *échoué*.

Si la connexion meurt entre l'annulation et le remboursement, la caisse
réessaie avec la même clé : le serveur lui rend l'annulation telle quelle *et*
finit le remboursement, ou répond qu'il était déjà fait. Rien d'autre ne
repasserait derrière.

### Deux caisses sur un seul lecteur

Un bar avec deux tablettes et une seule machine entre elles, c'est un comptoir
réel, et c'est autorisé : donner le même lecteur à deux caisses ne déclenche
plus de refus dans le back-office. Les deux lignes affichent alors *Partagé avec
une autre caisse*, pour que ce soit un choix visible.

Elles se relaient, et c'est le **serveur** qui arbitre, pas l'application. Tant
qu'une caisse a un panier sur le lecteur, l'autre est refusée sur la carte avec
son panier intact — rien d'écrit, aucune clé d'idempotence consommée — et elle
voit « Le lecteur encaisse sur l'autre caisse. Attendez la fin, ou prenez cette
vente en espèces. » Presser *Carte* une minute plus tard est un premier essai
propre, pas une reprise.

SumUp refuse déjà le second encaissement de son côté, mais trop tard : au moment
de l'appel, le serveur a écrit une ligne de paiement et brûlé la clé de la caisse
sur un panier qu'aucun porteur de carte n'a jamais vu. D'où l'arbitrage avant.

Deux détails qui comptent :

- Le serveur ne se fie pas à sa propre ligne « en attente ». Elle dit *en
  attente* parce que personne n'a regardé depuis, ce qui n'est pas la même chose
  qu'un client encore devant la machine : il demande d'abord à SumUp ce qu'est
  devenu ce paiement. C'est exactement l'appel que fait l'autre caisse en
  interrogeant.
- Un paiement que SumUp dit arrêté ou expiré libère le lecteur aussitôt (voir
  *Un paiement que personne ne paie*). Un paiement auquel personne n'a jamais
  répondu, et que SumUp dit encore en attente, cesse de tenir le lecteur au
  bout de **cinq minutes**, et l'écran de la machine est effacé avant d'y
  remettre un panier. Une tablette tombée en rade avec une invite affichée aurait
  sinon coupé la carte pour le reste de la soirée, sans que personne puisse dire
  pourquoi. La ligne orpheline, elle, reste ouverte et remonte dans *Ventes →
  Paiements carte sans vente* plutôt que d'être classée au jugé.

### Ce que le lecteur dit de lui-même

L'écran *Lecteurs de carte* interroge chaque lecteur appairé : joignable ou non,
au repos, en train de prendre une carte ou **en train de se mettre à jour** (il
ne prend aucun paiement avant d'avoir fini, et un lecteur SumUp se met à jour de
lui-même à l'allumage), batterie, type de connexion, version de firmware.
C'est la question qu'on se pose vraiment avant d'ouvrir une porte — l'appairage
ne répond ni à « est-ce qu'il est allumé » ni à « est-ce qu'il est chargé ».
Jusqu'à la 0.17.0, cette colonne affichait *Inconnu* pour tous les lecteurs :
SumUp range l'état sous `data`, et le plugin le cherchait à la racine.

Un lecteur qui ne peut pas répondre s'affiche **Inconnu**, jamais *Hors ligne* :
la route d'état demande un firmware 3.3.39.0 sur un Solo là où encaisser demande
3.3.24.3, donc un lecteur entre les deux fonctionne parfaitement et n'a rien à
dire. Envoyer quelqu'un chercher une machine qui est là, en train de marcher,
serait la pire des deux erreurs. L'appel est borné à cinq secondes pour la même
raison : ne pas savoir, vite, est la réponse la plus utile pendant qu'une page
se charge.

Un lecteur bloqué en attente de carte reçoit un bouton **Effacer son écran**,
qui termine l'encaissement resté dessus. Tant qu'il n'est pas effacé, le lecteur
refuse le paiement suivant comme occupé, ce qui se lit à la porte comme « le
terminal est cassé ». Ce bouton ne touche pas à la ligne de paiement :
l'interruption est au mieux tentée, SumUp ne confirme rien, et il est donc
incapable de dire si la carte avait déjà été débitée. Seule la transaction SumUp
le dit, et c'est ce que demande le règlement du paiement.

### Quand le lecteur disparaît

Un lecteur désappairé depuis le tableau de bord SumUp laisse une caisse qui
pointe sur un lecteur inconnu, et cette caisse refuse alors tout paiement carte
sans que le caissier puisse comprendre pourquoi. Les deux écrans le disent :
celui des lecteurs liste les caisses concernées, celui des appareils affiche
*inconnu de SumUp* sur la ligne. Retirer un lecteur depuis Open POS, à
l'inverse, le retire aussi de la caisse à qui il était donné — cette caisse
repart en carte déclarée, elle ne s'arrête pas de vendre.

Et si SumUp est injoignable, aucun des deux écrans ne se ferme : l'erreur
s'affiche au-dessus du tableau, les rôles restent modifiables, et un lecteur
déjà attribué reste attribué.

---

## 5sexies. Ce qui se lit et ce qui s'entend

Cette section décrit des choix d'écran. Ils n'ont pas de réglage au
back-office et ne changent rien à ce qui est enregistré ; ils existent parce
qu'une caisse se tient à bout de bras, dans une salle sombre et bruyante, par
quelqu'un à qui on parle pendant qu'il tape.

### La grille

Le premier onglet, **Tout**, remet le catalogue entier. Les autres sont les
catégories de l'événement, dans l'ordre de pretix.

**Un produit épuisé passe à la fin de sa catégorie**, pas dehors. Grisé,
toujours là : la caisse doit pouvoir dire que la buvette en vend et qu'il n'y
en a plus, sans que le pouce le rencontre en premier.

**Les photos de produits** que pretix connaît déjà (*Produits → un produit →
Image*) s'affichent en bord droit de la case, en fondu vers le fond. La case
garde exactement la hauteur qu'elle aurait sans : une grille qui grandit d'un
tiers pour porter des photos est une grille qu'il faut faire défiler un soir de
rush. Sans image, rien ne change. Ces fichiers sont gardés par le service
worker dans un cache à part, pour qu'ils ne disparaissent pas au premier trou
de réseau et qu'un déploiement ne les fasse pas retélécharger.

### Le panier

Le nombre affiché sur une ligne est un bouton. Il ouvre **Combien ?**, douze
quantités : un appui suffit, sans validation. *Retirer* vide la ligne. Le
`−` / `+` reste là pour tout le reste, et la quantité proposée s'arrête à ce
que le quota permet.

### Le son

Trois sons, synthétisés par l'app — rien n'est téléchargé, une caisse hors
réseau les fait quand même :

| Quand | Ce qu'on entend |
|---|---|
| un produit entre dans le panier | un clic court |
| un billet passe à la porte | une note brève |
| un billet est refusé | deux notes descendantes |

Cela se coupe dans *Réglages → Son*, et c'est activé par défaut.

**Pourquoi c'est là :** un navigateur sur iPhone ou iPad **ne peut pas faire
vibrer l'appareil**. Aucune version d'iOS ne l'a jamais permis. À une porte
tenue au téléphone, un refus n'était donc annoncé que par un écran rouge, au
moment précis où le bénévole regarde la personne et pas l'écran. Sur Android la
vibration existe et continue de marcher ; le son vient en plus.

**Et le bouton silence :** sur iOS, le son d'une page web obéit à l'interrupteur
physique de sonnerie, alors qu'une vidéo ne lui obéit pas. Depuis iOS 17, une
page peut réclamer la session audio dite *playback* et sortir de cette règle,
ce que l'app fait au premier appui. Autrement dit : **la caisse sonne même si le
téléphone est en silencieux**, ce qui est le comportement voulu à une porte, et
ce qui rend l'interrupteur des réglages nécessaire.

Sur un iPhone antérieur à iOS 17, le son se tait quand le téléphone est en
silencieux ; il n'y a pas de contournement propre, et le seul remède est de
sortir le téléphone du silencieux.

### Le contraste

Les deux palettes visent le niveau AA de WCAG pour tout texte à l'écran, et ce
n'est pas décoratif : la personne qui lit est en train de rendre la monnaie. Un
script du harness (`node harness/audit.mjs`) parcourt dix écrans dans les deux
palettes, compose les fonds translucides et échoue s'il trouve un texte
au-dessous du seuil ou une cible tactile sous 44 px. Il tourne contre le serveur
de développement, pas en CI — §9.

Deux conséquences visibles : le bleu des boutons pleins est plus sombre que
celui qui sert d'encre, et **une vente annulée est barrée dans le journal**.
Elle affichait son montant comme n'importe quelle vente, avec un discret
« annulée » en gris ; la colonne se lisait alors comme une recette qui n'a
jamais eu lieu, devant la personne qui compte la caisse à deux heures du matin.

---

## 5septies. La caisse espèces

[drawers.py](../pretix_openpos/drawers.py) pour les règles,
[drawer_views.py](../pretix_openpos/drawer_views.py) pour le back-office,
[DrawerPanel.tsx](../frontend/src/components/DrawerPanel.tsx) pour la caisse.

Une **caisse espèces** est un tiroir réel : l'argent liquide d'un comptoir, et
le journal de ce qui lui est arrivé. On en crée autant qu'il y a de tiroirs, au
niveau de l'organisateur, et chaque appareil qui encaisse des espèces est
rattaché à l'un d'eux. Deux tablettes au même bar partagent le même tiroir ; la
porte a le sien, ou n'en a pas.

Pour un tiroir, une soirée est une **ouverture** : le fond de caisse compté en
début de soirée, les ventes en espèces qui s'y ajoutent, l'argent apporté ou
retiré en cours de route, un comptage à la fin, et la fermeture sur ce
comptage. L'écart entre ce qui a été compté et ce que le tiroir aurait dû
contenir est le chiffre sur lequel la soirée se juge. Un tiroir n'a qu'une
ouverture à la fois, et la base de données le garantit même si deux tablettes
appuient sur *Ouvrir* à la même seconde.

### Mise en route

1. *Open POS → Caisses espèces* : créer un tiroir par tiroir réel — « Bar »,
   « Porte » — avec son **fond de caisse habituel**. Ce montant n'est qu'une
   proposition faite sur la caisse au moment d'ouvrir : ce qui est compté ce
   soir-là fait foi.
2. *Open POS → Appareils de caisse* : dans la colonne **Caisse espèces**, donner
   à chaque appareil son tiroir. Plusieurs appareils peuvent partager un tiroir.
   Un appareil sans tiroir encaisse les espèces exactement comme avant : rien
   ne change tant que personne n'a rien choisi.

Un tiroir déjà ouvert une fois ne se supprime plus : son journal et les ventes
rattachées à ses ouvertures font partie des comptes. On l'**archive** à la
place, depuis sa propre page (bouton 🗄 de la liste) : il sort de la liste et
n'est plus proposé aux appareils, ses soirées restent consultables, et
*Réactiver* le ramène. Un tiroir ouvert ne s'archive pas ; les appareils qui lui
étaient rattachés le perdent, et encaissent les espèces sans tiroir jusqu'à ce
qu'on leur en donne un autre — la page le dit avant de confirmer. Le nom d'un
tiroir archivé reste pris : le réactiver, ou le renommer d'abord. Créer,
renommer, supprimer, archiver, réactiver, rattacher un appareil et fermer depuis
le back-office s'écrivent dans l'historique de l'organisateur.

### Sur la caisse

Un appareil rattaché à un tiroir a un bouton billet (💶) dans la barre du haut.
Tant que le tiroir n'est pas ouvert, ce bouton est signalé, un bandeau « La
caisse Bar est fermée : ouvrez-la avant d'encaisser des espèces » reste affiché,
et le panneau de la caisse s'ouvre tout seul au lancement de l'app — une fois,
et jamais par-dessus un client en cours.

- **Ouvrir la caisse** : compter le fond, billet par billet ou en tapant le
  total. *Billets et pièces* liste les coupures de la devise, avec un − et un +
  par ligne et un champ où taper directement un tas de pièces ; *Montant total*
  est un clavier qui propose le fond habituel en un geste. Le serveur vérifie un
  comptage par coupures : elles doivent exister dans la devise (euro, franc
  suisse, livre, dollars américain et canadien), et leur somme égaler le
  montant. Une autre devise se compte en tapant le total.
- **Entrée d'argent** et **Sortie d'argent** : un montant et un motif,
  obligatoire — « apport de monnaie », « enveloppe au trésorier ». Un retrait
  sans motif est la première ligne qu'on interroge dans un contrôle, et la
  dernière dont quelqu'un se souvient.
- **Doit contenir** : tant que le tiroir est ouvert, le panneau montre ce qu'il
  doit contenir, recalculé par le serveur à chaque ouverture du panneau — le
  fond, les ventes en espèces, ce qui a été rendu (annulations, consignes), les
  entrées et les sorties d'argent, puis leur somme. Les lignes encore à zéro
  sont omises, sauf les ventes.
- **Compter la caisse** : compter ce qu'il y a dans le tiroir. Une fois le
  compte enregistré, l'app le met en face de l'attendu, avec l'écart et son
  verdict (« La caisse est juste », « Il manque 5,00 € »). Recompter est
  toujours possible, et chaque comptage est gardé : le premier chiffre auquel
  quelqu'un est arrivé fait partie de la soirée autant que celui sur lequel elle
  a fermé.
- **Fermer la caisse** : sur le dernier comptage, s'il est encore à jour. Une
  vente passée sur l'autre tablette pendant le comptage le rend périmé, et
  l'app demande de recompter plutôt que de fermer sur un chiffre qui n'a pas vu
  cette vente. Une note peut accompagner la fermeture.

Le résumé de la fermeture reste affiché dans le panneau jusqu'à l'ouverture
suivante : c'est le reçu de la soirée.

Jusqu'en 0.21.0, le comptage était à l'aveugle : l'attendu n'apparaissait
qu'une fois le compte enregistré. L'organisateur a demandé, en ouvrant sa
caisse sur 150 € et en vendant en espèces, de voir le montant du moment ; il
est affiché depuis 0.21.1. *Réglages* montre par ailleurs la recette de
l'événement, qui est autre chose : ce que l'événement a vendu, sans le fond ni
les entrées et sorties d'argent.

### Ce que le serveur refuse, et ce qu'il ne refuse jamais

- Une **vente en espèces** sur un appareil dont le tiroir est fermé est refusée
  avant que quoi que ce soit ne soit écrit (`drawer_closed`). Le panneau de
  paiement le dit dès qu'on choisit *Espèces*, avec un bouton qui ouvre le
  tiroir ; le client est encore devant le comptoir quand on revient au clavier.
  Une **consigne rendue** et l'**annulation** d'une vente en espèces sortent de
  l'argent du tiroir, et demandent donc le même tiroir ouvert.
- Un tiroir **ouvert un jour précédent** et jamais fermé est refusé de la même
  façon (`drawer_stale`) : l'argent qu'il contenait est parti depuis chez qui
  tient les comptes, et le fond de ce soir n'y a jamais été compté. La caisse
  propose de le **fermer sans compter**, puis d'ouvrir celui du soir. La
  journée de caisse commence à 6 h, comme le relevé : une soirée qui passe
  minuit reste une seule ouverture.
- Une **vente carte** n'est jamais refusée : son argent ne passe pas par le
  tiroir. Elle est rattachée à l'ouverture du soir, pour le rapport.
- Une vente **rejouée depuis la file hors ligne** n'est jamais refusée non plus :
  le client a payé. Elle est rattachée à l'ouverture qui tournait au moment où
  elle a été encaissée, même si ce tiroir a été fermé depuis ; en espèces, le
  rapport de cette soirée signale qu'elle est arrivée après le comptage. Hors
  ligne, l'app ne bloque donc pas les espèces : elle ne sait plus où en est le
  tiroir, et le serveur prendra la vente quoi qu'il arrive.

Une vente annulée depuis le back-office de pretix (§5bis) n'est rattachée à
aucun tiroir : personne n'y dit quelle caisse a rendu l'argent. Si le
remboursement sort d'un tiroir, l'inscrire en **sortie d'argent** sur la
caisse, avec le numéro de la commande en motif.

Deux tablettes sur un même tiroir passent chacune leur tour : toute écriture
dans le journal d'un tiroir verrouille sa ligne, et une vente en train de
s'écrire se termine avant qu'un comptage ou une fermeture ne fasse ses calculs.

### Ce que le tiroir devrait contenir

Jamais stocké, recalculé à chaque fois :

```
  fond de caisse
+ ventes en espèces
− annulations en espèces et consignes rendues
+ entrées d'argent
− sorties d'argent
```

Les ventes viennent du journal des ventes, où chacune porte son ouverture ; le
reste vient du journal du tiroir. Un total courant stocké serait un troisième
registre, et le premier à se tromper. Les ventes en mode test en sont exclues
et comptées à part, comme partout (§6.5).

### Dans le back-office

*Open POS → Caisses espèces* liste les tiroirs, leurs appareils, l'ouverture en
cours avec ce que le tiroir **doit contenir** à cet instant, et la dernière
soirée fermée avec son écart ; les tiroirs archivés suivent, à part. Chaque
tiroir a son historique, soirée par soirée — l'ouverture en cours avec son
attendu du moment —, avec l'état de sa chaîne d'intégrité et un **Export CSV** :
une ligne par ouverture, recalculée plutôt que recopiée, pour qu'un export fait
le lendemain compte la vente rejouée le matin.

Chaque soirée a son **rapport de fermeture** : le fond, les ventes, les
annulations, les consignes rendues, les entrées et sorties, l'attendu, le
compté, l'écart, la carte à part, la recette par appareil et par caissier, les
événements dont les ventes y sont entrées, et chaque ligne du journal du tiroir,
premier comptage compris. Une vente arrivée après la fermeture y est signalée,
avec l'écart recalculé.

Une ouverture qu'une caisse a oublié de fermer se ferme depuis ce rapport, avec
le montant si quelqu'un a compté le tiroir, sans sinon. Le journal dit que la
fermeture vient du back-office, et de qui.

Créer, renommer, supprimer, archiver, réactiver et fermer demandent la permission des appareils
(`organizer.devices:write`). Lire les rapports est ouvert en plus à qui peut
lire les commandes de **tous** les événements de l'organisateur : une ouverture
mélange les ventes de tous les événements pour lesquels ses caisses ont vendu.

### Le journal du tiroir

`PosDrawerEntry` enregistre l'ouverture, les entrées, les sorties, chaque
comptage et la fermeture. En ajout seul, et chaîné par tiroir comme le journal
des ventes l'est par événement (§6.4) : un fond de caisse rabaissé après coup
ou un retrait qui disparaît, c'est exactement ce qu'un contrôle de caisse
cherche. Chaque ligne porte le montant, l'attendu au moment d'un comptage ou
d'une fermeture, les coupures comptées, le motif, qui l'a fait, depuis quel
appareil ou depuis le back-office, et une clé d'idempotence : une ouverture
renvoyée après une coupure réseau revient comme l'originale, sans ouvrir deux
fois.

---

## 6. Les garde-fous

### 6.1 Le serveur est seul maître des prix

`CheckoutSerializer` n'accepte **pas** de champ prix
([api/serializers.py](../pretix_openpos/api/serializers.py)). Une app trafiquée ou
simplement périmée ne peut pas vendre un billet à 40 € pour 4 €.

Deux exceptions, et elles sont étroites :

- **Une vente rejouée hors ligne** porte ses prix, parce que le client a déjà
  payé et que le serveur n'a plus à décider, seulement à constater (§5ter).
- **Une ligne de montant libre** porte le sien, parce que c'est toute la
  fonction. Elle n'est acceptée que sur le produit unique désigné dans les
  réglages, seulement accompagnée d'un motif, et seulement au-dessus de zéro ;
  sur n'importe quel autre produit c'est un 400 (§5quater). Une caisse
  compromise ne peut donc rien vendre d'autre que ce produit-là, et jamais un
  billet à 10 centimes avec une note explicative.

Le retour de consigne, lui, n'en est pas une : la caisse dit qu'une ligne est un
retour, le serveur en tire le prix du produit et le passe en négatif.

### 6.2 …mais il ne peut pas facturer autre chose que ce qui a été annoncé

Corollaire du point précédent : le serveur pourrait silencieusement encaisser un
montant différent de celui que l'opérateur vient d'énoncer, après une
modification de prix dans le back-office. D'où `expected_total` : la caisse dit
ce qu'elle a affiché, et un écart devient un **refus avant tout mouvement
d'argent**. L'app recharge alors le catalogue, re-tarife le panier sur place, et
le panneau de paiement reste ouvert avec le nouveau montant.

Le catalogue se rafraîchit d'ailleurs tout seul **toutes les 60 s et au retour au
premier plan** — mais uniquement quand la caisse est au repos (panier vide, pas de
paiement en cours, pas d'écran de fin ni de scan). Recharger les prix sous un
panier qu'on est en train de lire à un client, c'est exactement comme ça qu'on
annonce un montant et qu'on en encaisse un autre.

### 6.2bis Les séries : la caisse vend la date du soir

Un événement pretix peut être une **série** : une même configuration, plusieurs
dates, chacune avec son quota et éventuellement son prix. pretix refuse toute
ligne de commande qui ne nomme pas une date — et la caisse n'en envoyait aucune.
Le catalogue se chargeait proprement, en affichant cent places restantes, et la
première vente revenait en « Le produit “Entrée” n'est pas rattaché à un
quota », au moment du paiement, devant le client. Le message désigne la mauvaise
cause : le produit est bien rattaché à un quota, mais pas à une date.

La caisse n'envoie toujours pas de date. Elle n'envoie pas de prix non plus, et
pour la même raison : la personne qui tient la caisse a une file devant elle et
n'a pas à choisir l'un ou l'autre dans une liste entre deux clients. Le serveur
décide, à l'horloge :

- La date **déjà commencée et pas terminée** l'emporte — c'est celle pour
  laquelle la file est là. Si deux se chevauchent, la plus récemment commencée.
- Sinon la **prochaine de la soirée** : une porte vend avant d'ouvrir.
- « La soirée » est la journée de caisse habituelle, six heures du matin à six
  heures le lendemain. Une porte qui vend encore à une heure vend pour la
  soirée en cours, pas pour la suivante. Une date sans heure de fin — le cas le
  plus courant — court jusqu'à la fin de sa propre nuit, pas jusqu'à l'instant
  où elle commence.
- **Rien de programmé** : la caisse le dit au catalogue, à l'installation, et
  refuse de s'ouvrir sur son cache. Vendre depuis le catalogue de la semaine
  dernière ramènerait exactement le bug d'origine, découvert au paiement.

Deux exceptions, toutes deux du côté de l'argent déjà encaissé. Une vente
**rejouée** est rattachée à la soirée où elle a été encaissée, pas à celle où
elle arrive : une caisse coupée rend ses ventes quand elle retrouve le réseau,
ce qui peut être le lendemain matin. Et une vente déjà payée n'est **jamais**
refusée faute de date : refuser ne rend pas l'argent, ça ne fait qu'échouer la
vente hors de pretix. La date la plus proche est utilisée — c'est une
approximation, et une approximation qu'on peut corriger vaut mieux qu'une vente
introuvable.

L'ordre de résolution est celui de pretix, sans rien par-dessus : prix de la
date, puis prix de la variante, puis prix du produit. Une série tarifée soirée
par soirée est donc vendue au prix de la soirée en cours, à la caisse comme dans
la boutique. La date vendue est écrite sur chaque ligne du journal, avec son nom
du moment.

### 6.3 L'idempotence

La clé est frappée à l'ouverture du panneau de paiement et réutilisée pour chaque
tentative. Elle est unique par événement en base. Un réseau capricieux ou un
double appui ne peuvent donc pas vendre deux fois les mêmes billets : la seconde
requête retrouve la vente et renvoie la commande d'origine avec `replayed: true`.

C'est la façon la plus courante pour une caisse maison de perdre de l'argent.

La même clé couvre le paiement sur le lecteur, et c'est encore plus nécessaire
là : le *reader checkout* de SumUp n'a aucune idempotence à lui, donc un
deuxième appel démarre un deuxième paiement. `terminal/start` retrouve le
paiement en cours au lieu de solliciter le lecteur une seconde fois. Une
tentative refusée, en revanche, se rejoue sous une **clé neuve** : la clé
dépensée porte le refus, et la réutiliser ne ferait que le retrouver.

### 6.3bis Le panier épinglé

Le serveur tarife le panier au moment où il le met sur le lecteur, et garde ce
qu'il a tarifé. La commande est construite depuis cette copie, pas depuis ce que
l'app renvoie ensuite. C'est ce qui rend impossible qu'une carte paie un montant
et qu'une commande en dise un autre — par un tarif modifié entre les deux, ou
par une app qui enverrait deux paniers différents.

Le contrôle `expected_total` du §6.2 ne s'applique d'ailleurs pas à ces
ventes-là : les deux montants sont le même par construction, et refuser laisserait
une carte débitée sans commande derrière — ce qui coûte plus cher qu'un chiffre
qui ne correspond pas.

### 6.4 Le journal chaîné

Chaque ligne stocke le hash de la précédente. Modifier une vente ancienne
invalide le hash de toutes les suivantes, et `PosSale.verify_chain()` désigne la
première ligne qui ne tombe plus juste. Le résultat est affiché en haut de
l'écran *Ventes* : une chaîne cassée est visible, pas silencieusement acceptée.

Le hash porte sur : `seq`, événement, date, série du device, caissier, code de
commande, type de paiement, total, reçu, rendu, positions, hash précédent — puis,
par version : `testmode` (v2), `kind`, `cancels_seq` et `reason` (v3, tout ce qui
distingue un contre-passage d'une vente), `offline` (v4), `drawer_session` (v5,
l'ouverture de caisse où l'argent est entré). `device_name` n'est
**pas** haché : c'est la série qui identifie une caisse, le nom n'est qu'un
libellé de rapport.

**Pourquoi `hash_version`.** Une chaîne de hachage ne s'étend pas sur place :
ajouter un champ à la charge hachée invaliderait toutes les lignes écrites avant,
et `verify_chain()` signalerait une falsification sur un journal intact. La charge
est donc versionnée, chaque ligne mémorise sa version, et la vérification rejoue
la forme sous laquelle la ligne a réellement été hachée.

**Deux vérifications, et elles ne disent pas la même chose.** L'écran *Ventes*
repart du dernier point vérifié, gardé en cache, pour ne pas re-hacher tout un
festival à chaque ouverture de page : il répond donc à « le journal a-t-il tenu
depuis la dernière fois qu'on l'a regardé ? ». Ce qui est *derrière* ce point
n'est pas réexaminé, et un point de reprise qui ne correspond plus n'est pas
traité comme une falsification — un cache s'évince au redémarrage, et une alarme
qui sonne à chaque retour de Redis est une alarme que plus personne n'écoute.
L'audit qui ne rate rien est le parcours complet depuis la première ligne :

```bash
python -m pretix openpos_verify_journal              # tous les événements, et tous les tiroirs
python -m pretix openpos_verify_journal --event org/slug
```

C'est celui à mettre dans un cron, et celui à lancer le jour où quelqu'un doute
du journal. Sans `--event`, il parcourt aussi le journal de chaque caisse
espèces (§5septies), chaîné de la même façon, par tiroir ; la page d'un tiroir,
elle, le vérifie en entier à chaque affichage, puisqu'il ne compte que quelques
lignes par soirée.

### 6.5 Le mode test ne se mélange pas à la recette

`testmode` est enregistré **au moment de l'écriture**, pas lu depuis la commande —
parce que c'est précisément la commande qui disparaît : désactiver le mode test
propose de supprimer toutes les commandes de test, ce qui laisserait la ligne de
journal orpheline. Déduire « orpheline = test » après coup ferait silencieusement
sortir des recettes une vraie commande supprimée à la main, soit exactement ce
qu'un journal en ajout seul existe pour empêcher.

Conséquence : les ventes de test restent dans le journal, sont **exclues** de
la recette sur laquelle on compte le tiroir, et sont affichées sur une ligne à
part.

### 6.6 La surface d'attaque du token

Voir §2.3. En complément : le token est dans `localStorage`, l'app se dépaire
depuis *Réglages* (bouton rouge, avec la série affichée), et le device se révoque
côté organisateur — la tablette affiche alors le refus au prochain chargement,
avec *Dépairer* à portée de main ; elle ne s'efface jamais toute seule (§4.1).

---

## 7. Au quotidien

### 7.0 Avant la soirée

Une liste courte, à faire la veille ou l'après-midi même, dans cet ordre. Chaque
ligne est là parce que son absence coûte cher une fois la porte ouverte.

**Les tablettes**

1. Chaque tablette est **chargée**, et branchée si la soirée dépasse quatre
   heures. Une caisse qui s'éteint emporte sa file d'attente hors ligne.
2. Chaque tablette ouvre la caisse **depuis l'écran d'accueil**, pas depuis un
   onglet. L'app refuse de vendre dans un onglet ; c'est délibéré, une barre
   d'adresse au-dessus du panier et un geste de rafraîchissement en travers,
   c'est une vente perdue.
3. Le **nom du caissier** est renseigné dans les réglages de chaque tablette. Il
   part avec chaque vente et c'est ce qui rend la recette ventilable en fin de
   soirée.
4. Le **rôle** de chaque appareil est le bon dans *Open POS → Appareils de
   caisse* : caisse pour le bar, porte pour l'entrée. Un appareil sans rôle fait
   les deux, ce qui convient à une petite soirée et pas à un bar qui bouscule.
5. Faire **une vente en mode test** sur chaque tablette, puis l'annuler. C'est
   le seul moyen de savoir que le token est encore valide, que l'événement est
   joignable et que l'écran répond. Le mode test ne se mélange pas à la recette.

**Le lecteur de carte**

6. *Open POS → Lecteurs de carte* : le lecteur est **Appairé** et, dans la
   colonne *En ce moment*, **Prêt**. « Inconnu » veut dire que le lecteur est
   trop ancien pour répondre à cette question et non qu'il est éteint ; « Hors
   ligne » veut dire qu'il l'est vraiment ; « Mise à jour en cours » veut dire
   attendre qu'il ait fini.
7. La **batterie** affichée est suffisante, ou le lecteur est sur son socle.
8. Si un lecteur affiche **Encaissement en cours** alors que personne
   n'encaisse, presser **Effacer son écran** : il reste bloqué d'une soirée à
   l'autre sinon, et refuse le premier paiement de la vôtre.
9. Faire **un aller-retour à un euro** : une vente carte, puis son annulation.
   C'est le seul test qui prouve la chaîne entière, du panier jusqu'au
   remboursement.

**Le serveur**

10. *Open POS → Ventes* : la chaîne du journal ne signale rien, et la section
    **Paiements carte sans vente** est vide. Si elle ne l'est pas, régler ces
    lignes avant d'en ajouter de nouvelles.
11. Les **prix des produits** dans pretix sont ceux de ce soir. Un prix modifié
    pendant une vente est géré, mais c'est une seconde de flottement devant un
    client.

**Les caisses espèces**

12. *Open POS → Caisses espèces* : aucun tiroir n'est resté ouvert depuis une
    soirée précédente. S'il y en a un, le fermer depuis son rapport, avec le
    montant si quelqu'un a compté le tiroir, sans sinon — ou le laisser faire à
    la caisse, qui le proposera.
13. Juste avant l'ouverture des portes, sur un appareil de chaque tiroir :
    compter le fond et **ouvrir la caisse**. Une fois par tiroir ; les autres
    appareils du même tiroir le voient ouvert dans la minute, ou dès qu'on
    touche leur bandeau.

### 7.0bis Si SumUp tombe en pleine soirée

Ça arrive, et la réponse tient en une ligne : **les espèces continuent**. La
caisse ne dépend de SumUp que pour la carte.

- Le lecteur refuse ou ne répond plus : encaisser en espèces. La caisse propose
  le choix à chaque vente, rien n'est à reconfigurer.
- Si la panne dure, retirer le lecteur de la caisse dans *Open POS → Appareils
  de caisse* (mettre son lecteur à **Aucun**). Cette caisse revient aux
  paiements carte saisis à la main : quelqu'un prend la carte dans l'application
  SumUp Paiements et le signale à la caisse. **Attention**, un lecteur piloté par
  l'API Cloud est détaché de cette application — ce repli suppose un second
  moyen d'encaisser, pas le même lecteur.
- Un paiement resté en l'air apparaîtra dans *Ventes → Paiements carte sans
  vente*. Ne pas réencaisser avant d'avoir vérifié dans SumUp si la carte a été
  débitée.
- Ce qui ne marche pas : faire payer deux fois « au cas où ». SumUp ne rembourse
  que contre une transaction existante, et un client qui a payé deux fois
  attendra deux remboursements.

### 7.1 Sur la caisse

*Réglages* (⚙) contient :

- le **choix de l'événement**, si le device en voit plusieurs ;
- le **nom du caissier**, mémorisé sur l'appareil, joint à chaque vente ;
- l'**apparence** : *Système*, *Clair* ou *Sombre*. Par défaut la caisse suit la
  tablette. Le sombre n'éblouit pas dans une salle peu éclairée, le clair reste
  lisible dehors en plein jour, et une tablette réglée sur bascule automatique
  passera d'elle-même au sombre au coucher du soleil. Le choix est mémorisé par
  appareil, écrit sur `<html data-theme>` ; les deux palettes sont des jeux de
  variables CSS, donc changer d'avis ne coûte pas un rendu ;
- la **recette de l'événement** : ventes, espèces, carte et total, pour cet
  appareil et pour tous les appareils, et le bouton **Détail de la recette**.
  Elle reste entière sur un appareil rattaché à une caisse espèces : c'est ce
  que l'événement a vendu, pas ce que le tiroir devrait contenir, qui ne
  s'affiche qu'à côté d'un comptage (§5septies) ;
- *Recharger* et *Dépairer*. Dépairer révoque aussi l'appareil dans pretix,
  comme pretix le demande à toute app qui retire un appareil (`/device/revoke`) :
  il passe *révoqué* dans la liste des appareils de l'organisateur au lieu d'y
  rester actif avec un token valable que plus personne ne détient. Sans réseau
  à ce moment-là, la caisse le fait dès qu'elle le retrouve.

**La recette est celle de l'événement**, plus celle de la journée. Jusqu'à la
0.18, l'écran s'appelait « Recette du jour » et comptait depuis 6 h du matin ;
mais la question qu'on pose en fermant est ce que la soirée a rapporté, et la
soirée, c'est l'événement, même quand il traverse minuit ou dure trois soirs.
Dans une **série**, c'est la date que la caisse vend ce soir, choisie comme pour
chaque vente (le lendemain matin, quand plus rien n'est en vente, la plus
proche), et nommée sous le titre. Une annulation recopie les lignes de la vente
qu'elle annule, donc elle retombe sur la date de cette vente : corriger la
commande de la semaine dernière corrige la recette de la semaine dernière, pas
celle de ce soir.

Le **détail** s'ouvre par-dessus les réglages, sur une colonne au téléphone et
sur deux à la tablette en paysage :

- en tête, le total, les espèces et la carte, avec le nombre de ventes ;
- **par produit**, sous leur catégorie et dans l'ordre de la boutique, avec
  quantité et montant. Les annulations sont déjà déduites de chaque ligne, et un
  produit dont toutes les ventes ont été annulées n'apparaît pas ;
- les **consignes à part** : prises, rendues et solde. Une consigne n'est pas une
  vente, c'est de l'argent dû à qui rapporte le gobelet ;
- **par appareil**, le plus gros en tête, celui qu'on tient marqué, le
  back-office en dernier : les annulations faites dans pretix y tombent (voir
  *Une vente annulée depuis pretix*), et la ligne de la caisse reste ce que son
  tiroir contient ;
- **par soirée**, seulement quand l'événement en a eu plusieurs, une soirée
  allant de 6 h à 6 h le lendemain ;
- ce que les chiffres ne disent pas seuls : combien de ventes ont été annulées
  et pour combien, ce qui est passé en mode test (compté nulle part), et les
  ventes encore en file hors ligne avec leur montant en espèces — la recette
  affichée ne les compte pas encore, et le tiroir, si.

Chaque euro du total est dans une seule ligne du détail : un produit, les
consignes, ou, pour une écriture sans lignes, une phrase qui le dit. Les
sections tombent donc toujours juste sur le total. Le calcul
([takings.py](../pretix_openpos/takings.py)) est le même que celui de la page
*Ventes* du back-office, si bien que les deux ne peuvent pas se contredire.

**Le panier survit à un rechargement.** iOS tue une application web mise en
arrière-plan, une tablette redémarre, quelqu'un tire pour rafraîchir. Le panier
est recopié sur le disque au fur et à mesure et restauré au démarrage suivant.
L'**avoir** compte le plus : tant que la vente corrigée n'est pas enregistrée,
il n'existe nulle part ailleurs que sur la tablette, et c'est de l'argent dû à
quelqu'un qui est devant le comptoir.

C'est aussi pour ça qu'il expire au bout d'une demi-heure. Restaurer un avoir
périmé déduirait du total du client suivant de l'argent qui appartient à
quelqu'un parti depuis une heure — de l'argent qui sort vraiment du tiroir —
alors que perdre un avoir récent coûte un détour par l'historique. Les deux
erreurs n'ont pas la même taille. Un panier restauré est par ailleurs
retarifé sur le catalogue en vigueur avant d'être lu à voix haute.

Vider un panier qui porte un avoir demande confirmation. Seulement dans ce cas :
un panier de consommations se resaisit en dix secondes, et une confirmation à
chaque *Vider* est une confirmation que plus personne ne lit à la troisième.

Sans caisse espèces, c'est tout ce que la caisse offre pour rapprocher le
tiroir en fin de soirée : ce que l'événement a encaissé. Le fond de caisse, les
entrées et sorties d'argent, ce que le tiroir doit contenir, le comptage et le
rapport de fermeture viennent avec la caisse espèces (§5septies), qu'on active
en rattachant l'appareil à un tiroir.

### 7.2 Dans le back-office

*Open POS → Ventes* affiche le journal (100 lignes par page, plus récent
d'abord), les recettes **ventilées par caisse et par caissier**, le total, la
ligne mode test séparée, le **détail par produit** — le même que sur la caisse :
par catégorie, consignes à part, annulations déduites — et l'état de la chaîne
d'intégrité. Le bouton
**Export CSV** télécharge le journal entier — une ligne par écriture, avoirs
compris — pour la personne qui tient les comptes ; les recettes se recalculent
depuis ce fichier, c'est le but.

**Une soirée à la fois.** Deux champs de date en haut de la page réduisent le
journal *et* les recettes à l'intervalle demandé, et le bouton Export CSV
emporte le même intervalle — un export qui rendrait tout pendant que l'écran
montre une soirée est le piège coûteux, puisque la personne qui l'ouvre est en
train de rapprocher une caisse et n'a aucun moyen de s'en apercevoir.

L'unité est la **soirée**, pas la journée civile : elle commence à six heures du
matin et court jusqu'à six heures le lendemain. `Du 19/09 au 19/09` donne donc
toute la soirée du samedi 19, petites heures comprises. Découper à minuit
couperait chaque événement de ce système en deux moitiés qui ne répondent à
rien. Les deux bornes sont facultatives, et une date illisible ou un intervalle
à l'envers est dit à l'écran plutôt que silencieusement ignoré : un filtre qui
ne fait rien sans le dire est pire que pas de filtre.

Deux blocs ne suivent jamais ce filtre, exprès : la vérification d'intégrité et
les paiements carte sans vente. La chaîne traverse le journal entier, donc en
contrôler une tranche laisserait une page affichant une soirée déclarer le
journal sain alors que l'écriture cassée est juste en dehors de la fenêtre ; et
un débit orphelin a d'autant plus besoin d'être vu qu'il date d'avant.

La page vérifie la chaîne depuis un point de contrôle plutôt que de re-hacher
tout le journal à chaque affichage ; l'audit intégral, depuis la première
écriture, se lance avec `python -m pretix openpos_verify_journal` (une ligne
par événement, code de sortie non nul si une chaîne ne colle pas). À lancer
chaque nuit, par cron ou par un CronJob selon l'hébergement, parce qu'une chaîne
cassée découverte le jour où quelqu'un doute du journal est découverte trop
tard.

**Paiements carte sans vente.** La même page liste les paiements posés sur un
lecteur sans qu'aucune vente n'ait jamais été enregistrée en face. C'est la seule
chose que le journal ne peut pas montrer par construction : la recette est
recalculée depuis lui, donc un débit qui ne l'a jamais atteint est absent de
chaque chiffre plutôt que faux dans l'un d'eux, et le seul autre endroit où cette
transaction existe est le tableau de bord SumUp.

Deux formes du même problème :

- **Débité** : SumUp dit que le paiement est passé et pretix n'en sait rien. Une
  carte a été débitée. Il faut soit rembourser dans SumUp, soit ressaisir la
  vente.
- **Toujours en attente** : la caisse a cessé d'interroger — batterie, chute,
  navigateur fermé — longtemps après que quiconque puisse être encore au
  comptoir. Vérifier dans SumUp si la carte est passée avant de faire l'un ou
  l'autre.

Les refus et les paiements déjà remboursés n'y figurent pas : la section est vide
une soirée ordinaire, et veut donc dire quelque chose quand elle ne l'est pas.
Elle est en lecture seule, délibérément — quoi faire de l'une de ces lignes est
une décision, pas quelque chose qu'un chargement de page doit trancher.

**Vendu à un prix qui avait changé.** Une vente encaissée pendant que la caisse
était coupée a été tarifée depuis le catalogue qu'elle avait en cache, et le
client a payé ce montant-là. La commande est donc créée à ce qui a réellement
été encaissé — facturer une somme que personne n'a versée serait pire — et
l'écart est reporté plutôt que lissé. Une section de la page Ventes le liste
pour l'intervalle affiché, ligne par ligne, avec le total de l'écart : c'est de
l'argent réel, présent dans la caisse et absent du tarif. L'export CSV porte les
deux mêmes colonnes, `tariff_total` et `off_tariff`, vides sur toutes les autres
lignes — un tableur peut donc les sommer sans lire la colonne des positions à
l'œil.

Le même écart est écrit dans l'historique de la commande elle-même, qui est
l'endroit où l'on regarde quand une seule commande ne colle pas au tarif deux
jours après. Auparavant le panneau de resynchronisation de la caisse était le
seul endroit où la chose était dite, une fois, à qui tenait la tablette.

**L'historique en clair.** Tout ce que le plugin écrit dans l'historique pretix
s'affiche en toutes lettres, et dit ce qui a changé plutôt que combien de choses
ont changé : « Bière : 3,50 € → 4,00 € » plutôt que « 6 produits modifiés ». Les
deux côtés de chaque changement et les noms sont recopiés dans l'entrée au
moment où elle est écrite, puisqu'un produit renommé ou supprimé la saison
suivante laisserait l'entrée pointer vers rien. La clé API SumUp n'y figure
jamais : seuls les noms des champs modifiés sont enregistrés, ce qui est
précisément la raison pour laquelle l'écran des réglages SumUp n'utilise pas
celui de pretix — ce dernier écrit la *valeur* de chaque champ modifié dans
l'historique.

Les entrées écrites sur l'organisateur — rôles des appareils, compte SumUp,
lecteurs appairés, libérés ou retirés — ne passent pas par le même chemin que
celles d'un événement ([logdisplay.py](../pretix_openpos/logdisplay.py) dit
pourquoi). De la 0.12.0 à la 0.15.1, elles passaient par le même, et la page
*Journaux de l'organisateur* (*Voir le journal complet*, sous l'historique des
modifications de l'organisateur) répondait par une erreur 500 dès que l'une
d'elles s'y trouvait, c'est-à-dire dès qu'on avait enregistré l'écran des
appareils ou réglé un lecteur. Rien n'était perdu : les entrées étaient en base,
et la 0.15.2 les affiche.

**Remboursements carte refusés par SumUp.** Une annulation de vente carte demande
le remboursement par API, et le réseau peut répondre non : transaction déjà
remboursée, plafond, lecteur disparu depuis. La caisse le dit en rouge, une fois,
à la personne qui a appuyé — pendant qu'on annonce au client que l'annulation est
passée. L'argent est toujours sur sa carte. Cette section est la liste qui
manquait, avec la référence SumUp pour la retrouver dans le tableau de bord ;
l'annulation, elle, tient, et pretix ne réessaie pas de lui-même. Comme les
paiements carte sans vente, elle ignore le filtre par soirée : une dette envers un
client ne cesse pas de compter parce que l'écran montre une autre soirée.

**Les caisses espèces** ont leur propre écran, *Open POS → Caisses espèces* :
chaque tiroir, chaque soirée, et le rapport de fermeture de chacune, avec
l'écart sur lequel elle a fermé (§5septies). C'est là, et plus sur *Ventes*,
qu'on rapproche un tiroir qui en a un.

Les commandes elles-mêmes sont des commandes pretix ordinaires : elles
apparaissent dans les listes, les exports et les rapports habituels, sur le canal
Open POS, avec la répartition espèces/carte. Le bloc de paiement de la page de
commande affiche le caissier, la série de la caisse, le montant reçu, le rendu et
le numéro de séquence du journal.

---

## 8. Référence API

Base : `/api/v1`. Authentification : `Authorization: Device <token>`.

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/device/initialize` | Appairage (endpoint pretix natif) |
| `POST` | `/device/update` | Version et système du device, quand ils ont changé depuis le dernier envoi (endpoint pretix natif) |
| `GET` | `/organizers/<org>/openpos/` | Événements de cette caisse : `results`, ceux où elle peut vendre ; `unavailable`, ceux qu'elle atteint sans pouvoir y vendre, avec `reason` (`plugin_disabled`) |
| `GET` | `/organizers/<org>/events/<ev>/openpos/config/` | Événement, device, listes de contrôle, produits d'admission, coupures, boutons montant libre et consigne |
| `GET` | `…/openpos/catalog/` | Catalogue par catégorie, prix, stock restant |
| `POST` | `…/openpos/checkout/` | Encaissement |
| `GET` | `…/openpos/summary/` | Recette de l'événement (d'une date, dans une série) : total, par produit, consignes, par appareil, par soirée |
| `GET` | `…/openpos/attendance/?list=<id>` | Présents sur place, sur une liste de contrôle ; scans de l'événement, par appareil (`scans`) |
| `GET` | `…/openpos/history/` | Journal de l'événement, **de cette caisse seule** (100 dernières, `truncated` si tronqué) |
| `GET` | `…/openpos/offline/?list=<id>` | Liste embarquée pour scanner sans réseau |
| `POST` | `…/openpos/cancel/` | Annule une vente de cette caisse (avoir + remboursement + contrepassation) |
| `POST` | `…/openpos/terminal/start/` | Met le panier sur le lecteur de cette caisse |
| `GET` | `…/openpos/terminal/status/?idempotency_key=<clé>` | Où en est ce paiement lecteur |
| `POST` | `…/openpos/terminal/cancel/` | Retire le panier du lecteur |
| `GET` | `…/openpos/drawer/` | La caisse espèces de cet appareil : ouverte ou non, fond, entrées et sorties, dernier comptage, et ce qu'elle doit contenir maintenant (`expected`, avec `cash_sales`, `cash_returned`, `cash_in`, `cash_out`) |
| `POST` | `…/openpos/drawer/open/` | Ouvre la caisse sur le fond compté (`amount`, `denominations` facultatif) |
| `POST` | `…/openpos/drawer/movement/` | Entrée (`in`) ou sortie (`out`) d'argent, avec son motif |
| `POST` | `…/openpos/drawer/count/` | Comptage, répondu avec l'attendu et l'écart |
| `POST` | `…/openpos/drawer/close/` | Ferme sur un comptage encore à jour (`count_seq`), ou sans comptage (`uncounted`) une caisse ouverte un jour précédent |
| `POST` | `/organizers/<org>/checkinrpc/redeem/` | Pointage (endpoint pretix natif) |
| `GET` | `/organizers/<org>/checkinrpc/search/` | Recherche de participant (natif) |
| `POST` | `…/checkinlists/<id>/failed_checkins/` | Refus donné hors ligne, envoyé à la reprise (natif) |

Tout appel sur un événement où le plugin n'est pas activé est refusé en 403, quel
que soit l'accès du device : c'est ce qui empêche une app périmée de vendre sur
un événement pour lequel l'organisateur n'a jamais ouvert de caisse.

Les trois endpoints `terminal/` n'existent que pour une caisse à qui un lecteur
est attribué ; les autres reçoivent `no_terminal`. De même, les écritures
`drawer/` n'existent que pour un appareil rattaché à une caisse espèces ; les
autres reçoivent `no_drawer`, et `GET drawer/` leur répond `"drawer": null`.
Chaque écriture `drawer/` porte une `idempotency_key`, comme l'encaissement. En dehors de `/api/v1`, le
plugin expose aussi `POST /openpos/sumup/<org>/<jeton>/`, où SumUp signale qu'un
paiement lecteur s'est terminé — non authentifié par conception de SumUp, donc
rien de ce qu'il dit n'est cru (§5quinquies).

### Corps de `checkout/`

```json
{
  "idempotency_key": "01J8Z…",
  "positions": [ { "item": 12, "variation": null, "count": 2 } ],
  "payment_type": "cash",
  "cash_given": "20.00",
  "cashier": "Alice",
  "expected_total": "17.00"
}
```

`variation` est optionnel (défaut `null`), `count` va de 1 à 999, au maximum 100
lignes. `cash_given` n'est accepté que pour un paiement en espèces, et refusé
dès que `expected_total` est négatif : c'est le tiroir qui paie, rien n'a été
tendu.

Une position peut aussi porter, l'une **ou** l'autre, jamais les deux (§5quater) :

| Champ | Ce que ça veut dire |
|---|---|
| `price` + `description` | Montant libre. Refusé sur tout produit autre que celui désigné dans les réglages, refusé sans motif, refusé à zéro ou en dessous. |
| `refund: true` | Retour de consigne. Le prix reste décidé par le serveur, en négatif. Refusé sur tout produit autre que le produit de consigne, et refusé avec une variante. |

`expected_total` est le **net** : commande moins consignes rendues. C'est le
seul chiffre que le client entend, donc le seul contre lequel il y ait un sens à
vérifier.

Une vente rejouée depuis une caisse qui était coupée porte en plus un bloc
`offline`, et c'est **la seule chose qui débloque un prix envoyé par le
client** :

```json
{
  "idempotency_key": "01J8Z…",
  "positions": [ { "item": 12, "variation": null, "count": 2, "price": "8.50" } ],
  "payment_type": "cash",
  "cash_given": "20.00",
  "offline": { "recorded_at": "2026-08-16T22:02:21Z", "charged_total": "17.00" }
}
```

Toutes les lignes doivent porter leur prix ou aucune, la somme doit tomber sur
`charged_total` (garde-fou contre une file corrompue en stockage), et
`expected_total` est interdit — il répondrait à une question que la caisse ne
pouvait pas poser. La réponse ajoute alors `off_tariff` : les lignes dont le
tarif serveur diffère de ce qui a été encaissé. Voir §5ter.

### Réponse

```json
{
  "order": { "code": "ABCDE", "total": "17.00", "url": "/demo/festival/order/ABCDE/…/" },
  "journal_seq": 42,
  "payment_type": "cash",
  "cash_given": "20.00",
  "cash_change": "3.00",
  "datetime": "2026-08-09T21:14:05+02:00",
  "replayed": false,
  "checked_in": 2,
  "checkin_errors": [],
  "off_tariff": [],
  "off_role": [],
  "deposit_refund": null,
  "deposit_refund_seq": null,
  "net_total": "17.00"
}
```

Sur une transaction qui rend une consigne, `deposit_refund` porte le montant
rendu (positif) et `deposit_refund_seq` le numéro de l'écriture de journal qui
le constate ; `net_total` est ce qui a changé de mains, négatif quand c'est le
tiroir qui paie. Quand rien n'a été vendu, `order.code` est vide et
`order.total` vaut `"0.00"` : il n'y a pas de commande, et en annoncer une à
moins trois euros serait pire que de n'en annoncer aucune.

`off_role` est vide sur tout ce que l'app pouvait taper dans la grille qu'on
lui a servie. Quand il ne l'est pas, une caisse a rejoué une vente prise hors de
ce que son rôle couvre : voir §2.7bis.

`replayed` vaut `true` — avec un `200` au lieu d'un `201` — quand la clé
d'idempotence désigne une vente déjà enregistrée. La réponse est alors celle de
la vente d'origine, et ce qui manquait de la traîne (facture, pointages) est
terminé au passage.

### Réponse de `summary/`

```json
{
  "scope": { "event": "Festival", "series": false, "subevent": null },
  "computed_at": "2026-08-17T01:34:05+02:00",
  "event": {
    "count": 486, "cancellations": 3, "cancelled_total": "-14.50",
    "deposit_refunds": 41, "cash": "1391.50", "card": "911.50", "total": "2303.00"
  },
  "device": { "count": 212, "cancellations": 1, "cancelled_total": "-4.00", … },
  "testmode": null,
  "categories": [
    {
      "id": 2, "name": "Bar", "count": 391, "total": "1318.00",
      "items": [
        { "item": 12, "variation": null, "name": "Bière", "variation_name": null,
          "count": 240, "total": "840.00" }
      ]
    }
  ],
  "deposits": {
    "taken": { "count": 212, "total": "212.00" },
    "returned": { "count": 187, "total": "-187.00" },
    "total": "25.00"
  },
  "unallocated": null,
  "devices": [
    { "name": "Bar 1", "serial": "TILL1", "current": true, "count": 212, … }
  ],
  "nights": [
    { "date": "2026-08-15", "count": 231, … },
    { "date": "2026-08-16", "count": 255, … }
  ],
  "first": "2026-08-15T19:02:11+02:00",
  "last": "2026-08-17T01:31:40+02:00"
}
```

Tout l'événement, ou dans une série la date de `scope.subevent`, annulations et
consignes rendues déduites : c'est ce que le tiroir contient. `count` compte des
ventes, pas des lignes de journal ; `cancellations` compte les ventes annulées
(un panier avec des gobelets rendus en est une), et `cancelled_total` est ce
qu'elles ont rendu, déjà compté dans `cash` et `card`. `device` est la part de
l'appareil qui appelle, `null` pour un autre appelant, et `testmode` ce qui est
passé en mode test, compté nulle part ailleurs.

`categories` suit l'ordre de la boutique, `name` à `null` pour les produits sans
catégorie. Les totaux des catégories, le solde des `deposits` et `unallocated`
(l'argent d'écritures sans lignes, `null` d'habitude) font exactement
`event.total`. `devices` met le back-office (`serial` à `null`) en dernier ;
`nights` découpe par soirée, de 6 h à 6 h. `since` reste envoyé, égal à `first`,
pour une app d'avant la 0.19 pas encore rouverte.

### Réponse de `attendance/`

```json
{
  "list": { "id": 3, "name": "Entrée principale" },
  "computed_at": "2026-08-16T21:14:05+02:00",
  "inside": 128,
  "entered": 141,
  "exited": 13,
  "expected": 220,
  "not_arrived": 79,
  "non_admission_entered": 12,
  "items": [
    { "id": 12, "name": "Plein tarif", "inside": 90, "entered": 100, "expected": 150 }
  ],
  "scans": {
    "device": { "admitted": 64, "refused": 3, "other": 1, "offline": 12 },
    "event": { "admitted": 196, "refused": 7, "other": 4, "offline": 12 },
    "devices": [
      { "id": 7, "name": "Porte 1", "current": true, "admitted": 64, "refused": 3, "other": 1, "offline": 12 }
    ]
  }
}
```

`scans` compte les scans de l'événement sur **toutes** ses listes,
pas seulement celle demandée (voir §5.2). `device` vaut `null` pour un appelant
qui n'est pas un appareil, et `id` comme `name` valent `null` sur la ligne des
scans faits depuis le back-office. `id` est celui de l'appareil dans pretix.

Dans une série, tous les chiffres suivent la date de la liste, ou celle de ce
soir sur une liste ouverte à toutes les dates (§5.1).

`inside + exited == entered` et `entered + not_arrived == expected`, toujours :
les quatre chiffres sont tirés de la même population. `list` est facultatif dans
la requête et retombe alors sur la liste configurée pour la caisse ; une liste
inconnue est un 400, pas un repli silencieux sur une autre porte.

### Corps et réponse de `cancel/`

```json
{ "seq": 42, "idempotency_key": "01J8Z…", "cashier": "Alice", "reason": "erreur d'article" }
```

```json
{
  "cancellation": { "seq": 43, "kind": "cancellation", "total": "-52.50", "cancels_seq": 42, … },
  "sale":         { "seq": 42, "kind": "sale", "total": "52.50", "cancelled": true, … },
  "replayed": false,
  "credit_note": "FESTIVAL-00004",
  "refunded": true
}
```

`credit_note` vaut `null` quand la commande n'avait pas de facture — voir §5bis.
`sale.positions` sert à remettre les articles au panier ; les prix, eux, sont
repris du catalogue du jour et non du journal, sinon une correction ressusciterait
le tarif d'hier.

### Erreurs utiles

| Statut | Cas | Ce que fait l'app |
|---|---|---|
| 400 `price_changed` | Les prix ont bougé sous le panier | Recharge le catalogue, re-tarife, garde le panneau ouvert |
| 400 `positions` | Produit non vendable au guichet / variante inconnue | Affiche le message tel quel |
| 400 `cash_given` | Reçu inférieur au dû, ou montant reçu sur un panier qui paie | Affiche le message |
| 400 `terminal_required` | Vente carte qu'aucun paiement lecteur ne justifie | Ne devrait pas arriver : l'app passe par le lecteur (§5quinquies). Affiche le refus |
| 400 `no_terminal` | Appel `terminal/` depuis une caisse sans lecteur | Idem ; l'app n'offre ce chemin qu'en mode `terminal` |
| 400 `nothing_to_charge` | Panier qui ne doit rien, ou qui rend de l'argent | L'app le dit avant d'appeler : *à régler en espèces* |
| 400 `sold_out` | Produit épuisé, vérifié avant de demander la carte | Affiche le message tel quel |
| 400 `terminal_unreachable` | SumUp a refusé de solliciter le lecteur : lecteur hors ligne, encore occupé par la demande précédente, clé refusée… | Affiche le motif, avec *Réessayer* (nouvelle clé) |
| 400 `no_payment` | `terminal/status` ou `terminal/cancel` sur un panier jamais démarré | Affiche le motif |
| 400 `drawer_closed` | Espèces (vente, consigne rendue, annulation) alors que la caisse espèces de l'appareil n'est pas ouverte | Relit l'état de la caisse ; le panneau de paiement propose de l'ouvrir |
| 400 `drawer_stale` | Espèces alors que la caisse espèces est ouverte depuis un jour précédent | Idem ; le panneau de la caisse propose de la fermer sans compter |
| 400 `drawer_open` | Ouverture d'une caisse déjà ouverte, par exemple depuis l'autre tablette | Revient à la vue de la caisse, relue |
| 400 `count_stale` | Fermeture sur un comptage qu'une vente ou un mouvement a rendu périmé | Revient à la vue de la caisse et demande de recompter |
| 400 `count_required` | Fermeture sans comptage d'une caisse ouverte ce soir | Idem |
| 400 `no_drawer` | Écriture `drawer/` depuis un appareil sans caisse espèces | Relit l'état : le bouton de la caisse disparaît |
| 400 `reason_required` | Entrée ou sortie d'argent sans motif | Affiche le message |
| 401 / 403 | Device révoqué, ou plugin désactivé sur l'événement | Affiche le motif, avec *Réessayer* et *Dépairer* ; l'appairage n'est jamais effacé tout seul |

---

## 9. Développement

Tout tourne dans Docker, il n'y a pas besoin d'un pretix local.

```bash
docker compose up --build
docker compose exec pretix python -m pretix shell < dev/seed.py
```

Le seed est idempotent et affiche un code d'appairage. Back-office sur
http://localhost:8000/control/ avec `admin@localhost` / `admin`.

Le front se compile dans le répertoire statique du plugin :

```bash
cd frontend
npm install
npm run build
npm run dev
```

`npm run dev` lance Vite sur le port 5174 en proxifiant `/api` vers le 8000.
Le build produit des noms de fichiers **stables** (`app.js`, `app.css`) et non
hachés : le cache-busting est le travail de pretix via
`ManifestStaticFilesStorage`, ce qui évite de régénérer le gabarit Django à
chaque build.

### Les tests

Deux suites tournent à chaque push (CI), une troisième série se lance à la main.

**La suite backend** (`tests/`) parle au plugin **en HTTP, à travers un vrai
pretix** : vrai ORM, vraie création de commande, vrai service de check-in, vraie
authentification par device. Elle tourne sur SQLite avec les réglages de test de
pretix et ses migrations désactivées — le schéma est construit depuis les
modèles, ce qui la rend rapide (une dizaine de secondes).

```bash
pip install pretix && pip install --no-deps -e . && pip install pytest pytest-django
pytest

# ou, sans rien installer sur la machine :
docker compose exec pretix sh -c "pip install -q pytest pytest-django && cd /plugin && pytest"
```

Ce qu'elle couvre, fichier par fichier :

| Fichier | Ce qu'il pin |
|---|---|
| `test_checkout.py` | Le serveur seul décide du prix, l'idempotence, le total annoncé, le rendu de monnaie, le check-in immédiat limité aux produits d'admission |
| `test_offline_replay.py` | Ce qu'un rejeu enregistre, et surtout ce qu'il **refuse de refuser** — quota épuisé, produit retiré du canal, déclinaison désactivée |
| `test_offline_snapshot.py` | Le contenu de la liste embarquée, et que la lire coûte le même nombre de requêtes quelle que soit sa taille |
| `test_cancel.py` | Avoir, remboursement, contre-passation, et le rejeu d'une annulation qui avait expiré |
| `test_journal.py` | La chaîne de hachage : falsification détectée, ligne supprimée détectée, ajout seul, versions de charge, ce que le point de reprise voit et ne voit pas |
| `test_summary.py` | La recette de tout l'événement (une date dans une série, une annulation retombant sur la date de sa vente), par produit et par catégorie, les consignes à part, par appareil et par soirée, le mode test à part, une annulation qui se nette |
| `test_catalog.py` | Ce que la caisse a le droit de vendre et ce qu'on lui dit de l'événement |
| `test_attendance.py` | Le compteur de présents, produits d'admission seulement |
| `test_door_scans.py` | Le compteur du scanneur : par appareil et pour tout l'événement (une date dans une série), ce qui est un scan et ce qui n'en est pas, la marque hors ligne de pretix, un refus envoyé après coup, une vente en caisse qui n'est plus marquée hors ligne |
| `test_device_roles.py` | Le rôle d'un appareil, et ce que le serveur refuse à une caisse qui a un lecteur |
| `test_terminal.py` | Le paiement sur le lecteur de bout en bout : panier épinglé, double appui, webhook forgé, remboursement à l'annulation |
| `test_sumup_client.py` | La forme d'un échec SumUp — « refusé », « pas encore », « on n'a pas pu demander » |
| `test_sumup_backoffice.py` | Les deux écrans matériels : la clé d'API hors des journaux, un lecteur donné à une seule caisse, SumUp en panne |
| `test_backoffice.py` | Les écrans, chacun avec sa permission exacte — dont la page de commande de pretix, qu'une vente espèces a déjà mise en 500 |
| `test_arrivals.py` | La page de l'organisateur : une ligne par soirée (une date de série comprise), l'histogramme et tout ce qu'il ne doit pas compter |
| `test_event_arrivals.py` | La page d'une soirée : les arrivées font les entrés, les refus par motif font les refusés, un billet ressorti puis rentré n'arrive qu'une fois, minuit, plusieurs nuits, la liste de la caisse, une date de série |
| `test_security.py` | Ce qu'un token de caisse atteint, et surtout ce qu'il n'atteint pas |

**La suite frontend** (`frontend/src/*.test.ts`) couvre la logique qui décide où
va l'argent : les règles de reprise de la file, les verdicts hors ligne à la
porte, l'arithmétique en centimes, la monnaie à rendre sur une commande corrigée
contre un avoir, la clé d'idempotence d'une annulation, et la conduite du
lecteur de carte — dont la règle qu'un serveur injoignable ne s'affiche jamais
comme un refus.

```bash
cd frontend && npm test
```

**Les scripts de `dev/`** se lancent à la main contre la pile docker compose.
Ils ne font pas doublon : ils couvrent ce qui n'existe que dans un système
entier.

| Script | Ce qu'il couvre |
|---|---|
| [`dev/smoke_test.py`](../dev/smoke_test.py) | Bout en bout de l'API : appairage, catalogue, vente espèces, rejeu à l'identique, recette. Bibliothèque standard uniquement |
| [`dev/backoffice_test.py`](../dev/backoffice_test.py) | Rend les pages du back-office avec un vrai navigateur de session |
| [`dev/concurrency_test.py`](../dev/concurrency_test.py) | Martèle la caisse depuis plusieurs fils et vérifie que le journal tient. **À lancer sur PostgreSQL** : le savepoint du journal est indulgent sur SQLite et impitoyable sur PostgreSQL, ce que la suite backend ne peut pas voir |
| [`dev/arrivals_test.py`](../dev/arrivals_test.py) | Sème son propre organisateur et vérifie l'histogramme, puis la page d'une soirée, sur des données connues |

`OPENPOS_BASE` permet de viser une autre instance que la pile de dev SQLite.

**Le harness visuel** ([`frontend/harness/`](../frontend/harness/)) monte la
vraie app devant un serveur simulé, pour qu'un écran puisse être *regardé* et
pas seulement affirmé. Une suite jsdom ne verra jamais qu'un clavier dépasse
d'un iPad mini ; c'est pourtant ce qui arrivait. Il se lance avec
`npm run dev`, puis :

```
http://localhost:5174/static/pretix_openpos/pwa/harness.html?browser=1
```

Les paramètres d'URL — rôle, lecteur de carte, hors ligne, file d'attente,
photos, palette — sont listés dans [`harness/README.md`](../frontend/harness/README.md).
Trois scripts Playwright l'accompagnent : `shoot.mjs` prend des captures aux
tailles des appareils réellement en service, `measure.mjs` mesure ce qui
dépasse, et `audit.mjs` parcourt dix écrans dans les deux palettes et échoue
sur un texte sous le seuil AA ou une cible tactile sous 44 px. Playwright
n'est volontairement pas dans `package.json` — il télécharge un navigateur à
l'installation — donc `npm i --no-save playwright` avant de s'en servir.

---

## 10. Dépannage

| Symptôme | Cause probable |
|---|---|
| L'app affiche les instructions d'installation alors qu'elle est installée | Le navigateur signale mal son mode d'affichage. Ouvrir une fois `/openpos/?browser=1` |
| 500 sur le JavaScript de la caisse après déploiement | Image construite sans `npm run build` préalable |
| L'image refuse de démarrer sur le cluster | Image arm64 sur un nœud amd64 : rebâtir avec `--platform linux/amd64` |
| Aucun produit dans le catalogue | Canal **Open POS** non coché sur les produits, ou produits sans quota disponible |
| Les photos de produits ne s'affichent pas | Le produit n'a pas d'image dans pretix — ou les médias sont servis depuis un autre domaine (S3, CDN) : la coquille annonce `img-src 'self' data:`, et une image d'ailleurs est bloquée. La case reste vide, la vente n'est pas gênée |
| Un produit reste « Épuisé » alors qu'aucune limite n'est atteinte | Il n'est rattaché à aucun quota : pretix ne peut pas le vendre, et la caisse le montre comme épuisé plutôt que de le laisser au panier pour être refusé au paiement. Créer un quota (illimité au besoin) et l'y rattacher |
| « Une erreur est survenue » avec un 401 ou 403 au lancement | Device révoqué ou supprimé, plugin désactivé sur l'événement — ou un CDN / pare-feu qui conteste la requête. *Réessayer* d'abord ; *Dépairer* seulement si le device a bien été révoqué |
| L'événement n'apparaît pas au moment de l'appairage ou dans *Réglages → Événement* | Plugin non activé sur l'événement (l'app le nomme alors, sous le champ), ou device sans accès à l'événement (*Appareils → cet appareil*). Que la boutique soit en ligne ne compte pas |
| « Faites entrer » ne s'affiche jamais | Aucune liste de contrôle choisie dans *Open POS → Réglages*, ou aucun produit d'admission dans la vente |
| Un billet refuse de se scanner | Code-barres non-QR : passer par la recherche par nom ou une douchette clavier |
| La caméra ne démarre pas | Contexte non sécurisé (HTTP), ou autorisation refusée dans les réglages du navigateur |
| La recette ne correspond pas au tiroir | Vérifier la ligne « mode test » sur l'écran *Ventes* : elle est comptée à part. Sur un appareil rattaché à une caisse espèces, c'est le rapport de fermeture qui se rapproche du tiroir, pas la recette : elle ne compte ni le fond ni les entrées et sorties d'argent |
| La caisse refuse les espèces : « La caisse … n'est pas ouverte » | Ouvrir la caisse espèces (bouton billet de la barre du haut) sur un fond compté. Le client peut attendre : rien n'a été enregistré |
| « Ouverte … et jamais fermée » | La caisse espèces n'a pas été fermée une soirée précédente. *Fermer sans compter* sur la caisse, ou fermer depuis son rapport avec le montant si quelqu'un l'a compté, puis ouvrir celle du soir |
| « La caisse a bougé depuis le comptage » à la fermeture | Une vente ou un mouvement est passé depuis, souvent sur l'autre tablette du même tiroir : recompter, puis fermer |
| L'app reste sur un vieux build | Une caisse ouverte compare sa version à celle du serveur au rafraîchissement du catalogue et affiche « Nouvelle version — recharger » entre deux clients ; sinon, fermer et rouvrir l'app force la reprise |
| La liste des appareils affiche une ancienne version | Le device n'a pas été rouvert avec du réseau depuis la mise à jour : il déclare sa version à la première ouverture connectée. C'est aussi le moyen de voir, après un déploiement, quels appareils ont repris le nouveau JavaScript |

---

## 11. Ce qui n'existe pas

Rappel, parce que c'est la première question qu'on se pose en incident :

pas de **remboursement partiel** depuis la caisse — une vente s'annule en entier puis se
refait corrigée, rembourser deux bières sur trois reste un travail de back-office
—, pas de **remboursement libre sur carte** : rendre une consigne se fait en
espèces, et ce n'est pas un choix mais une contrainte de SumUp (§5quater), pas
d'**impression** de reçu ni de billet, pas de **questions au contrôle**, pas
de **Tap to Pay** (Stripe ne l'expose que par ses SDK natifs), et **aucune
certification fiscale** — le journal est conçu pour qu'un travail de conformité
reste possible, mais aucune revendication n'est faite sur les législations
française, allemande ou autrichienne sur les caisses enregistreuses.

La suite envisagée est décrite dans la [feuille de route du README](../README.md#roadmap).
