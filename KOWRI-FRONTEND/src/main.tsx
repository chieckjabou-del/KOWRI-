import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initSentry, captureException } from "@/lib/sentry";

const DOM_RECOVERY_ERROR_PATTERNS = [
  "Failed to execute 'insertBefore' on 'Node'",
  "Failed to execute 'removeChild' on 'Node'",
  "The node before which the new node is to be inserted is not a child of this node",
];

let hasAttemptedDomRecovery = false;
let hasCapturedFallbackWindowError = false;
let hasCapturedFallbackRejection = false;

function shouldAttemptDomRecovery(message: string): boolean {
  return DOM_RECOVERY_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function installDomRecoveryGuards() {
  const patchDomMutators = () => {
    const nodeProto = Node.prototype as Node & {
      __kowriInsertBeforePatched?: boolean;
      __kowriRemoveChildPatched?: boolean;
    };

    if (!nodeProto.__kowriInsertBeforePatched) {
      const originalInsertBefore = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function <T extends Node>(
        newChild: T,
        refChild: Node | null
      ): T {
        if (refChild && refChild.parentNode !== this) {
          captureException(new Error("Blocked unsafe insertBefore reference"), {
            tags: { source: "dom.insertBefore.guard" },
          });
          return this.appendChild(newChild) as T;
        }
        return originalInsertBefore.call(this, newChild, refChild) as T;
      };
      nodeProto.__kowriInsertBeforePatched = true;
    }

    if (!nodeProto.__kowriRemoveChildPatched) {
      const originalRemoveChild = Node.prototype.removeChild;
      Node.prototype.removeChild = function <T extends Node>(child: T): T {
        if (child.parentNode !== this) {
          captureException(new Error("Blocked unsafe removeChild target"), {
            tags: { source: "dom.removeChild.guard" },
          });
          return child as T;
        }
        return originalRemoveChild.call(this, child) as T;
      };
      nodeProto.__kowriRemoveChildPatched = true;
    }
  };

  patchDomMutators();

  const recover = () => {
    if (hasAttemptedDomRecovery) return;
    hasAttemptedDomRecovery = true;
    captureException(new Error("DOM reconciliation recovery triggered"), {
      tags: { source: "dom-recovery-guard" },
    });
    window.setTimeout(() => window.location.reload(), 50);
  };

  window.addEventListener("error", (event) => {
    const message = event.error?.message ?? event.message ?? "";
    if (event.error) {
      captureException(event.error, {
        tags: { source: "window.error" },
      });
    } else if (message && !hasCapturedFallbackWindowError) {
      hasCapturedFallbackWindowError = true;
      captureException(new Error(message), {
        tags: { source: "window.error.message" },
      });
    }
    if (typeof message === "string" && shouldAttemptDomRecovery(message)) {
      recover();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason) {
      captureException(event.reason, {
        tags: { source: "window.unhandledrejection" },
      });
    } else if (!hasCapturedFallbackRejection) {
      hasCapturedFallbackRejection = true;
      captureException(new Error("Unhandled rejection without reason"), {
        tags: { source: "window.unhandledrejection.empty" },
      });
    }
    const reasonMessage =
      typeof event.reason === "string"
        ? event.reason
        : event.reason?.message ?? "";
    if (typeof reasonMessage === "string" && shouldAttemptDomRecovery(reasonMessage)) {
      recover();
    }
  });
}

initSentry();
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
