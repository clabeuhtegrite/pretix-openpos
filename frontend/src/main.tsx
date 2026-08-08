import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered from /openpos/sw.js rather than the static bundle so the worker's
// scope covers the app URL. Failure is non-fatal: the till is online-only by
// design and the worker only buys a faster cold start.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/openpos/sw.js", { scope: "/openpos/" }).catch(() => {});
  });
}
