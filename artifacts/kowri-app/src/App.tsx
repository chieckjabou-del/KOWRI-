import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { OfflineBanner } from "@/components/OfflineBanner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { setUnauthorizedHandler, ApiError } from "@/lib/api";
import { ErrorBoundary, LoadingScreen } from "@/components/ErrorFallback";
import { useToast } from "@/hooks/use-toast";

/* ─── Page skeleton (suspense fallback) ────────────────────────── */
function PageSkeleton() {
  return (
    <div className="min-h-screen" style={{ background: "#FAFAF8" }}>
      <div className="h-14 bg-white border-b border-gray-100 animate-pulse" />
      <div className="px-4 pt-5 max-w-lg mx-auto space-y-4">
        <div className="h-6 w-48 bg-gray-200 rounded-xl animate-pulse" />
        <div className="h-44 bg-gray-200 rounded-3xl animate-pulse" />
        <div className="h-32 bg-gray-200 rounded-2xl animate-pulse" />
        <div className="h-24 bg-gray-200 rounded-2xl animate-pulse" />
      </div>
    </div>
  );
}

/* ─── Lazy pages ────────────────────────────────────────────────── */
const Login         = lazy(() => import("@/pages/Login"));
const Register      = lazy(() => import("@/pages/Register"));
const Dashboard     = lazy(() => import("@/pages/Dashboard"));
const Tontines      = lazy(() => import("@/pages/Tontines"));
const TontineCreate = lazy(() => import("@/pages/TontineCreate"));
const TontineDetail = lazy(() => import("@/pages/TontineDetail"));
const Send          = lazy(() => import("@/pages/Send"));
const Profile       = lazy(() => import("@/pages/Profile"));
const Credit        = lazy(() => import("@/pages/Credit"));
const Savings       = lazy(() => import("@/pages/Savings"));
const Diaspora      = lazy(() => import("@/pages/Diaspora"));
const Merchant      = lazy(() => import("@/pages/Merchant"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const KYC           = lazy(() => import("@/pages/KYC"));
const AgentPage     = lazy(() => import("@/pages/Agent"));
const Invest        = lazy(() => import("@/pages/Invest"));
const InvestDetail  = lazy(() => import("@/pages/InvestDetail"));
const Insurance     = lazy(() => import("@/pages/Insurance"));
const Creator       = lazy(() => import("@/pages/Creator"));
const CreatorDetail = lazy(() => import("@/pages/CreatorDetail"));
const Support       = lazy(() => import("@/pages/Support"));
const NotFound      = lazy(() => import("@/pages/not-found"));

/* ─── Query client ──────────────────────────────────────────────── */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 300_000,
    },
  },
});

/* ─── Protected route ───────────────────────────────────────────── */
function ProtectedRoute({ component: Component, params }: { component: React.ComponentType<any>; params?: any }) {
  const { isAuthenticated, isHydrating } = useAuth();
  return (
    <div id="kowri-protected">
      {isHydrating ? (
        <LoadingScreen message="Vérification de la session…" />
      ) : !isAuthenticated ? (
        <Redirect to="/login" />
      ) : (
        <ErrorBoundary>
          <Suspense fallback={<PageSkeleton />}>
            <Component params={params} />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/* ─── Auth gate (registers 401 handler) ────────────────────────── */
function AuthGate() {
  const { clearAuth } = useAuth();
  const [, navigate]  = useLocation();
  const { toast }     = useToast();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearAuth();
      queryClient.clear();
      toast({ title: "Session expirée", description: "Reconnectez-vous pour continuer.", variant: "destructive" });
      navigate("/login");
    });
    return () => setUnauthorizedHandler(() => {});
  }, [clearAuth, navigate, toast]);

  return null;
}

/* ─── Suspense wrapper for public pages ─────────────────────────── */
function PublicPage({ Page }: { Page: React.ComponentType }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Page />
    </Suspense>
  );
}

/* ─── Router ────────────────────────────────────────────────────── */
function AppRouter() {
  const { isAuthenticated, isHydrating } = useAuth();

  return (
    <div id="kowri-root">
      {isHydrating ? (
        <LoadingScreen message="Démarrage de KOWRI…" />
      ) : (
        <>
          <AuthGate />
          <Switch>
        {/* Public routes — each with its own isolated Suspense */}
        <Route path="/login">
          {() => <PublicPage Page={Login} />}
        </Route>
        <Route path="/register">
          {() => <PublicPage Page={Register} />}
        </Route>

        {/* Protected routes — Suspense lives inside ProtectedRoute */}
        <Route path="/dashboard">
          {() => <ProtectedRoute component={Dashboard} />}
        </Route>
        <Route path="/tontines/create">
          {() => <ProtectedRoute component={TontineCreate} />}
        </Route>
        <Route path="/tontines/:id">
          {(params) => <ProtectedRoute component={TontineDetail} params={params} />}
        </Route>
        <Route path="/tontines">
          {() => <ProtectedRoute component={Tontines} />}
        </Route>
        <Route path="/send">
          {() => <ProtectedRoute component={Send} />}
        </Route>
        <Route path="/profile">
          {() => <ProtectedRoute component={Profile} />}
        </Route>
        <Route path="/credit">
          {() => <ProtectedRoute component={Credit} />}
        </Route>
        <Route path="/savings">
          {() => <ProtectedRoute component={Savings} />}
        </Route>
        <Route path="/diaspora">
          {() => <ProtectedRoute component={Diaspora} />}
        </Route>
        <Route path="/merchant">
          {() => <ProtectedRoute component={Merchant} />}
        </Route>
        <Route path="/notifications">
          {() => <ProtectedRoute component={Notifications} />}
        </Route>
        <Route path="/kyc">
          {() => <ProtectedRoute component={KYC} />}
        </Route>
        <Route path="/agent">
          {() => <ProtectedRoute component={AgentPage} />}
        </Route>
        <Route path="/invest/:id">
          {(params) => <ProtectedRoute component={InvestDetail} params={params} />}
        </Route>
        <Route path="/invest">
          {() => <ProtectedRoute component={Invest} />}
        </Route>
        <Route path="/insurance">
          {() => <ProtectedRoute component={Insurance} />}
        </Route>
        <Route path="/creator/:id">
          {(params) => <ProtectedRoute component={CreatorDetail} params={params} />}
        </Route>
        <Route path="/creator">
          {() => <ProtectedRoute component={Creator} />}
        </Route>
        <Route path="/support">
          {() => <ProtectedRoute component={Support} />}
        </Route>

        {/* Root redirect */}
        <Route path="/">
          {() => isAuthenticated ? <Redirect to="/dashboard" /> : <Redirect to="/login" />}
        </Route>

        {/* 404 */}
        <Route>
          {() => <PublicPage Page={NotFound} />}
        </Route>
          </Switch>
        </>
      )}
    </div>
  );
}

/* ─── App root ──────────────────────────────────────────────────── */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <AuthProvider>
            <OfflineBanner />
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRouter />
            </WouterRouter>
            <Toaster />
          </AuthProvider>
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
