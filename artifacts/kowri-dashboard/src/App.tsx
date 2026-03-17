import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "./components/layout";
import NotFound from "@/pages/not-found";

// Pages
import Dashboard from "./pages/dashboard";
import Users from "./pages/users";
import Wallets from "./pages/wallets";
import Transactions from "./pages/transactions";
import Tontines from "./pages/tontines";
import Credit from "./pages/credit";
import Merchants from "./pages/merchants";
import Compliance from "./pages/compliance";
import Ledger from "./pages/ledger";
import WarRoom from "./pages/war-room";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30000,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/war-room" component={WarRoom} />
      <Route path="/users" component={Users} />
      <Route path="/wallets" component={Wallets} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/tontines" component={Tontines} />
      <Route path="/credit" component={Credit} />
      <Route path="/merchants" component={Merchants} />
      <Route path="/compliance" component={Compliance} />
      <Route path="/ledger" component={Ledger} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Layout>
            <Router />
          </Layout>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
