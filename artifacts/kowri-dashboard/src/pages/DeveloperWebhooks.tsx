import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, Trash2, Webhook, CheckCircle2, XCircle, Copy, Check, RefreshCw } from "lucide-react";
import { getDevSession, devApiFetch } from "@/lib/devAuth";
import { useToast } from "@/hooks/use-toast";
import { randomBytes } from "crypto";

interface WebhookRow {
  id: string; url: string; eventType: string; active: boolean; createdAt: string;
}

const EVENT_TYPES = [
  "transaction.created",
  "tontine.payout.completed",
  "loan.disbursed",
  "wallet.frozen",
  "kyc.verified",
];

const EVENT_COLORS: Record<string, string> = {
  "transaction.created":       "border-blue-500/30 text-blue-400",
  "tontine.payout.completed":  "border-violet-500/30 text-violet-400",
  "loan.disbursed":            "border-green-500/30 text-green-400",
  "wallet.frozen":             "border-red-500/30 text-red-400",
  "kyc.verified":              "border-emerald-500/30 text-emerald-400",
};

function generateSecret() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "whsec_";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

const MOCK_LOGS = [
  { id: "1", event: "transaction.created",      timestamp: "2026-03-25 09:42", status: "delivered" },
  { id: "2", event: "kyc.verified",             timestamp: "2026-03-24 14:18", status: "delivered" },
  { id: "3", event: "tontine.payout.completed", timestamp: "2026-03-23 11:05", status: "failed" },
  { id: "4", event: "wallet.frozen",            timestamp: "2026-03-22 16:30", status: "delivered" },
];

export default function DeveloperWebhooks() {
  const session = getDevSession();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ url: "", events: [] as string[], secret: generateSecret() });
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [secretRevealed, setSecretRevealed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["dev-webhooks"],
    queryFn: () => devApiFetch<WebhookRow[]>("/webhooks"),
  });

  const webhooks = Array.isArray(data) ? data : [];

  const addMutation = useMutation({
    mutationFn: () => devApiFetch("/developer/webhook", session?.token, {
      method: "POST",
      body: JSON.stringify({
        developerId: session?.developerId,
        url: form.url,
        events: form.events,
        secret: form.secret,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-webhooks"] });
      setShowAdd(false);
      setForm({ url: "", events: [], secret: generateSecret() });
      setSecretRevealed(false);
      toast({ title: "Webhook ajouté" });
    },
    onError: (e: any) => toast({ title: "Erreur", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => devApiFetch(`/webhooks/${id}`, session?.token, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-webhooks"] });
      toast({ title: "Webhook supprimé" });
    },
  });

  const toggleEvent = (ev: string) => {
    setForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
    }));
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Webhooks</h1>
          <p className="text-muted-foreground mt-1">Recevez des notifications en temps réel sur vos endpoints</p>
        </div>
        <Button className="gap-2 bg-primary hover:bg-primary/90" onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" /> Ajouter un webhook
        </Button>
      </div>

      {/* Webhook list */}
      <Card className="bg-secondary/20 border-border/40 overflow-hidden">
        <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
          <Webhook className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Endpoints configurés</h2>
          <Badge variant="outline" className="ml-auto text-xs">{webhooks.length}</Badge>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : webhooks.length === 0 ? (
          <div className="p-8 text-center">
            <Webhook className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Aucun webhook configuré</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border/30">
                <TableHead>URL</TableHead>
                <TableHead>Événement</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map(wh => (
                <TableRow key={wh.id} className="border-border/20 hover:bg-secondary/20">
                  <TableCell>
                    <code className="text-xs font-mono text-muted-foreground">
                      {wh.url.length > 50 ? wh.url.slice(0, 50) + "…" : wh.url}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${EVENT_COLORS[wh.eventType] || "border-slate-500/30 text-slate-400"}`}>
                      {wh.eventType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {wh.active ? (
                      <div className="flex items-center gap-1.5 text-emerald-400 text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Actif
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-red-400 text-xs">
                        <XCircle className="w-3.5 h-3.5" /> Inactif
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 border-red-500/30 text-red-400 hover:bg-red-500/10"
                      onClick={() => deleteMutation.mutate(wh.id)}>
                      <Trash2 className="w-3 h-3" /> Supprimer
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Webhook logs */}
      <Card className="bg-secondary/20 border-border/40 overflow-hidden">
        <div className="px-5 py-4 border-b border-border/40">
          <h2 className="font-semibold">Logs de livraison récents</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="border-border/30">
              <TableHead>Événement</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MOCK_LOGS.map(log => (
              <TableRow key={log.id} className="border-border/20 hover:bg-secondary/20">
                <TableCell>
                  <Badge variant="outline" className={`text-xs ${EVENT_COLORS[log.event] || "border-slate-500/30 text-slate-400"}`}>
                    {log.event}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{log.timestamp}</TableCell>
                <TableCell>
                  {log.status === "delivered" ? (
                    <div className="flex items-center gap-1.5 text-emerald-400 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Livré
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-red-400 text-xs">
                      <XCircle className="w-3.5 h-3.5" /> Échec
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {log.status === "failed" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                      <RefreshCw className="w-3 h-3" /> Rejouer
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Add webhook dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="bg-background border-border/50 max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter un webhook</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">URL (doit commencer par https://)</Label>
              <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                className="bg-secondary/30 border-border/40 font-mono text-sm"
                placeholder="https://yourapp.com/webhooks/kowri" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Événements</Label>
              <div className="flex flex-wrap gap-2">
                {EVENT_TYPES.map(ev => (
                  <button key={ev} onClick={() => toggleEvent(ev)}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                      form.events.includes(ev)
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/40 text-muted-foreground hover:border-border/70"
                    }`}>
                    {ev}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Secret (auto-généré)</Label>
              <div className="flex gap-2">
                <Input type={secretRevealed ? "text" : "password"} value={form.secret} readOnly
                  className="bg-secondary/30 border-border/40 font-mono text-xs flex-1" />
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => setSecretRevealed(!secretRevealed)}>
                  {secretRevealed ? "Masquer" : "Voir"}
                </Button>
                <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={async () => {
                  await navigator.clipboard.writeText(form.secret).catch(() => {});
                  setCopiedSecret(true); setTimeout(() => setCopiedSecret(false), 2000);
                }}>
                  {copiedSecret ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                </Button>
              </div>
              <p className="text-xs text-amber-400/80 mt-1">⚠️ Copiez ce secret maintenant pour valider les signatures.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Annuler</Button>
            <Button className="bg-primary hover:bg-primary/90"
              onClick={() => addMutation.mutate()}
              disabled={!form.url.startsWith("https://") || form.events.length === 0 || addMutation.isPending}>
              {addMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Ajouter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
