import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Copy, Check, Trash2, Clock, Wifi, WifiOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  planTier: string;
  active: boolean;
  environment: string;
  scopes: string[];
  requestCount: number;
  dailyLimit: number;
  lastUsedAt: string | null;
  createdAt: string;
}

interface ApiKeyCardProps {
  apiKey: ApiKey;
  fullKey?: string;
  onRevoke: (id: string) => void;
}

const PLAN_COLORS: Record<string, string> = {
  free:       "bg-slate-500/20 text-slate-300 border-slate-500/30",
  starter:    "bg-blue-500/20 text-blue-300 border-blue-500/30",
  growth:     "bg-violet-500/20 text-violet-300 border-violet-500/30",
  enterprise: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function timeAgo(date: string | null): string {
  if (!date) return "jamais";
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}j`;
}

export function ApiKeyCard({ apiKey, fullKey, onRevoke }: ApiKeyCardProps) {
  const [copied, setCopied] = useState(false);
  const [showRevoke, setShowRevoke] = useState(false);
  const { toast } = useToast();

  const usagePct = Math.min(100, Math.round((apiKey.requestCount / apiKey.dailyLimit) * 100));

  const handleCopy = async () => {
    const keyToCopy = fullKey || apiKey.keyPrefix;
    await navigator.clipboard.writeText(keyToCopy).catch(() => {});
    setCopied(true);
    toast({ title: "Clé copiée", description: "Conservez-la en lieu sûr." });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Card className="p-5 bg-secondary/20 border-border/40 hover:border-border/70 transition-colors">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-sm font-semibold text-foreground">
                {apiKey.keyPrefix.substring(0, 24)}…
              </span>
              <Badge variant="outline" className={`text-xs ${PLAN_COLORS[apiKey.planTier] || PLAN_COLORS.free}`}>
                {apiKey.planTier.toUpperCase()}
              </Badge>
              <Badge variant="outline" className={`text-xs ${
                apiKey.environment === "production"
                  ? "border-green-500/30 text-green-400 bg-green-500/10"
                  : "border-amber-500/30 text-amber-400 bg-amber-500/10"
              }`}>
                {apiKey.environment === "production" ? <Wifi className="w-3 h-3 mr-1 inline" /> : <WifiOff className="w-3 h-3 mr-1 inline" />}
                {apiKey.environment.toUpperCase()}
              </Badge>
              {apiKey.active ? (
                <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-400 bg-emerald-500/10">Actif</Badge>
              ) : (
                <Badge variant="outline" className="text-xs border-red-500/30 text-red-400 bg-red-500/10">Révoqué</Badge>
              )}
            </div>

            <div className="text-xs text-muted-foreground mb-3">{apiKey.name}</div>

            <div className="flex flex-wrap gap-1 mb-3">
              {(apiKey.scopes as string[]).slice(0, 6).map((s) => (
                <span key={s} className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/20 font-mono">
                  {s}
                </span>
              ))}
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Usage journalier</span>
                <span className="font-mono">{apiKey.requestCount.toLocaleString()} / {apiKey.dailyLimit.toLocaleString()}</span>
              </div>
              <Progress value={usagePct} className="h-1.5" />
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>{timeAgo(apiKey.lastUsedAt)}</span>
            </div>
            {apiKey.active && (
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={handleCopy}>
                  {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  {copied ? "Copié" : "Copier"}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => setShowRevoke(true)}>
                  <Trash2 className="w-3 h-3" />
                  Révoquer
                </Button>
              </div>
            )}
          </div>
        </div>

        {fullKey && (
          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <div className="text-xs text-amber-400 font-semibold mb-1.5 flex items-center gap-1.5">
              ⚠️ Copiez cette clé maintenant. Elle ne sera plus affichée.
            </div>
            <code className="text-xs font-mono text-amber-300 break-all">{fullKey}</code>
          </div>
        )}
      </Card>

      <Dialog open={showRevoke} onOpenChange={setShowRevoke}>
        <DialogContent className="bg-background border-border/50">
          <DialogHeader>
            <DialogTitle className="text-red-400">Révoquer la clé API ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Cette action est irréversible. Toutes les applications utilisant cette clé perdront l'accès immédiatement.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevoke(false)}>Annuler</Button>
            <Button variant="destructive" onClick={() => { onRevoke(apiKey.id); setShowRevoke(false); }}>
              Révoquer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
