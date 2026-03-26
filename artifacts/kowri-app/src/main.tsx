import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

function mount() {
  const rootEl = document.getElementById("root");
  if (!rootEl) {
    console.error("[KOWRI] Élément #root introuvable dans le DOM.");
    return;
  }
  createRoot(rootEl).render(<App />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
