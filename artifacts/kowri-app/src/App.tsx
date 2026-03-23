import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
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
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component, params }: { component: React.ComponentType<any>; params?: any }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <Component params={params} />;
}

function AppRouter() {
  const { isAuthenticated } = useAuth();

  return (
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
      <Route path="/">
        {() => isAuthenticated ? <Redirect to="/dashboard" /> : <Redirect to="/login" />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRouter />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
