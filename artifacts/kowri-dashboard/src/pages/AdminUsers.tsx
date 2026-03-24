import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Users, ChevronLeft, ChevronRight, ShieldCheck, CreditCard, UserX, UserCheck, RefreshCw, X, Wallet, TrendingUp } from "lucide-react";
import { formatDate, formatCurrency } from "@/lib/format";

type StatusFilter = "all" | "active" | "suspended" | "pending";

interface User {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  kycLevel: number;
  status: string;
  createdAt: string;
  creditScore?: number | null;
}

interface UserDetail {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  kycLevel: number;
  status: string;
  createdAt: string;
  wallets?: any[];
  creditScore?: number | null;
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    active:    "border-emerald-500/30 text-emerald-400 bg-emerald-500/10",
    suspended: "border-red-500/30 text-red-400 bg-red-500/10",
    pending:   "border-amber-500/30 text-amber-400 bg-amber-500/10",
    inactive:  "border-slate-500/30 text-slate-400 bg-slate-500/10",
  };
  const labels: Record<string, string> = { active: "Actif", suspended: "Suspendu", pending: "En attente", inactive: "Inactif" };
  return (
    <Badge variant="outline" className={`text-xs ${cfg[status] || cfg.inactive}`}>
      {labels[status] || status}
    </Badge>
  );
}

function KycBadge({ level }: { level: number }) {
  const cfg = level >= 2 ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
    : level === 1 ? "border-blue-500/30 text-blue-400 bg-blue-500/10"
    : "border-slate-500/30 text-slate-400 bg-slate-500/10";
  return <Badge variant="outline" className={`text-xs ${cfg}`}>KYC {level}</Badge>;
}

function UserDetailPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const qc = useQueryClient();

  const { data: user, isLoading } = useQuery<UserDetail>({
    queryKey: ["admin-user-detail", userId],
    queryFn: () => fetch(`/api/users/${userId}`).then((r) => r.json()),
  });

  const { data: walletsData } = useQuery({
    queryKey: ["admin-user-wallets", userId],
    queryFn: () => fetch(`/api/wallets?userId=${userId}`).then((r) => r.json()),
  });

  const { data: txData } = useQuery({
    queryKey: ["admin-user-txs", userId],
    queryFn: () => fetch(`/api/transactions?userId=${userId}&limit=5`).then((r) => r.json()),
  });

  const { data: amlData } = useQuery({
    queryKey: ["admin-user-aml", userId],
    queryFn: () => fetch(`/api/aml/flags/${userId}`).then((r) => r.json()),
  });

  const suspendMutation = useMutation({
    mutationFn: () => fetch(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const unlockMutation = useMutation({
    mutationFn: () => fetch(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const recalcMutation = useMutation({
    mutationFn: () => fetch(`/api/credit/scores/${userId}/compute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).then((r) => r.json()),
  });

  const wallets = walletsData?.wallets || [];
  const txs = txData?.transactions || [];
  const amlFlags = amlData?.flags || [];
  const fullName = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || "—" : "—";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border-l border-border/40 h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card/95 backdrop-blur-xl border-b border-border/40 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="font-bold text-lg">{fullName}</h2>
            {user && <p className="text-sm text-muted-foreground">{user.phone}</p>}
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">Chargement...</div>
        ) : user ? (
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
                <div className="text-xs text-muted-foreground mb-1">Statut</div>
                <StatusBadge status={user.status} />
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
                <div className="text-xs text-muted-foreground mb-1">KYC</div>
                <KycBadge level={user.kycLevel || 0} />
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40 col-span-2">
                <div className="text-xs text-muted-foreground mb-1">Membre depuis</div>
                <div className="text-sm font-medium">{formatDate(user.createdAt)}</div>
              </div>
            </div>

            {wallets.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><Wallet className="w-4 h-4 text-primary" /> Wallets</h3>
                <div className="space-y-2">
                  {wallets.map((w: any) => (
                    <div key={w.id} className="p-3 rounded-xl bg-secondary/20 border border-border/40 flex justify-between items-center">
                      <div>
                        <div className="text-sm font-medium capitalize">{w.currency} · {w.type || "standard"}</div>
                        <div className="text-xs text-muted-foreground font-mono">{w.id.slice(0, 16)}...</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-sm">{formatCurrency(Number(w.balance), w.currency)}</div>
                        <Badge variant="outline" className={`text-xs mt-0.5 ${w.status === "active" ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-slate-500/30 text-slate-400 bg-slate-500/10"}`}>{w.status}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {txs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-blue-400" /> Dernières transactions</h3>
                <div className="space-y-1">
                  {txs.map((t: any) => (
                    <div key={t.id} className="p-2.5 rounded-lg bg-secondary/20 border border-border/40 flex justify-between items-center text-sm">
                      <div>
                        <span className="font-medium capitalize">{(t.type || "").replace(/_/g, " ")}</span>
                        <span className="text-xs text-muted-foreground ml-2">{formatDate(t.createdAt)}</span>
                      </div>
                      <span className={`font-bold ${t.direction === "credit" || t.toWalletId ? "text-emerald-400" : "text-red-400"}`}>
                        {formatCurrency(Number(t.amount), t.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {amlFlags.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-amber-400">
                  <ShieldCheck className="w-4 h-4" /> Flags AML ({amlFlags.length})
                </h3>
                <div className="space-y-1">
                  {amlFlags.slice(0, 3).map((f: any) => (
                    <div key={f.id} className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm flex justify-between">
                      <span>{f.flagReason?.replace(/_/g, " ")}</span>
                      <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/10">{f.severity}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-border/40">
              <h3 className="text-sm font-semibold mb-3">Actions administratives</h3>
              <div className="flex flex-col gap-2">
                {user.status !== "suspended" ? (
                  <Button variant="outline" className="rounded-xl gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400 justify-start"
                    disabled={suspendMutation.isPending} onClick={() => suspendMutation.mutate()}>
                    <UserX className="w-4 h-4" /> Suspendre le compte
                  </Button>
                ) : (
                  <Button variant="outline" className="rounded-xl gap-2 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-400 justify-start"
                    disabled={unlockMutation.isPending} onClick={() => unlockMutation.mutate()}>
                    <UserCheck className="w-4 h-4" /> Débloquer le compte
                  </Button>
                )}
                <Button variant="outline" className="rounded-xl gap-2 justify-start"
                  disabled={recalcMutation.isPending} onClick={() => recalcMutation.mutate()}>
                  <RefreshCw className={`w-4 h-4 ${recalcMutation.isPending ? "animate-spin" : ""}`} />
                  {recalcMutation.isPending ? "Calcul en cours..." : "Recalculer le score de crédit"}
                </Button>
                {recalcMutation.isSuccess && (
                  <div className="text-xs text-emerald-400 px-1">Score mis à jour ✓</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (statusFilter !== "all") params.set("status", statusFilter);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", statusFilter, page],
    queryFn: () => fetch(`/api/users?${params}`).then((r) => r.json()),
  });

  const users: User[] = data?.users || [];
  const total: number = data?.pagination?.total || 0;
  const totalPages: number = data?.pagination?.totalPages || 1;

  const filtered = search
    ? users.filter((u) =>
        `${u.firstName} ${u.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
        u.phone?.includes(search) ||
        u.id?.includes(search)
      )
    : users;

  const STATUS_TABS: { label: string; value: StatusFilter }[] = [
    { label: "Tous", value: "all" },
    { label: "Actifs", value: "active" },
    { label: "Suspendus", value: "suspended" },
    { label: "En attente KYC", value: "pending" },
  ];

  return (
    <div className="space-y-6">
      {selectedUserId && (
        <UserDetailPanel userId={selectedUserId} onClose={() => setSelectedUserId(null)} />
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Gestion des utilisateurs</h1>
          <p className="text-muted-foreground mt-1">Rechercher, filtrer et gérer les comptes utilisateurs</p>
        </div>
        <div className="text-sm text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-xl border border-border/40">
          <Users className="w-4 h-4 inline mr-1.5 -mt-0.5" />{total} utilisateurs
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="flex gap-2 flex-wrap">
          {STATUS_TABS.map((t) => (
            <button key={t.value} onClick={() => { setStatusFilter(t.value); setPage(1); }}
              className={`px-4 py-1.5 rounded-xl text-sm font-medium transition-colors border ${
                statusFilter === t.value
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "border-border/40 text-muted-foreground hover:bg-secondary/50"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Nom, téléphone ou ID..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
        </div>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40">
              <TableHead>Utilisateur</TableHead>
              <TableHead>Téléphone</TableHead>
              <TableHead>KYC</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Inscription</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Aucun utilisateur trouvé.</TableCell></TableRow>
            ) : filtered.map((u) => (
              <TableRow key={u.id} className="border-border/40 hover:bg-secondary/20 cursor-pointer transition-colors"
                onClick={() => setSelectedUserId(u.id)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                      {(u.firstName?.[0] || u.phone?.[0] || "?").toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium">{`${u.firstName || ""} ${u.lastName || ""}`.trim() || "—"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{u.id.slice(0, 12)}...</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">{u.phone || "—"}</TableCell>
                <TableCell><KycBadge level={u.kycLevel || 0} /></TableCell>
                <TableCell><StatusBadge status={u.status || "inactive"} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(u.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" className="h-7 text-xs rounded-xl" onClick={(e) => { e.stopPropagation(); setSelectedUserId(u.id); }}>
                    <CreditCard className="w-3 h-3 mr-1" /> Détails
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Page {page} / {totalPages}</span>
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
