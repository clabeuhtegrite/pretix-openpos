import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import { applyTheme, loadTheme } from "./theme";

// Before the first render rather than from inside it: a till told explicitly
// to be light would otherwise open dark for as long as React takes to mount.
applyTheme(loadTheme());

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered from /openpos/sw.js rather than the static bundle so the worker's
// scope covers the app URL. It is what lets a till start with no network, or
// while the server restarts, and what brings a new build in before the page
// reloads onto it (update.ts). Failure is still non-fatal: without it the till
// starts only when the server answers, and an update is a plain reload.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/openpos/sw.js", { scope: "/openpos/" }).catch(() => {});
  });
}
