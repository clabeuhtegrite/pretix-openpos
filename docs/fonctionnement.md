# Fonctionnement de pretix-openpos

Documentation de fonctionnement du plugin, version 0.4.0. Elle couvre trois
choses, dans cet ordre : ce que le plugin ajoute à pretix, comment le mettre en
service, et ce qui se passe exactement quand un bénévole encaisse.

Pour l'argumentaire, le périmètre et ce qui est délibérément absent (hors ligne,
remboursements, impression), voir le [README](../README.md).

---

## 1. Vue d'ensemble

Le produit est en deux morceaux qui ne partagent aucun code :

| Morceau | Où il vit | Ce qu'il fait |
|---|---|---|
| **Plugin pretix** (`pretix_openpos/`) | Dans le process pretix | Canal de vente, tarif sur place, API caisse, journal, écrans back-office |
| **PWA** (`frontend/`) | Dans le navigateur de la tablette | Catalogue, panier, pavé numérique, scan, relevé |

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
│  relevé du jour          │  verdict      │  GET  /openpos/attendance        │
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
*Disponibilité*, et seuls les produits cochés remontent à la caisse.

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

L'argent est **toujours encaissé avant** que la commande n'existe, donc ces
prestataires ne participent jamais à un tunnel de paiement interactif :
`is_allowed()` renvoie `False` en dur (jamais proposés dans la boutique),
`is_enabled` renvoie `True` (pour que l'identifiant se résolve quand l'API crée
une commande déjà payée).

`payment_control_render()` affiche « reçu / rendu » sur la page de commande du
back-office.

### 2.3 Un profil de sécurité pour les devices

[security.py](../pretix_openpos/security.py) déclare `OpenPosSecurityProfile`, une
liste blanche d'endpoints. Un token de device vit dans le navigateur d'une
tablette posée sur un comptoir : il faut partir du principe qu'il fuitera. Le
profil par défaut de pretix accorde lecture/écriture sur *toutes* les commandes
de tous les événements visibles ; celui-ci réduit à :

- le cycle de vie du device (`initialize` implicite, `info`, `update`, `roll`,
  `revoke`, `eventselection`) ;
- la lecture des événements (nom, devise) ;
- les six endpoints Open POS ;
- `checkinrpc.redeem` et `checkinrpc.search` pour le scan à la porte.

### 2.4 Deux modèles

[models.py](../pretix_openpos/models.py).

**`PosPrice`** — le tarif sur place. pretix résout les prix par
`Item.default_price` → `ItemVariation.default_price` → `SubEventItem` et n'a
aucune notion de prix par canal de vente ; le tarif guichet doit donc vivre
ici. Une ligne par produit (ou par variante). Deux contraintes uniques partielles
plutôt qu'un `unique_together` : la plupart des bases considèrent les `NULL`
comme distincts et accepteraient donc des doublons au niveau produit.

**`PosSale`** — le journal, en ajout seul. Une ligne par vente, jamais modifiée,
jamais supprimée : `save()` sur une ligne existante et `delete()` lèvent une
`ValueError`. Chaque ligne porte :

| Champ | Rôle |
|---|---|
| `seq` | Compteur sans trou, par événement, à partir de 1 |
| `device`, `device_serial`, `device_name` | La caisse. Dénormalisé pour survivre à la suppression du device |
| `cashier` | Étiquette libre saisie dans l'app, pour distinguer deux bénévoles sur une même tablette |
| `order`, `order_code` | La commande pretix. Dénormalisé : les commandes de test sont purgeables |
| `testmode` | Écrit à la création, pas déduit après coup (voir §6.4) |
| `positions` | Instantané JSON de ce qui a été vendu, lisible même si le produit est renommé ou supprimé |
| `idempotency_key` | Unique par événement |
| `previous_hash`, `hash`, `hash_version` | La chaîne d'intégrité |

### 2.5 Trois écrans de back-office

[views.py](../pretix_openpos/views.py), montés par [urls.py](../pretix_openpos/urls.py).

| URL | Écran | Permission exigée |
|---|---|---|
| `/control/event/<org>/<ev>/openpos/` | Réglages (liste de contrôle d'accès) | `event.settings.general:write` |
| `…/openpos/prices/` | Prix sur place | `event.items:write` |
| `…/openpos/sales/` | Journal des ventes + relevé | `event.orders:read` |

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
  classique de rester bloqué sur un vieux build.

---

## 3. Mise en service (pas à pas)

### 3.1 Installer le plugin

```bash
pip install pretix-openpos
python -m pretix migrate
python -m pretix rebuild
```

En Docker/Kubernetes, [`deploy/Dockerfile`](../deploy/Dockerfile) intègre le plugin
à l'image officielle :

```bash
cd frontend && npm run build && cd ..
docker build --platform linux/amd64 -f deploy/Dockerfile -t registry/pretix-openpos:0.4.0 .
```

Deux pièges :

- **Compiler le front d'abord.** Le bundle PWA est généré, pas versionné. Une
  image construite sans lui démarre très bien, puis renvoie des 500 sur le
  JavaScript de la caisse.
- **`--platform linux/amd64` sur un Mac Apple Silicon.** Une image arm64 se
  construit, se pousse, passe tous les contrôles de manifeste, puis se fait
  refuser par le kubelet au moment du pull sur un nœud amd64.

### 3.2 Configurer l'événement

1. **Activer le plugin** — *Réglages → Plugins → Open POS*.
2. **Rendre les produits vendables au guichet** — sur chaque produit, sous
   *Disponibilité*, cocher le canal **Open POS**. Un produit qui n'existe *que*
   sur place se crée en ne cochant que ce canal.
3. **Fixer les prix sur place** — *Open POS → Prix sur place*. Un champ laissé
   vide = même prix que la boutique en ligne. Vider un champ déjà rempli
   supprime la surcharge.
4. **Choisir la liste de contrôle d'accès** — *Open POS → Réglages*. Les billets
   vendus sont pointés sur cette liste immédiatement. Laisser vide pour vendre
   sans pointer.

### 3.3 Créer une caisse

Sous *Organisateur → Devices → Créer* :

- donner accès à l'événement (ou à tout l'organisateur) ;
- choisir le profil de sécurité **Open POS** ;
- pretix affiche un QR d'appairage et le code en texte.

Un device peut vendre pour plusieurs événements : tout événement où le plugin est
activé apparaît dans *Réglages → Événement* de l'app, et changer d'événement ne
demande pas de réappairer.

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

---

## 4. Le déroulé d'une vente

### 4.1 Côté app

1. **Appairage** — `POST /api/v1/device/initialize` échange le code à usage
   unique contre un token durable. L'app appelle ensuite
   `GET /organizers/<org>/openpos/` pour ne proposer que les événements où Open
   POS est réellement activé (un device peut avoir accès à un événement sans que
   l'organisateur y ait ouvert de caisse). Un seul résultat → sélection
   automatique. Le tout est rangé dans `localStorage` sous `openpos.pairing.v1`.
2. **Chargement** — `config/` et `catalog/` en parallèle. Un 401/403 (device
   révoqué ou supprimé) renvoie l'opérateur à l'écran d'appairage plutôt que de
   le laisser devant une erreur qu'il ne peut pas résoudre.
3. **Panier** — les montants sont manipulés en **centimes entiers** côté client,
   jamais en flottants. Les quantités sont plafonnées par le stock restant quand
   le quota est fini.
4. **Paiement** — l'ouverture du panneau **frappe la clé d'idempotence**. Le pavé
   numérique se lit en centimes : taper 1-2-3-4 signifie 12,34 €, il n'y a pas de
   virgule à rater dans la file. Boutons d'appoint : *Compte juste*, 5, 10, 20, 50.
   Le rendu de monnaie s'affiche en direct.
5. **Envoi** — `POST checkout/` avec la clé, les lignes, le type de paiement, le
   montant reçu, le nom du caissier et `expected_total`.

### 4.2 Côté serveur

[api/views.py](../pretix_openpos/api/views.py), méthode `checkout()` :

```
1.  Rejeu ?           PosSale avec cette clé d'idempotence ?
                      → oui : renvoyer la vente d'origine, 200, replayed=true. Fin.

2.  Résolution        Chaque ligne doit être un produit filter_available(channel=openpos).
                      Variante inconnue/inactive → 400. Produit à variantes sans
                      variante → 400.

3.  Tarification      resolve_price() : surcharge PosPrice, sinon prix variante,
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

**Le pointage est forcé** (`force=True`, `questions_supported=False`) : le client
est devant vous et vient de payer, une question obligatoire ne doit pas bloquer
la porte.

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
- **Verdict lisible à bout de bras** : vert 1,5 s, rouge 6 s. Un même code est
  ignoré pendant 3 s pour qu'un billet resté dans le champ ne soit pas lu dix fois.
- **L'appel est celui de pretix** (`checkinrpc/redeem`), pas un endpoint maison :
  le moteur de règles, les secrets révoqués ou bloqués et les motifs de refus
  exacts viennent de pretix plutôt que d'une réimplémentation qui dériverait.
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

---

## 6. Les garde-fous

### 6.1 Le serveur est seul maître des prix

`CheckoutSerializer` n'accepte **pas** de champ prix
([api/serializers.py](../pretix_openpos/api/serializers.py)). Une app trafiquée ou
simplement périmée ne peut pas vendre un billet à 40 € pour 4 €.

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

### 6.3 L'idempotence

La clé est frappée à l'ouverture du panneau de paiement et réutilisée pour chaque
tentative. Elle est unique par événement en base. Un réseau capricieux ou un
double appui ne peuvent donc pas vendre deux fois les mêmes billets : la seconde
requête retrouve la vente et renvoie la commande d'origine avec `replayed: true`.

C'est la façon la plus courante pour une caisse maison de perdre de l'argent.

### 6.4 Le journal chaîné

Chaque ligne stocke le hash de la précédente. Modifier une vente ancienne
invalide le hash de toutes les suivantes, et `PosSale.verify_chain()` désigne la
première ligne qui ne tombe plus juste. Le résultat est affiché en haut de
l'écran *Ventes* : une chaîne cassée est visible, pas silencieusement acceptée.

Le hash porte sur : `seq`, événement, date, série du device, caissier, code de
commande, type de paiement, total, reçu, rendu, positions, hash précédent — et,
depuis la version 2, `testmode`. `device_name` n'est **pas** haché : c'est la
série qui identifie une caisse, le nom n'est qu'un libellé de rapport.

**Pourquoi `hash_version`.** Une chaîne de hachage ne s'étend pas sur place :
ajouter un champ à la charge hachée invaliderait toutes les lignes écrites avant,
et `verify_chain()` signalerait une falsification sur un journal intact. La charge
est donc versionnée, chaque ligne mémorise sa version, et la vérification rejoue
la forme sous laquelle la ligne a réellement été hachée.

### 6.5 Le mode test ne se mélange pas à la recette

`testmode` est enregistré **au moment de l'écriture**, pas lu depuis la commande —
parce que c'est précisément la commande qui disparaît : désactiver le mode test
propose de supprimer toutes les commandes de test, ce qui laisserait la ligne de
journal orpheline. Déduire « orpheline = test » après coup ferait silencieusement
sortir des recettes une vraie commande supprimée à la main, soit exactement ce
qu'un journal en ajout seul existe pour empêcher.

Conséquence : les ventes de test restent dans le journal, sont **exclues** du
relevé sur lequel on compte le tiroir, et sont affichées sur une ligne à part.

### 6.6 La surface d'attaque du token

Voir §2.3. En complément : le token est dans `localStorage`, l'app se dépaire
depuis *Réglages* (bouton rouge, avec la série affichée), et le device se révoque
côté organisateur — ce qui renvoie la tablette à l'écran d'appairage au prochain
chargement.

---

## 7. Au quotidien

### 7.1 Sur la caisse

*Réglages* (⚙) contient :

- le **choix de l'événement**, si le device en voit plusieurs ;
- le **nom du caissier**, mémorisé sur l'appareil, joint à chaque vente ;
- le **relevé du jour** : nombre de ventes, espèces, carte, total — pour cette
  caisse et pour l'événement entier. La journée commence à minuit **dans le
  fuseau de l'événement** ;
- *Recharger* et *Dépairer*.

C'est l'alternative légère à une vraie session de caisse : pas de fonds de
caisse, pas de comptage aveugle, juste ce qui est passé depuis minuit pour qu'un
bénévole rapproche le tiroir en fin de soirée.

### 7.2 Dans le back-office

*Open POS → Ventes* affiche le journal (100 lignes par page, plus récent
d'abord), les recettes **ventilées par caisse et par caissier**, le total, la
ligne mode test séparée, et l'état de la chaîne d'intégrité.

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
| `GET` | `/organizers/<org>/openpos/` | Événements vendables par cette caisse |
| `GET` | `/organizers/<org>/events/<ev>/openpos/config/` | Événement, device, listes de contrôle, coupures |
| `GET` | `…/openpos/catalog/` | Catalogue par catégorie, prix sur place, stock restant |
| `POST` | `…/openpos/checkout/` | Encaissement |
| `GET` | `…/openpos/summary/` | Relevé du jour |
| `GET` | `…/openpos/attendance/?list=<id>` | Présents sur place, sur une liste de contrôle |
| `POST` | `/organizers/<org>/checkinrpc/redeem/` | Pointage (endpoint pretix natif) |
| `GET` | `/organizers/<org>/checkinrpc/search/` | Recherche de participant (natif) |

Tout appel sur un événement où le plugin n'est pas activé est refusé en 403, quel
que soit l'accès du device : c'est ce qui empêche une app périmée de vendre sur
un événement pour lequel l'organisateur n'a jamais ouvert de caisse.

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
lignes. `cash_given` n'est accepté que pour un paiement en espèces.

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
  "checkin_errors": []
}
```

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
  ]
}
```

`inside + exited == entered` et `entered + not_arrived == expected`, toujours :
les quatre chiffres sont tirés de la même population. `list` est facultatif dans
la requête et retombe alors sur la liste configurée pour la caisse ; une liste
inconnue est un 400, pas un repli silencieux sur une autre porte.

### Erreurs utiles

| Statut | Cas | Ce que fait l'app |
|---|---|---|
| 400 `price_changed` | Les prix ont bougé sous le panier | Recharge le catalogue, re-tarife, garde le panneau ouvert |
| 400 `positions` | Produit non vendable au guichet / variante inconnue | Affiche le message tel quel |
| 400 `cash_given` | Reçu inférieur au dû | Affiche le message |
| 401 / 403 | Device révoqué, ou plugin désactivé sur l'événement | Retour à l'écran d'appairage |

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

### Les trois scripts de vérification

| Script | Ce qu'il couvre |
|---|---|
| [`dev/smoke_test.py`](../dev/smoke_test.py) | Bout en bout de l'API : appairage, catalogue, vente espèces, rejeu à l'identique pour prouver l'idempotence, relevé. Bibliothèque standard uniquement |
| [`dev/backoffice_test.py`](../dev/backoffice_test.py) | Rend les pages du back-office que le plugin touche, chacune avec la permission exacte qu'elle déclare |
| [`dev/concurrency_test.py`](../dev/concurrency_test.py) | Martèle la caisse depuis plusieurs fils et vérifie que le journal tient : tout committé, séquence sans trou ni doublon, pas deux ventes sur une même commande. À lancer sur PostgreSQL |

`OPENPOS_BASE` permet de viser une autre instance que la pile de dev SQLite.

---

## 10. Dépannage

| Symptôme | Cause probable |
|---|---|
| L'app affiche les instructions d'installation alors qu'elle est installée | Le navigateur signale mal son mode d'affichage. Ouvrir une fois `/openpos/?browser=1` |
| 500 sur le JavaScript de la caisse après déploiement | Image construite sans `npm run build` préalable |
| L'image refuse de démarrer sur le cluster | Image arm64 sur un nœud amd64 : rebâtir avec `--platform linux/amd64` |
| Aucun produit dans le catalogue | Canal **Open POS** non coché sur les produits, ou produits sans quota disponible |
| L'événement n'apparaît pas au moment de l'appairage | Plugin non activé sur l'événement, ou événement non *live*, ou device sans accès |
| « Faites entrer » ne s'affiche jamais | Aucune liste de contrôle choisie dans *Open POS → Réglages*, ou aucun produit d'admission dans la vente |
| Un billet refuse de se scanner | Code-barres non-QR : passer par la recherche par nom ou une douchette clavier |
| La caméra ne démarre pas | Contexte non sécurisé (HTTP), ou autorisation refusée dans les réglages du navigateur |
| Le relevé ne correspond pas au tiroir | Vérifier la ligne « mode test » sur l'écran *Ventes* : elle est comptée à part |
| L'app reste sur un vieux build | Le service worker n'est jamais mis en cache, mais fermer et rouvrir l'app force la reprise |

---

## 11. Ce qui n'existe pas

Rappel, parce que c'est la première question qu'on se pose en incident :

pas de **mode hors ligne** (chaque vente exige le serveur), pas de
**remboursement ni d'annulation** depuis la caisse (à faire dans le back-office),
pas d'**impression** de reçu ni de billet, pas de **questions au contrôle**, pas
de **Tap to Pay** (Stripe ne l'expose que par ses SDK natifs), et **aucune
certification fiscale** — le journal est conçu pour qu'un travail de conformité
reste possible, mais aucune revendication n'est faite sur les législations
française, allemande ou autrichienne sur les caisses enregistreuses.

La suite envisagée est décrite dans la [feuille de route du README](../README.md#roadmap).
