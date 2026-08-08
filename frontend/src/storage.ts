import type { Pairing } from "./types";

const PAIRING_KEY = "openpos.pairing.v1";
const CASHIER_KEY = "openpos.cashier.v1";

export function loadPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pairing;
    if (!parsed.token || !parsed.organizer || !parsed.event) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePairing(pairing: Pairing): void {
  localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

export function clearPairing(): void {
  localStorage.removeItem(PAIRING_KEY);
}

export function loadCashier(): string {
  return localStorage.getItem(CASHIER_KEY) ?? "";
}

export function saveCashier(name: string): void {
  localStorage.setItem(CASHIER_KEY, name);
}
