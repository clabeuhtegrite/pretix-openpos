/**
 * Minimal message catalogue.
 *
 * Deliberately not a full i18n library: a till has a few dozen strings, and a
 * dependency-free lookup keeps the bundle small and the build trivial.
 */
const MESSAGES = {
  en: {
    "app.title": "Open POS",
    "pairing.title": "Pair this till",
    "pairing.intro":
      "Create a device in your pretix organizer settings with the “Open POS” security profile, then paste its pairing code below.",
    "pairing.token": "Pairing code",
    "pairing.tokenHelp": "Paste the code, or the whole QR code contents.",
    "pairing.submit": "Pair",
    "pairing.pairing": "Pairing…",
    "pairing.chooseEvent": "Choose the event",
    "pairing.noEvents": "This device has access to no live event.",
    "pairing.retry": "Try again",
    "sale.cart": "Basket",
    "sale.empty": "Nothing in the basket yet.",
    "sale.total": "Total",
    "sale.charge": "Take payment",
    "sale.clear": "Clear",
    "sale.soldOut": "Sold out",
    "sale.left": "{n} left",
    "payment.title": "Take payment",
    "payment.cash": "Cash",
    "payment.card": "Card",
    "payment.due": "Due",
    "payment.received": "Received",
    "payment.change": "Change",
    "payment.exact": "Exact",
    "payment.cardPrompt": "Charge the customer on the card terminal, then confirm.",
    "payment.cardConfirm": "Payment taken",
    "payment.confirm": "Confirm",
    "payment.back": "Back",
    "payment.working": "Recording…",
    "done.admitted": "Let them in",
    "done.sold": "Sale recorded",
    "done.change": "Change to give",
    "done.order": "Order",
    "done.next": "Next customer",
    "done.checkinFailed": "Check-in failed — let the customer in manually.",
    "summary.title": "Takings today",
    "summary.thisTill": "This till",
    "summary.allTills": "All tills",
    "summary.sales": "Sales",
    "summary.cash": "Cash",
    "summary.card": "Card",
    "summary.total": "Total",
    "settings.title": "Settings",
    "settings.cashier": "Cashier name",
    "settings.cashierHelp": "Shown in the takings report, so shared tills can still be reconciled.",
    "settings.unpair": "Unpair this till",
    "settings.unpairConfirm": "Unpair this till? You will need a new pairing code.",
    "settings.close": "Close",
    "settings.refresh": "Reload catalogue",
    "error.offline": "No connection to the server.",
    "error.retry": "Retry",
    "error.title": "Something went wrong",
    "testmode": "TEST MODE",
  },
  fr: {
    "app.title": "Open POS",
    "pairing.title": "Appairer cette caisse",
    "pairing.intro":
      "Créez un appareil dans les réglages de votre organisateur pretix avec le profil de sécurité « Open POS », puis collez son code d’appairage ci-dessous.",
    "pairing.token": "Code d’appairage",
    "pairing.tokenHelp": "Collez le code, ou le contenu complet du QR code.",
    "pairing.submit": "Appairer",
    "pairing.pairing": "Appairage…",
    "pairing.chooseEvent": "Choisissez l’événement",
    "pairing.noEvents": "Cet appareil n’a accès à aucun événement en ligne.",
    "pairing.retry": "Réessayer",
    "sale.cart": "Panier",
    "sale.empty": "Panier vide.",
    "sale.total": "Total",
    "sale.charge": "Encaisser",
    "sale.clear": "Vider",
    "sale.soldOut": "Épuisé",
    "sale.left": "{n} restants",
    "payment.title": "Encaissement",
    "payment.cash": "Espèces",
    "payment.card": "Carte",
    "payment.due": "À payer",
    "payment.received": "Reçu",
    "payment.change": "Rendu",
    "payment.exact": "Appoint",
    "payment.cardPrompt": "Encaissez le client sur le TPE, puis confirmez.",
    "payment.cardConfirm": "Paiement encaissé",
    "payment.confirm": "Valider",
    "payment.back": "Retour",
    "payment.working": "Enregistrement…",
    "done.admitted": "Laissez entrer",
    "done.sold": "Vente enregistrée",
    "done.change": "Rendre",
    "done.order": "Commande",
    "done.next": "Client suivant",
    "done.checkinFailed": "Check-in échoué — faites entrer le client manuellement.",
    "summary.title": "Recettes du jour",
    "summary.thisTill": "Cette caisse",
    "summary.allTills": "Toutes les caisses",
    "summary.sales": "Ventes",
    "summary.cash": "Espèces",
    "summary.card": "Carte",
    "summary.total": "Total",
    "settings.title": "Réglages",
    "settings.cashier": "Nom du caissier",
    "settings.cashierHelp":
      "Affiché dans le rapport de recettes, pour pouvoir répartir une caisse partagée.",
    "settings.unpair": "Désappairer cette caisse",
    "settings.unpairConfirm": "Désappairer cette caisse ? Il faudra un nouveau code d’appairage.",
    "settings.close": "Fermer",
    "settings.refresh": "Recharger le catalogue",
    "error.offline": "Pas de connexion au serveur.",
    "error.retry": "Réessayer",
    "error.title": "Une erreur est survenue",
    "testmode": "MODE TEST",
  },
} as const;

type Catalogue = typeof MESSAGES.en;
export type MessageKey = keyof Catalogue;

const language: keyof typeof MESSAGES =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr")
    ? "fr"
    : "en";

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let message: string = MESSAGES[language][key] ?? MESSAGES.en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replace(`{${name}}`, String(value));
    }
  }
  return message;
}

export const locale = language;
