import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Copy, Check, RefreshCw, FlaskConical, Wallet, CreditCard } from "lucide-react";
import { RequestBuilder } from "@/components/RequestBuilder";
import { getDevSession, devApiFetch } from "@/lib/devAuth";
import { useToast } from "@/hooks/use-toast";

interface SandboxConfig {
  environment: string;
  description: string;
  testWallets: { id: string; currency: string; balance: number; label: string }[];
  testCards: { number: string; result: string }[];
  webhookTestEndpoint: string;
  note: string;
}

const ENDPOINT_SUGGESTIONS = [
  "/wallet/balance", "/wallet/create", "/wallet/transfer",
  "/wallet/transactions", "/merchant/create", "/merchant/payment",
  "/fx/rates/EUR/XOF", "/fx/rates/USD/XOF", "/analytics/overview",
];

export default function DeveloperSandbox() {
  const session = getDevSession();
  const { toast } = useToast();
  const [showReset, setShowReset] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["dev-sandbox"],
    queryFn: () => devApiFetch<SandboxConfig>("/developer/sandbox"),
  });

  const resetMutation = useMutation({
    mutationFn: () => devApiFetch<{ reset: boolean; message: string }>(
      "/developer/sandbox/reset",
      session?.token,
      { method: "POST", body: JSON.stringify({ developerId: session?.developerId }) }
    ),
    onSuccess: (res) => {
      setShowReset(false);
      toast({ title: "Sandbox réinitialisé ✅", description: res.message });
    },
    onError: (e: any) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const handleCopyId = async (id: string) => {
    await navigator.clipboard.writeText(id).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatBalance = (balance: number, currency: string) => {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency, minimumFractionDigits: 0 }).format(balance);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Sandbox</h1>
          <p className="text-muted-foreground mt-1">Environnement de test — aucune transaction réelle</p>
        </div>
        <Button variant="outline" className="gap-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
          onClick={() => setShowReset(true)}>
          <RefreshCw className="w-4 h-4" /> Réinitialiser le sandbox
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : data && (
        <>
          {/* Sandbox info card */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="p-6 bg-amber-500/5 border-amber-500/30">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                  <FlaskConical className="w-5 h-5 text-amber-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-foreground">Environnement Sandbox</span>
                    <Badge variant="outline" className="border-amber-500/30 text-amber-400 bg-amber-500/10 text-xs">SANDBOX</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">{data.description}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Base URL :</span>
                    <code className="text-xs font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                      {data.environment === "sandbox" ? "https://sandbox.kowri.io/v1" : "https://api.kowri.io/v1"}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground/70 mt-2">{data.note}</p>
                </div>
              </div>
            </Card>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Test wallets */}
            <Card className="p-5 bg-secondary/20 border-border/40">
              <div className="flex items-center gap-2 mb-4">
                <Wallet className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">Wallets de test</h2>
              </div>
              <div className="space-y-3">
                {data.testWallets.map(wallet => (
                  <div key={wallet.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/30">
                    <div>
                      <div className="text-sm font-medium text-foreground">{wallet.label}</div>
                      <code className="text-xs font-mono text-muted-foreground">{wallet.id}</code>
                      <div className="text-sm font-bold text-primary mt-0.5">
                        {formatBalance(wallet.balance, wallet.currency)}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 shrink-0"
                      onClick={() => handleCopyId(wallet.id)}>
                      {copiedId === wallet.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      Copier l'ID
                    </Button>
                  </div>
                ))}
              </div>
            </Card>

            {/* Test cards */}
            <Card className="p-5 bg-secondary/20 border-border/40">
              <div className="flex items-center gap-2 mb-4">
                <CreditCard className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">Cartes de test</h2>
              </div>
              <div className="space-y-3">
                {data.testCards.map(card => (
                  <div key={card.number} className="p-3 rounded-lg bg-secondary/30 border border-border/30">
                    <div className="flex items-center justify-between">
                      <code className="text-sm font-mono text-foreground">{card.number}</code>
                      <Badge variant="outline" className={`text-xs ${
                        card.result === "success"
                          ? "border-green-500/30 text-green-400 bg-green-500/10"
                          : "border-red-500/30 text-red-400 bg-red-500/10"
                      }`}>
                        {card.result}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Request builder */}
          <Card className="p-5 bg-secondary/20 border-border/40">
            <h2 className="font-semibold mb-4">Constructeur de requêtes</h2>
            <RequestBuilder
              baseUrl="/api"
              apiKey=""
              suggestions={ENDPOINT_SUGGESTIONS}
              defaultEndpoint="/fx/rates/EUR/XOF"
            />
          </Card>
        </>
      )}

      {/* Reset confirmation */}
      <Dialog open={showReset} onOpenChange={setShowReset}>
        <DialogContent className="bg-background border-border/50">
          <DialogHeader>
            <DialogTitle className="text-amber-400">Réinitialiser le sandbox ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Toutes les données de test seront supprimées et les wallets restaurés à leurs balances initiales.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReset(false)}>Annuler</Button>
            <Button className="bg-amber-600 hover:bg-amber-700 text-white gap-2"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}>
              {resetMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Réinitialiser
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
