import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { setUnauthorizedHandler, ApiError } from "@/lib/api";
import { ErrorBoundary, LoadingScreen } from "@/components/ErrorFallback";
import { useToast } from "@/hooks/use-toast";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Tontines from "@/pages/Tontines";
import TontineCreate from "@/pages/TontineCreate";
import TontineDetail from "@/pages/TontineDetail";
import Send from "@/pages/Send";
import Profile from "@/pages/Profile";
import Credit from "@/pages/Credit";
import Savings from "@/pages/Savings";
import Diaspora from "@/pages/Diaspora";
import Merchant from "@/pages/Merchant";
import Notifications from "@/pages/Notifications";
import KYC from "@/pages/KYC";
import AgentPage from "@/pages/Agent";
import Invest from "@/pages/Invest";
import InvestDetail from "@/pages/InvestDetail";
import Insurance from "@/pages/Insurance";
import Creator from "@/pages/Creator";
import CreatorDetail from "@/pages/CreatorDetail";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

function ProtectedRoute({
  component: Component,
  params,
}: {
  component: React.ComponentType<any>;
  params?: any;
}) {
  const { isAuthenticated, isHydrating } = useAuth();
  if (isHydrating) return <LoadingScreen message="Vérification de la session…" />;
  if (!isAuthenticated) return <Redirect to="/login" />;
  return (
    <ErrorBoundary>
      <Component params={params} />
    </ErrorBoundary>
  );
}

function AuthGate() {
  const { clearAuth, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearAuth();
      queryClient.clear();
      toast({
        title: "Session expirée",
        description: "Reconnectez-vous pour continuer.",
        variant: "destructive",
      });
      navigate("/login");
    });
    return () => setUnauthorizedHandler(() => {});
  }, [clearAuth, navigate, toast]);

  return null;
}

function AppRouter() {
  const { isAuthenticated, isHydrating } = useAuth();

  if (isHydrating) {
    return <LoadingScreen message="Démarrage de KOWRI…" />;
  }

  return (
    <>
      <AuthGate />
      <Switch>
        <Route path="/login" component={Login} />
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
        <Route path="/">
          {() =>
            isAuthenticated ? <Redirect to="/dashboard" /> : <Redirect to="/login" />
          }
        </Route>
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <AuthProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRouter />
            </WouterRouter>
          </AuthProvider>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
