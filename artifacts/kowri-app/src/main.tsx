import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const DOM_RECOVERY_ERROR_PATTERNS = [
  "Failed to execute 'insertBefore' on 'Node'",
  "Failed to execute 'removeChild' on 'Node'",
  "The node before which the new node is to be inserted is not a child of this node",
];

let hasAttemptedDomRecovery = false;

function shouldAttemptDomRecovery(message: string): boolean {
  return DOM_RECOVERY_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function installDomRecoveryGuards() {
  const recover = () => {
    if (hasAttemptedDomRecovery) return;
    hasAttemptedDomRecovery = true;
    window.setTimeout(() => window.location.reload(), 50);
  };

  window.addEventListener("error", (event) => {
    const message = event.error?.message ?? event.message ?? "";
    if (typeof message === "string" && shouldAttemptDomRecovery(message)) {
      recover();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reasonMessage =
      typeof event.reason === "string"
        ? event.reason
        : event.reason?.message ?? "";
    if (typeof reasonMessage === "string" && shouldAttemptDomRecovery(reasonMessage)) {
      recover();
    }
  });
}

installDomRecoveryGuards();

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
