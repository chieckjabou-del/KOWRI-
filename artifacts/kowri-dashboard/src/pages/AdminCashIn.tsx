import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Banknote, CheckCircle, XCircle, Ban, Plus, AlertTriangle } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { currentOperator, hasPermission } from "@/lib/adminAuth";

// Cash-in maker-checker. An `operations` operator files a request against a
// bank slip / agent receipt; a `compliance` operator (never the same person)
// approves it, which credits the wallet. Above the threshold a second
// distinct approver is needed. Everything here mirrors POST /api/admin/cash-in.

interface CashInRequest {
  id: string; walletId: string; userId: string; amount: number; currency: string; amountReference: number;
  reference: string; source: string; description: string | null; status: string; approvalsRequired: number;
  initiatedBy: string; initiatedByEmail: string; initiatedAt: string; expiresAt: string;
  approvedBy: string | null; secondApprovedBy: string | null; closedBy: string | null; closeReason: string | null;
  transactionId: string | null; executedAt: string | null; warnings: string[];
  decisions: Array<{ adminEmail: string; decision: string; reason: string | null; at: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "À approuver", APPROVED: "1re signature", EXECUTED: "Exécuté",
  REJECTED: "Rejeté", CANCELLED: "Annulé", EXPIRED: "Expiré",
};
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING_APPROVAL: "outline", APPROVED: "secondary", EXECUTED: "default", REJECTED: "destructive", CANCELLED: "secondary", EXPIRED: "secondary",
};
const SOURCES = ["bank_transfer", "agent_cash", "mobile_money", "correction", "other"];
const SOURCE_LABEL: Record<string, string> = {
  bank_transfer: "Virement bancaire", agent_cash: "Espèces agent", mobile_money: "Mobile money", correction: "Correction", test_funding: "Test", other: "Autre",
};

async function call(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(method === "POST" ? { "Idempotency-Key": crypto.randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Erreur ${res.status}`);
  return data;
}

function NewRequestForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ walletId: "", amount: "", currency: "XOF", reference: "", source: "bank_transfer", description: "" });
  const [error, setError] = useState("");
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => call("/api/admin/cash-in", "POST", { ...form, amount: Number(form.amount) }),
    onSuccess: onDone,
    onError: (e: any) => setError(e.message),
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Nouvelle demande de cash-in</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">La demande sera examinée par un autre opérateur (conformité). Aucun montant n'est crédité à cette étape.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Input placeholder="Identifiant du wallet bénéficiaire" value={form.walletId} onChange={(e) => set("walletId", e.target.value)} />
          <Input placeholder="Montant" type="number" min="0" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
          <select className="h-10 rounded-md border bg-background px-3 text-sm" value={form.currency} onChange={(e) => set("currency", e.target.value)}>
            {["XOF", "XAF", "EUR", "USD", "GHS", "NGN"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="h-10 rounded-md border bg-background px-3 text-sm" value={form.source} onChange={(e) => set("source", e.target.value)}>
            {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
          <Input placeholder="Référence de la preuve (n° de virement, reçu agent)" value={form.reference} onChange={(e) => set("reference", e.target.value)} />
          <Input placeholder="Description (optionnel)" value={form.description} onChange={(e) => set("description", e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive flex items-center gap-1"><AlertTriangle size={14} /> {error}</p>}
        <div className="flex gap-2">
          <Button onClick={() => { setError(""); m.mutate(); }} disabled={m.isPending || !form.walletId || !form.amount || !form.reference}>Soumettre pour approbation</Button>
          <Button variant="outline" onClick={onDone}>Fermer</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminCashIn() {
  const qc = useQueryClient();
  const me = currentOperator();
  const [filter, setFilter] = useState("PENDING_APPROVAL");
  const [showNew, setShowNew] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const limits = useQuery({ queryKey: ["cash-in-limits"], queryFn: () => call("/api/admin/cash-in/limits", "GET") });
  const list = useQuery({
    queryKey: ["cash-in", filter],
    queryFn: () => call(`/api/admin/cash-in?limit=100${filter ? `&status=${filter}` : ""}`, "GET"),
    refetchInterval: 15_000,
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["cash-in"] }); };
  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "approve" | "reject" | "cancel"; reason?: string }) =>
      call(`/api/admin/cash-in/${id}/${action}`, "POST", { reason }),
    onSuccess: () => { setError(""); refresh(); },
    onError: (e: any) => setError(e.message),
  });

  const canInitiate = hasPermission("ledger.write");
  const canApprove = hasPermission("ledger.approve");
  const requests: CashInRequest[] = list.data?.requests ?? [];
  const l = limits.data?.limits;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote size={22} /> Cash-in (maker-checker)</h1>
          <p className="text-sm text-muted-foreground">Toute création d'argent passe par une demande initiée par un opérateur et approuvée par un autre.</p>
        </div>
        {canInitiate && <Button onClick={() => setShowNew((v) => !v)}><Plus size={16} className="mr-1" /> Nouvelle demande</Button>}
      </div>

      {l && (
        <Card>
          <CardContent className="pt-4 grid gap-2 text-sm md:grid-cols-3">
            <div>Plafond par opération : <b>{formatCurrency(l.maxPerOperation)}</b></div>
            <div>Seconde signature à partir de : <b>{formatCurrency(l.secondApprovalThreshold)}</b></div>
            <div>Expiration : <b>{l.expiryHours} h</b></div>
            <div>Plafond journalier par opérateur : <b>{formatCurrency(l.dailyPerInitiator)}</b></div>
            <div>Plafond journalier par bénéficiaire : <b>{formatCurrency(l.dailyPerBeneficiary)}</b></div>
            <div>Plafond journalier plateforme : <b>{formatCurrency(l.dailyPlatform)}</b></div>
          </CardContent>
        </Card>
      )}

      {showNew && <NewRequestForm onDone={() => { setShowNew(false); refresh(); }} />}

      <div className="flex flex-wrap gap-2">
        {["PENDING_APPROVAL", "APPROVED", "EXECUTED", "REJECTED", "CANCELLED", "EXPIRED", ""].map((s) => (
          <Button key={s || "all"} size="sm" variant={filter === s ? "default" : "outline"} onClick={() => setFilter(s)}>{s ? STATUS_LABEL[s] : "Tous"}</Button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive flex items-center gap-1"><AlertTriangle size={14} /> {error}</p>}

      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Initiée</TableHead><TableHead>Montant</TableHead><TableHead>Wallet</TableHead><TableHead>Preuve</TableHead>
                <TableHead>Initiateur</TableHead><TableHead>Statut</TableHead><TableHead>Décision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.isLoading && <TableRow><TableCell colSpan={7}>Chargement…</TableCell></TableRow>}
              {!list.isLoading && requests.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Aucune demande.</TableCell></TableRow>}
              {requests.map((r) => {
                const open = r.status === "PENDING_APPROVAL" || r.status === "APPROVED";
                const mine = r.initiatedBy === me?.id;
                const alreadySigned = r.approvedBy === me?.id;
                const approvable = open && canApprove && !mine && !alreadySigned;
                const cancellable = open && ((mine && canInitiate) || canApprove);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{formatDate(r.initiatedAt)}<br /><span className="text-xs text-muted-foreground">expire {formatDate(r.expiresAt)}</span></TableCell>
                    <TableCell className="font-semibold whitespace-nowrap">{formatCurrency(r.amount, r.currency)}{r.approvalsRequired > 1 && <Badge variant="outline" className="ml-2">2 signatures</Badge>}</TableCell>
                    <TableCell className="font-mono text-xs">{r.walletId.slice(0, 8)}…</TableCell>
                    <TableCell className="text-xs">{SOURCE_LABEL[r.source] ?? r.source}<br /><span className="font-mono">{r.reference}</span>
                      {r.warnings.length > 0 && <div className="text-amber-600 flex items-center gap-1 mt-1"><AlertTriangle size={12} /> demande similaire récente</div>}
                    </TableCell>
                    <TableCell className="text-xs">{r.initiatedByEmail}{r.approvedBy && <div className="text-muted-foreground">1re signature : {r.decisions.find((d) => d.decision === "approve")?.adminEmail ?? "—"}</div>}</TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>{r.closeReason && <div className="text-xs text-muted-foreground mt-1">{r.closeReason}</div>}</TableCell>
                    <TableCell>
                      {open ? (
                        <div className="flex flex-col gap-1 min-w-[180px]">
                          {(approvable || canApprove) && <Input placeholder="Motif" className="h-8 text-xs" value={reason[r.id] ?? ""} onChange={(e) => setReason((p) => ({ ...p, [r.id]: e.target.value }))} />}
                          <div className="flex gap-1">
                            {approvable && <Button size="sm" onClick={() => decide.mutate({ id: r.id, action: "approve", reason: reason[r.id] })} disabled={decide.isPending}><CheckCircle size={14} className="mr-1" /> Approuver</Button>}
                            {open && canApprove && <Button size="sm" variant="destructive" onClick={() => decide.mutate({ id: r.id, action: "reject", reason: reason[r.id] })} disabled={decide.isPending || !(reason[r.id] ?? "").trim()}><XCircle size={14} className="mr-1" /> Rejeter</Button>}
                            {cancellable && <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, action: "cancel", reason: reason[r.id] })} disabled={decide.isPending}><Ban size={14} className="mr-1" /> Annuler</Button>}
                          </div>
                          {mine && open && <span className="text-xs text-muted-foreground">Vous avez initié cette demande : un autre opérateur doit l'approuver.</span>}
                          {alreadySigned && open && <span className="text-xs text-muted-foreground">Vous avez déjà signé : la seconde signature vient d'un autre opérateur.</span>}
                        </div>
                      ) : r.transactionId ? <span className="font-mono text-xs">tx {r.transactionId.slice(0, 8)}…</span> : <span className="text-xs text-muted-foreground">{r.closedBy ? "clôturée" : "—"}</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
