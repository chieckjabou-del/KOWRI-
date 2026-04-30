import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { trackCriticalError } from "@/lib/frontendMonitor";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  private domRecoveryAttempted = false;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
    trackCriticalError(error instanceof Error ? error.message : String(error), "ErrorBoundary");

    const msg = String(error?.message ?? "");
    const isDomReconcileError =
      msg.includes("insertBefore") ||
      msg.includes("removeChild") ||
      msg.includes("not a child of this node");

    // Mobile webviews may surface transient DOM mismatch errors.
    // Try one controlled remount before showing the fallback screen.
    if (isDomReconcileError && !this.domRecoveryAttempted) {
      this.domRecoveryAttempted = true;
      this.setState({
        hasError: false,
        error: null,
      });
    }
  }

  handleReset = () => {
    this.domRecoveryAttempted = false;
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <ErrorScreen
          message={this.state.error?.message ?? "Une erreur inattendue s'est produite"}
          onRetry={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

export function ErrorScreen({
  message = "Une erreur s'est produite",
  onRetry,
  showHome = false,
}: {
  message?: string;
  onRetry?: () => void;
  showHome?: boolean;
}) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "#FAFAF8" }}
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
        style={{ background: "#FEF2F2" }}
      >
        <AlertTriangle className="w-8 h-8" style={{ color: "#DC2626" }} />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Oops !</h2>
      <p className="text-sm text-gray-500 max-w-xs leading-relaxed mb-8">{message}</p>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl font-semibold text-white text-sm"
            style={{ background: "#1A6B32" }}
          >
            <RefreshCw className="w-4 h-4" />
            Réessayer
          </button>
        )}
        {showHome && (
          <button
            onClick={() => (window.location.href = "/")}
            className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl font-semibold text-gray-700 text-sm border border-gray-200 bg-white"
          >
            <Home className="w-4 h-4" />
            Retour à l'accueil
          </button>
        )}
      </div>
    </div>
  );
}

export function LoadingScreen({ message = "Chargement…" }: { message?: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{ background: "#FAFAF8" }}
    >
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: "linear-gradient(160deg, #1A6B32 0%, #2D9148 100%)" }}
        >
          <span className="text-white text-xl font-black">K</span>
        </div>
        <div className="flex gap-1.5 mt-2">
          <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#1A6B32", animationDelay: "0ms" }} />
          <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#1A6B32", animationDelay: "150ms" }} />
          <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#1A6B32", animationDelay: "300ms" }} />
        </div>
        <p className="text-sm text-gray-500 mt-1">{message}</p>
      </div>
    </div>
  );
}

export function ApiErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
        style={{ background: "#FEF2F2" }}
      >
        <AlertTriangle className="w-6 h-6" style={{ color: "#DC2626" }} />
      </div>
      <p className="text-sm font-medium text-gray-700 mb-1">Impossible de charger</p>
      <p className="text-xs text-gray-400 max-w-xs leading-relaxed mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white"
          style={{ background: "#1A6B32" }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Réessayer
        </button>
      )}
    </div>
  );
}
