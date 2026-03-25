import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "./components/layout";
import NotFound from "@/pages/not-found";

// War Room pages
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

// Developer portal pages
import Developer from "./pages/Developer";
import DeveloperDashboard from "./pages/DeveloperDashboard";
import DeveloperUsage from "./pages/DeveloperUsage";
import DeveloperDocs from "./pages/DeveloperDocs";
import DeveloperSandbox from "./pages/DeveloperSandbox";
import DeveloperWebhooks from "./pages/DeveloperWebhooks";

// Admin pages
import Admin from "./pages/Admin";
import AdminKYC from "./pages/AdminKYC";
import AdminAML from "./pages/AdminAML";
import AdminFees from "./pages/AdminFees";
import AdminUsers from "./pages/AdminUsers";
import AdminAnalytics from "./pages/AdminAnalytics";
import AdminSupport from "./pages/AdminSupport";
import AdminAgents from "./pages/AdminAgents";

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
      {/* Main dashboard routes */}
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

      {/* Developer portal routes */}
      <Route path="/developer" component={Developer} />
      <Route path="/developer/dashboard" component={DeveloperDashboard} />
      <Route path="/developer/keys" component={DeveloperDashboard} />
      <Route path="/developer/usage" component={DeveloperUsage} />
      <Route path="/developer/docs" component={DeveloperDocs} />
      <Route path="/developer/sandbox" component={DeveloperSandbox} />
      <Route path="/developer/webhooks" component={DeveloperWebhooks} />

      {/* Admin routes */}
      <Route path="/admin" component={Admin} />
      <Route path="/admin/kyc" component={AdminKYC} />
      <Route path="/admin/aml" component={AdminAML} />
      <Route path="/admin/fees" component={AdminFees} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/admin/analytics" component={AdminAnalytics} />
      <Route path="/admin/support" component={AdminSupport} />
      <Route path="/admin/agents" component={AdminAgents} />

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
