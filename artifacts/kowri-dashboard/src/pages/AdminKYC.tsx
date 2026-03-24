import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldCheck, ShieldAlert, ShieldX, Search, CheckCircle, XCircle, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/format";

const REJECTION_REASONS = [
  { value: "Photo floue", label: "Photo floue" },
  { value: "Document expiré", label: "Document expiré" },
  { value: "Nom ne correspond pas", label: "Nom ne correspond pas" },
  { value: "Document non accepté", label: "Document non accepté" },
  { value: "Autre", label: "Autre (préciser)" },
];

type FilterTab = "Tous" | "pending" | "verified" | "rejected";

interface KycRecord {
  id: string;
  userId: string;
  userName: string;
  documentType: string;
  status: string;
  kycLevel: number;
  rejectionReason: string | null;
  verifiedAt: string | null;
  submittedAt: string | null;
}

interface RejectModalProps {
  record: KycRecord;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}

function RejectModal({ record, onClose, onConfirm, isPending }: RejectModalProps) {
  const [selected, setSelected] = useState("Photo floue");
  const [custom, setCustom] = useState("");

  const reason = selected === "Autre" ? custom : selected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border/40 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-lg font-bold mb-1">Rejeter la demande KYC</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Utilisateur : <span className="font-medium text-foreground">{record.userName || record.userId.slice(0, 8)}</span>
        </p>
        <div className="space-y-2 mb-4">
          {REJECTION_REASONS.map((r) => (
            <label key={r.value} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition-colors ${
              selected === r.value ? "border-destructive/50 bg-destructive/10" : "border-border/40 hover:bg-secondary/30"
            }`}>
              <input type="radio" name="reason" value={r.value} checked={selected === r.value}
                onChange={() => setSelected(r.value)} className="accent-destructive" />
              <span className="text-sm">{r.label}</span>
            </label>
          ))}
        </div>
        {selected === "Autre" && (
          <Input placeholder="Précisez la raison..." value={custom} onChange={(e) => setCustom(e.target.value)}
            className="mb-4 bg-secondary/30 border-border/40 rounded-xl" />
        )}
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose} className="rounded-xl">Annuler</Button>
          <Button variant="destructive" disabled={isPending || (selected === "Autre" && !custom.trim())}
            onClick={() => onConfirm(reason)} className="rounded-xl">
            {isPending ? "Rejet en cours..." : "Confirmer le rejet"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AdminKYC() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterTab>("Tous");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rejectTarget, setRejectTarget] = useState<KycRecord | null>(null);

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (filter !== "Tous") params.set("status", filter);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-kyc", filter, page],
    queryFn: () => fetch(`/api/compliance/kyc?${params}`).then((r) => r.json()),
  });

  const records: KycRecord[] = data?.records || [];
  const total: number = data?.pagination?.total || 0;
  const totalPages: number = data?.pagination?.totalPages || 1;

  const filtered = search
    ? records.filter((r) =>
        r.userName.toLowerCase().includes(search.toLowerCase()) ||
        r.userId.toLowerCase().includes(search.toLowerCase())
      )
    : records;

  const approveMutation = useMutation({
    mutationFn: ({ userId, kycLevel }: { userId: string; kycLevel: number }) =>
      fetch(`/api/users/${userId}/kyc`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "verified", kycLevel }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-kyc"] }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ userId, rejectionReason }: { userId: string; rejectionReason: string }) =>
      fetch(`/api/users/${userId}/kyc`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected", rejectionReason }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-kyc"] });
      setRejectTarget(null);
    },
  });

  const counts = {
    pending: records.filter((r) => r.status === "pending").length,
    verified: records.filter((r) => r.status === "verified").length,
    rejected: records.filter((r) => r.status === "rejected").length,
  };

  const TABS: { label: string; value: FilterTab }[] = [
    { label: "Tous", value: "Tous" },
    { label: "En attente", value: "pending" },
    { label: "Approuvés", value: "verified" },
    { label: "Rejetés", value: "rejected" },
  ];

  return (
    <div className="space-y-6">
      {rejectTarget && (
        <RejectModal
          record={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onConfirm={(reason) => rejectMutation.mutate({ userId: rejectTarget.userId, rejectionReason: reason })}
          isPending={rejectMutation.isPending}
        />
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Revue KYC</h1>
          <p className="text-muted-foreground mt-1">Examiner et valider les demandes de vérification d'identité</p>
        </div>
        <div className="text-sm text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-xl border border-border/40">
          {total} soumission{total !== 1 ? "s" : ""} au total
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-amber-500/10 rounded-xl"><ShieldAlert className="w-6 h-6 text-amber-500" /></div>
            <div>
              <div className="text-2xl font-bold">{counts.pending}</div>
              <div className="text-sm text-muted-foreground">En attente</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-emerald-500/10 rounded-xl"><ShieldCheck className="w-6 h-6 text-emerald-500" /></div>
            <div>
              <div className="text-2xl font-bold">{counts.verified}</div>
              <div className="text-sm text-muted-foreground">Approuvés</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-red-500/10 rounded-xl"><ShieldX className="w-6 h-6 text-red-500" /></div>
            <div>
              <div className="text-2xl font-bold">{counts.rejected}</div>
              <div className="text-sm text-muted-foreground">Rejetés</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="flex gap-2 flex-wrap">
          {TABS.map((t) => (
            <button key={t.value} onClick={() => { setFilter(t.value); setPage(1); }}
              className={`px-4 py-1.5 rounded-xl text-sm font-medium transition-colors border ${
                filter === t.value
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "border-border/40 text-muted-foreground hover:bg-secondary/50"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Rechercher par nom ou ID..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
        </div>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40">
              <TableHead>Utilisateur</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Niveau demandé</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Soumis le</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Aucune soumission trouvée.</TableCell></TableRow>
            ) : filtered.map((r) => (
              <TableRow key={r.id} className="border-border/40 hover:bg-secondary/20 transition-colors">
                <TableCell>
                  <div className="font-medium">{r.userName || "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.userId.slice(0, 12)}...</div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-sm capitalize">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    {(r.documentType || "").replace(/_/g, " ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="border-blue-500/30 text-blue-400 bg-blue-500/10 text-xs">
                    Niveau {r.kycLevel ?? 1}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={`text-xs ${
                    r.status === "pending" ? "border-amber-500/30 text-amber-400 bg-amber-500/10"
                    : r.status === "verified" ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                    : "border-red-500/30 text-red-400 bg-red-500/10"
                  }`}>
                    {r.status === "pending" ? "En attente" : r.status === "verified" ? "Vérifié" : "Rejeté"}
                  </Badge>
                  {r.status === "rejected" && r.rejectionReason && (
                    <div className="text-xs text-muted-foreground mt-0.5">{r.rejectionReason}</div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(r.submittedAt)}</TableCell>
                <TableCell className="text-right">
                  {r.status === "pending" && (
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline"
                        className="h-8 text-xs rounded-xl border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-400"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate({ userId: r.userId, kycLevel: r.kycLevel ?? 1 })}>
                        <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approuver
                      </Button>
                      <Button size="sm" variant="outline"
                        className="h-8 text-xs rounded-xl border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                        onClick={() => setRejectTarget(r)}>
                        <XCircle className="w-3.5 h-3.5 mr-1" /> Rejeter
                      </Button>
                    </div>
                  )}
                  {r.status !== "pending" && (
                    <span className="text-xs text-muted-foreground">{r.status === "verified" ? formatDate(r.verifiedAt) : "—"}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Page {page} / {totalPages}</span>
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
