import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Activity, TrendingUp, Clock, CheckCircle2, Copy, Check } from "lucide-react";
import { ApiKeyCard } from "@/components/ApiKeyCard";
import { getDevSession, devApiFetch } from "@/lib/devAuth";
import { useToast } from "@/hooks/use-toast";

interface ApiKey {
  id: string; name: string; keyPrefix: string; planTier: string;
  active: boolean; environment: string; scopes: string[];
  requestCount: number; dailyLimit: number; lastUsedAt: string | null; createdAt: string;
}
interface UsageStats {
  keys: { keyId: string; requestCount: number; dailyLimit: number }[];
  totalRequests: number;
  byEndpoint: Record<string, { count: number; avgMs: number; errors: number }>;
}

export default function DeveloperDashboard() {
  const session = getDevSession();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyForm, setNewKeyForm] = useState({ name: "", environment: "sandbox", planTier: "free" });
  const [freshKey, setFreshKey] = useState<{ key: string; keyId: string } | null>(null);
  const [copiedFresh, setCopiedFresh] = useState(false);

  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ["dev-api-keys"],
    queryFn: () => devApiFetch<{ keys: ApiKey[]; count: number }>("/developer/api-keys", session?.token),
    enabled: !!session,
  });

  const { data: usageData } = useQuery({
    queryKey: ["dev-usage", session?.developerId],
    queryFn: () => devApiFetch<UsageStats>(`/developer/usage?developerId=${session?.developerId}`, session?.token),
    enabled: !!session,
  });

  const generateMutation = useMutation({
    mutationFn: () => devApiFetch<{ keyId: string; apiKey: string; prefix: string }>(
      "/developer/api-key",
      session?.token,
      {
        method: "POST",
        body: JSON.stringify({
          developerId: session?.developerId,
          name: newKeyForm.name,
          planTier: newKeyForm.planTier,
          environment: newKeyForm.environment,
        }),
      }
    ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["dev-api-keys"] });
      setShowNewKey(false);
      setFreshKey({ key: data.apiKey, keyId: data.keyId });
      toast({ title: "Clé générée", description: "Copiez-la maintenant — elle ne sera plus affichée." });
    },
    onError: (e: any) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => devApiFetch(
      `/developer/api-key/${keyId}`,
      session?.token,
      { method: "DELETE" }
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-api-keys"] });
      toast({ title: "Clé révoquée" });
    },
  });

  const keys: ApiKey[] = keysData?.keys ?? [];
  const totalRequests = usageData?.totalRequests ?? 0;
  const activeKeys = keys.filter(k => k.active).length;
  const successRate = usageData
    ? (() => {
        const total = Object.values(usageData.byEndpoint).reduce((s, e) => s + e.count, 0);
        const errors = Object.values(usageData.byEndpoint).reduce((s, e) => s + e.errors, 0);
        return total > 0 ? Math.round(((total - errors) / total) * 100) : 100;
      })()
    : 100;
  const avgMs = usageData
    ? (() => {
        const vals = Object.values(usageData.byEndpoint);
        return vals.length > 0 ? Math.round(vals.reduce((s, e) => s + e.avgMs, 0) / vals.length) : 0;
      })()
    : 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Developer Dashboard</h1>
        <p className="text-muted-foreground mt-1">Gérez vos clés API et suivez votre consommation</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Appels aujourd'hui", value: keys.reduce((s, k) => s + k.requestCount, 0).toLocaleString(), icon: Activity, color: "text-blue-400" },
          { label: "Appels ce mois", value: totalRequests.toLocaleString(), icon: TrendingUp, color: "text-violet-400" },
          { label: "Taux de succès", value: `${successRate}%`, icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Latence moyenne", value: avgMs > 0 ? `${avgMs}ms` : "—", icon: Clock, color: "text-amber-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <motion.div key={label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="p-5 bg-secondary/20 border-border/40">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <div className="text-2xl font-bold text-foreground font-mono">{value}</div>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* API Keys */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">Clés API actives</h2>
            <p className="text-sm text-muted-foreground">{activeKeys} clé{activeKeys !== 1 ? "s" : ""} active{activeKeys !== 1 ? "s" : ""}</p>
          </div>
          <Button className="gap-2 bg-primary hover:bg-primary/90" onClick={() => setShowNewKey(true)}>
            <Plus className="w-4 h-4" /> Générer une nouvelle clé
          </Button>
        </div>

        {keysLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : keys.length === 0 ? (
          <Card className="p-8 text-center bg-secondary/10 border-border/30">
            <p className="text-muted-foreground text-sm">Aucune clé API. Générez-en une pour commencer.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {keys.map(key => (
              <ApiKeyCard key={key.id} apiKey={key} onRevoke={id => revokeMutation.mutate(id)} />
            ))}
          </div>
        )}
      </div>

      {/* Generate key modal */}
      <Dialog open={showNewKey} onOpenChange={setShowNewKey}>
        <DialogContent className="bg-background border-border/50 max-w-md">
          <DialogHeader>
            <DialogTitle>Générer une nouvelle clé API</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Nom de la clé</Label>
              <Input value={newKeyForm.name} onChange={e => setNewKeyForm(f => ({ ...f, name: e.target.value }))}
                className="bg-secondary/30 border-border/40" placeholder="Production App v2" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Environnement</Label>
              <Select value={newKeyForm.environment} onValueChange={v => setNewKeyForm(f => ({ ...f, environment: v }))}>
                <SelectTrigger className="bg-secondary/30 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox">
                    <div className="flex items-center gap-2"><Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400">SANDBOX</Badge> Test uniquement</div>
                  </SelectItem>
                  <SelectItem value="production">
                    <div className="flex items-center gap-2"><Badge variant="outline" className="text-xs border-green-500/30 text-green-400">PRODUCTION</Badge> Données réelles</div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Plan</Label>
              <Select value={newKeyForm.planTier} onValueChange={v => setNewKeyForm(f => ({ ...f, planTier: v }))}>
                <SelectTrigger className="bg-secondary/30 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["free", "starter", "growth", "enterprise"].map(p => (
                    <SelectItem key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full bg-primary hover:bg-primary/90"
              onClick={() => generateMutation.mutate()}
              disabled={!newKeyForm.name || generateMutation.isPending}>
              {generateMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Génération...</> : "Générer la clé"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Show new key once */}
      <Dialog open={!!freshKey} onOpenChange={() => setFreshKey(null)}>
        <DialogContent className="bg-background border-border/50 max-w-lg" onPointerDownOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> Clé générée !
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/40">
              <div className="text-xs font-bold text-amber-400 mb-2">⚠️ Copiez cette clé maintenant. Elle ne sera plus affichée.</div>
              <code className="text-xs font-mono text-amber-200 break-all block">{freshKey?.key}</code>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 gap-2" onClick={async () => {
                await navigator.clipboard.writeText(freshKey?.key ?? "").catch(() => {});
                setCopiedFresh(true);
                setTimeout(() => setCopiedFresh(false), 2000);
              }}>
                {copiedFresh ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                {copiedFresh ? "Copié !" : "Copier"}
              </Button>
              <Button className="flex-1 bg-primary hover:bg-primary/90" onClick={() => setFreshKey(null)}>OK, j'ai copié</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
