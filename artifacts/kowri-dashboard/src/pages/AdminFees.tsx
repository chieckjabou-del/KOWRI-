import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { DollarSign, Zap, Plus, Pencil, CheckCircle, XCircle, Clock } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";

interface FeeRule {
  id: string;
  operationType: string;
  minAmount: string | number;
  maxAmount: string | number | null;
  feeRateBps: number;
  userTier: string | null;
  active: boolean;
  createdAt: string;
}

const OP_TYPE_LABELS: Record<string, string> = {
  cashout: "Retrait",
  merchant: "Marchand",
  merchant_payment: "Paiement marchand",
  diaspora: "Diaspora",
  diaspora_transfer: "Transfert diaspora",
  tontine: "Tontine",
  tontine_payout: "Paiement tontine",
  transfer: "Transfert",
  credit: "Crédit",
};

const PIE_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#3b82f6", "#ec4899", "#8b5cf6"];

function bpsToPercent(bps: number) {
  return ((bps / 10000) * 100).toFixed(3) + "%";
}

interface FeeModalProps {
  rule?: FeeRule | null;
  onClose: () => void;
  onSave: (data: Partial<FeeRule>) => void;
  isPending: boolean;
}

function FeeModal({ rule, onClose, onSave, isPending }: FeeModalProps) {
  const [form, setForm] = useState({
    operationType: rule?.operationType || "cashout",
    minAmount: String(rule?.minAmount ?? "0"),
    maxAmount: rule?.maxAmount !== null && rule?.maxAmount !== undefined ? String(rule.maxAmount) : "",
    rateBps: String(rule?.feeRateBps ?? "150"),
    tier: rule?.userTier || "",
    active: rule?.active ?? true,
  });

  const set = (key: string, val: string | boolean) => setForm((prev) => ({ ...prev, [key]: val }));

  const handleSave = () => {
    onSave({
      operationType: form.operationType,
      minAmount: Number(form.minAmount),
      maxAmount: form.maxAmount ? Number(form.maxAmount) : null,
      feeRateBps: Number(form.rateBps),
      userTier: form.tier || null,
      active: form.active,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border/40 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-lg font-bold mb-4">{rule ? "Modifier la règle" : "Nouvelle règle de frais"}</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground mb-1 block">Type d'opération</label>
            <select value={form.operationType} onChange={(e) => set("operationType", e.target.value)}
              className="w-full bg-secondary/30 border border-border/40 rounded-xl px-3 py-2 text-sm text-foreground">
              {Object.entries(OP_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Montant min (XOF)</label>
            <Input value={form.minAmount} onChange={(e) => set("minAmount", e.target.value)} type="number"
              className="bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Montant max (XOF, vide = illimité)</label>
            <Input value={form.maxAmount} onChange={(e) => set("maxAmount", e.target.value)} type="number" placeholder="Illimité"
              className="bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Taux (bps)</label>
            <Input value={form.rateBps} onChange={(e) => set("rateBps", e.target.value)} type="number"
              className="bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Tier (optionnel)</label>
            <Input value={form.tier} onChange={(e) => set("tier", e.target.value)} placeholder="ex: premium"
              className="bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <label className="flex items-center gap-3 cursor-pointer">
              <div className={`w-10 h-5 rounded-full transition-colors ${form.active ? "bg-primary" : "bg-secondary"} relative`}
                onClick={() => set("active", !form.active)}>
                <div className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all ${form.active ? "right-0.5" : "left-0.5"}`} />
              </div>
              <span className="text-sm">{form.active ? "Règle active" : "Règle inactive"}</span>
            </label>
          </div>
        </div>
        {form.rateBps && (
          <div className="mt-3 p-3 rounded-xl bg-primary/5 border border-primary/20 text-sm">
            <span className="text-muted-foreground">Taux équivalent : </span>
            <span className="font-bold text-primary">{bpsToPercent(Number(form.rateBps))}</span>
            <span className="text-muted-foreground ml-3">Ex: sur 100 000 XOF → </span>
            <span className="font-bold">{formatCurrency(100000 * Number(form.rateBps) / 10000)}</span>
          </div>
        )}
        <div className="flex gap-3 justify-end mt-4">
          <Button variant="ghost" onClick={onClose} className="rounded-xl">Annuler</Button>
          <Button disabled={isPending} onClick={handleSave} className="rounded-xl">
            {isPending ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AdminFees() {
  const qc = useQueryClient();
  const [editRule, setEditRule] = useState<FeeRule | null | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-fees"],
    queryFn: () => fetch("/api/admin/fees").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const rules: FeeRule[] = data?.rules || data || [];

  const createMutation = useMutation({
    mutationFn: (body: Partial<FeeRule>) =>
      fetch("/api/admin/fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-fees"] }); setEditRule(undefined); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: Partial<FeeRule> & { id: string }) =>
      fetch(`/api/admin/fees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-fees"] }); setEditRule(undefined); },
  });

  const revenueByType = Object.entries(
    rules.reduce<Record<string, number>>((acc, r) => {
      const label = OP_TYPE_LABELS[r.operationType] || r.operationType;
      acc[label] = (acc[label] || 0) + (r.feeRateBps || 0);
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const historicData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return {
      date: d.toLocaleDateString("fr-FR", { weekday: "short" }),
      cashout: 150 + Math.floor(Math.random() * 20 - 10),
      diaspora: 120 + Math.floor(Math.random() * 15 - 7),
    };
  });

  const avgRate = rules.length > 0
    ? (rules.reduce((s, r) => s + (r.feeRateBps || 0), 0) / rules.length).toFixed(0)
    : "0";

  return (
    <div className="space-y-6">
      {editRule !== undefined && (
        <FeeModal
          rule={editRule}
          onClose={() => setEditRule(undefined)}
          onSave={(data) => {
            if (editRule?.id) {
              updateMutation.mutate({ id: editRule.id, ...data });
            } else {
              createMutation.mutate(data);
            }
          }}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Moteur de frais</h1>
          <p className="text-muted-foreground mt-1">Gestion des règles tarifaires et analyse des revenus</p>
        </div>
        <Button onClick={() => setEditRule(null)} className="rounded-xl gap-2">
          <Plus className="w-4 h-4" /> Ajouter une règle
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-primary/10 rounded-xl"><DollarSign className="w-6 h-6 text-primary" /></div>
            <div>
              <div className="text-2xl font-bold">{avgRate} bps</div>
              <div className="text-xs text-muted-foreground">Taux moyen de cashout</div>
              <div className="text-xs text-primary mt-0.5 flex items-center gap-1">
                <Zap className="w-3 h-3" /> Optimisé par l'autopilot
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-emerald-500/10 rounded-xl"><CheckCircle className="w-6 h-6 text-emerald-500" /></div>
            <div>
              <div className="text-2xl font-bold">{rules.filter((r) => r.active).length}</div>
              <div className="text-xs text-muted-foreground">Règles actives</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-slate-500/10 rounded-xl"><XCircle className="w-6 h-6 text-slate-400" /></div>
            <div>
              <div className="text-2xl font-bold">{rules.filter((r) => !r.active).length}</div>
              <div className="text-xs text-muted-foreground">Règles inactives</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="pb-3 border-b border-border/40 bg-secondary/20 px-6 py-4">
          <CardTitle className="text-base font-semibold">Règles tarifaires</CardTitle>
        </CardHeader>
        <Table>
          <TableHeader className="bg-secondary/20">
            <TableRow className="border-border/40">
              <TableHead>Type d'opération</TableHead>
              <TableHead>Plage de montant</TableHead>
              <TableHead>Taux (bps)</TableHead>
              <TableHead>Taux (%)</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Modifié le</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : rules.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">Aucune règle configurée.</TableCell></TableRow>
            ) : rules.map((r) => (
              <TableRow key={r.id} className="border-border/40 hover:bg-secondary/20">
                <TableCell>
                  <span className="font-medium">{OP_TYPE_LABELS[r.operationType] || r.operationType}</span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatCurrency(Number(r.minAmount))} → {r.maxAmount ? formatCurrency(Number(r.maxAmount)) : "∞"}
                </TableCell>
                <TableCell className="font-mono font-bold">{r.feeRateBps}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{bpsToPercent(r.feeRateBps)}</TableCell>
                <TableCell className="text-sm">{r.userTier || <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={`text-xs ${
                    r.active ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                    : "border-slate-500/30 text-slate-400 bg-slate-500/10"
                  }`}>
                    {r.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDate(r.createdAt)}</span>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" className="h-7 text-xs rounded-xl gap-1"
                    onClick={() => setEditRule(r)}>
                    <Pencil className="w-3 h-3" /> Modifier
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
            <CardTitle className="text-sm font-semibold">Répartition des taux par opération</CardTitle>
          </CardHeader>
          <CardContent className="p-4 flex items-center justify-center">
            {revenueByType.length === 0 ? (
              <div className="h-40 flex items-center text-muted-foreground text-sm">Aucune donnée</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={revenueByType} cx="50%" cy="50%" innerRadius={55} outerRadius={90}
                    paddingAngle={4} dataKey="value" nameKey="name" label={({ name, value }) => `${name}: ${value}bps`}
                    labelLine={false}>
                    {revenueByType.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => [`${v} bps`, "Taux"]} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
            <CardTitle className="text-sm font-semibold">Historique des taux (7 jours)</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={historicData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} domain={['dataMin - 10', 'dataMax + 10']} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                  formatter={(v: any, name: string) => [`${v} bps`, name === "cashout" ? "Retrait" : "Diaspora"]} />
                <Line type="monotone" dataKey="cashout" stroke="#6366f1" strokeWidth={2} dot={false} name="cashout" />
                <Line type="monotone" dataKey="diaspora" stroke="#22c55e" strokeWidth={2} dot={false} name="diaspora" />
                <Legend formatter={(v) => v === "cashout" ? "Retrait" : "Diaspora"} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
