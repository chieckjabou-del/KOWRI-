import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Shield, TrendingUp, FileBarChart, Eye, Folder, CheckCircle, Download } from "lucide-react";
import { formatDate, formatCurrency } from "@/lib/format";

const FLAG_REASON_LABELS: Record<string, string> = {
  high_value_transaction: "Transaction haute valeur",
  structuring_detected: "Structuration détectée",
  unusual_velocity: "Vélocité inhabituelle",
  rapid_succession: "Succession rapide",
  round_amount: "Montant rond suspect",
};

const SEVERITY_CONFIG: Record<string, { label: string; cls: string }> = {
  LOW:      { label: "Faible",    cls: "border-slate-500/30 text-slate-400 bg-slate-500/10" },
  MEDIUM:   { label: "Moyen",     cls: "border-amber-500/30 text-amber-400 bg-amber-500/10" },
  HIGH:     { label: "Élevé",     cls: "border-orange-500/30 text-orange-400 bg-orange-500/10" },
  CRITICAL: { label: "Critique",  cls: "border-red-500/30 text-red-500 bg-red-500/10" },
};

interface AmlFlag {
  id: string;
  walletId: string;
  transactionId: string;
  flagReason: string;
  severity: string;
  amount: string;
  currency: string;
  reviewed: boolean;
  createdAt: string;
}

interface ComplianceCase {
  id: string;
  walletId: string;
  status: string;
  severity: string;
  flagCount: number;
  type: string;
  createdAt: string;
  resolvedAt: string | null;
  notes: string | null;
}

interface ReportForm {
  type: string;
  label: string;
  description: string;
}

const REPORT_TYPES: ReportForm[] = [
  { type: "suspicious_activity", label: "Rapport SAR", description: "Activités suspectes signalées" },
  { type: "high_value_transactions", label: "Rapport HVT", description: "Transactions haute valeur" },
  { type: "daily_transaction_summary", label: "Résumé quotidien", description: "Récapitulatif journalier" },
];

function ResolveCaseModal({ caseId, onClose, onConfirm, isPending }: { caseId: string; onClose: () => void; onConfirm: (notes: string) => void; isPending: boolean }) {
  const [notes, setNotes] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border/40 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-lg font-bold mb-1">Résoudre le dossier</h2>
        <p className="text-xs text-muted-foreground font-mono mb-4">{caseId}</p>
        <textarea
          placeholder="Notes de résolution (facultatif)..."
          value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full h-28 rounded-xl bg-secondary/30 border border-border/40 p-3 text-sm resize-none focus:outline-none focus:border-primary/50 mb-4"
        />
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose} className="rounded-xl">Annuler</Button>
          <Button disabled={isPending} onClick={() => onConfirm(notes)} className="rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white">
            {isPending ? "Résolution..." : "Confirmer"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AdminAML() {
  const qc = useQueryClient();
  const [resolveTarget, setResolveTarget] = useState<string | null>(null);
  const [reportPeriodStart, setReportPeriodStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [reportPeriodEnd, setReportPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  const { data: flagsData, isLoading: flagsLoading } = useQuery({
    queryKey: ["admin-aml-flags"],
    queryFn: () => fetch("/api/aml/flags?limit=50").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const { data: casesData, isLoading: casesLoading } = useQuery({
    queryKey: ["admin-aml-cases"],
    queryFn: () => fetch("/api/aml/cases?limit=50").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const { data: statsData } = useQuery({
    queryKey: ["admin-aml-stats"],
    queryFn: () => fetch("/api/aml/stats").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const { data: reportsData, refetch: refetchReports } = useQuery({
    queryKey: ["admin-regulatory-reports"],
    queryFn: () => fetch("/api/regulatory/reports").then((r) => r.json()),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      fetch(`/api/aml/cases/${id}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-aml-cases"] });
      qc.invalidateQueries({ queryKey: ["admin-aml-stats"] });
      setResolveTarget(null);
    },
  });

  const generateReportMutation = useMutation({
    mutationFn: (reportType: string) =>
      fetch("/api/regulatory/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportType, format: "json", periodStart: reportPeriodStart, periodEnd: reportPeriodEnd }),
      }).then((r) => r.json()),
    onSuccess: () => refetchReports(),
  });

  const flags: AmlFlag[] = flagsData?.flags || [];
  const cases: ComplianceCase[] = casesData?.cases || [];
  const reports: any[] = reportsData?.reports || [];

  const stats = statsData || {};
  const criticalCount = stats.bySeverity?.CRITICAL || 0;
  const totalAmount = flags.reduce((s, f) => s + Number(f.amount || 0), 0);
  const unreviewedFlags = flags.filter((f) => !f.reviewed).length;

  return (
    <div className="space-y-6">
      {resolveTarget && (
        <ResolveCaseModal
          caseId={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onConfirm={(notes) => resolveMutation.mutate({ id: resolveTarget, notes })}
          isPending={resolveMutation.isPending}
        />
      )}

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Tableau de bord AML</h1>
        <p className="text-muted-foreground mt-1">Surveillance anti-blanchiment et conformité réglementaire</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className={`border rounded-2xl ${unreviewedFlags > 0 ? "border-red-500/30 bg-red-500/5" : "border-border/40 bg-card/50"} backdrop-blur-xl`}>
          <CardContent className="p-5 flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${unreviewedFlags > 0 ? "bg-red-500/20" : "bg-secondary/50"}`}>
              <AlertTriangle className={`w-5 h-5 ${unreviewedFlags > 0 ? "text-red-500" : "text-muted-foreground"}`} />
            </div>
            <div>
              <div className={`text-2xl font-bold ${unreviewedFlags > 0 ? "text-red-500" : ""}`}>{unreviewedFlags}</div>
              <div className="text-xs text-muted-foreground">Flags non revus</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-amber-500/10 rounded-xl"><Folder className="w-5 h-5 text-amber-500" /></div>
            <div>
              <div className="text-2xl font-bold">{stats.openCases ?? 0}</div>
              <div className="text-xs text-muted-foreground">Dossiers ouverts</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 rounded-xl"><TrendingUp className="w-5 h-5 text-blue-400" /></div>
            <div>
              <div className="text-lg font-bold">{formatCurrency(totalAmount)}</div>
              <div className="text-xs text-muted-foreground">Sous surveillance</div>
            </div>
          </CardContent>
        </Card>
        <Card className={`border rounded-2xl ${criticalCount > 0 ? "border-red-500/30 bg-red-500/5" : "border-border/40 bg-card/50"} backdrop-blur-xl`}>
          <CardContent className="p-5 flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${criticalCount > 0 ? "bg-red-500/20" : "bg-secondary/50"}`}>
              <Shield className={`w-5 h-5 ${criticalCount > 0 ? "text-red-500" : "text-muted-foreground"}`} />
            </div>
            <div>
              <div className={`text-2xl font-bold ${criticalCount > 0 ? "text-red-500" : ""}`}>{criticalCount}</div>
              <div className="text-xs text-muted-foreground">Flags critiques</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="pb-3 border-b border-border/40 bg-secondary/20 px-6 py-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> Flags AML récents
          </CardTitle>
        </CardHeader>
        <Table>
          <TableHeader className="bg-secondary/20">
            <TableRow className="border-border/40">
              <TableHead>Wallet</TableHead>
              <TableHead>Montant</TableHead>
              <TableHead>Raison</TableHead>
              <TableHead>Sévérité</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Statut</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flagsLoading ? (
              <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : flags.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Aucun flag AML.</TableCell></TableRow>
            ) : flags.slice(0, 20).map((f) => {
              const sev = SEVERITY_CONFIG[f.severity?.toUpperCase()] || SEVERITY_CONFIG.LOW;
              return (
                <TableRow key={f.id} className="border-border/40 hover:bg-secondary/20">
                  <TableCell className="font-mono text-xs">{f.walletId?.slice(0, 16)}...</TableCell>
                  <TableCell className="font-medium">
                    {f.amount && !isNaN(Number(f.amount)) ? `${formatCurrency(Number(f.amount))} ${f.currency || "XOF"}` : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="text-sm">{FLAG_REASON_LABELS[f.flagReason] || f.flagReason}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${sev.cls}`}>{sev.label}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(f.createdAt)}</TableCell>
                  <TableCell>
                    {f.reviewed ? (
                      <Badge variant="outline" className="text-xs border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                        <CheckCircle className="w-3 h-3 mr-1" /> Revu
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/10">En attente</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="pb-3 border-b border-border/40 bg-secondary/20 px-6 py-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Folder className="w-4 h-4 text-amber-400" /> Dossiers de conformité
          </CardTitle>
        </CardHeader>
        <Table>
          <TableHeader className="bg-secondary/20">
            <TableRow className="border-border/40">
              <TableHead>Dossier</TableHead>
              <TableHead>Wallet</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sévérité</TableHead>
              <TableHead>Ouvert le</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {casesLoading ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : cases.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Aucun dossier ouvert.</TableCell></TableRow>
            ) : cases.slice(0, 20).map((c) => {
              const sev = SEVERITY_CONFIG[c.severity?.toUpperCase()] || SEVERITY_CONFIG.LOW;
              return (
                <TableRow key={c.id} className="border-border/40 hover:bg-secondary/20">
                  <TableCell className="font-mono text-xs">{c.id.slice(0, 12)}...</TableCell>
                  <TableCell className="font-mono text-xs">{c.walletId?.slice(0, 12)}...</TableCell>
                  <TableCell className="text-sm capitalize">{(c.type || "aml").replace(/_/g, " ")}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${sev.cls}`}>{sev.label}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${
                      c.status === "open" ? "border-amber-500/30 text-amber-400 bg-amber-500/10"
                      : "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                    }`}>
                      {c.status === "open" ? "Ouvert" : "Résolu"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {c.status === "open" && (
                      <Button size="sm" variant="outline" className="h-7 text-xs rounded-xl"
                        onClick={() => setResolveTarget(c.id)}>
                        <CheckCircle className="w-3 h-3 mr-1" /> Résoudre
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
        <CardHeader className="pb-3 border-b border-border/40 bg-secondary/20 px-6 py-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileBarChart className="w-4 h-4 text-blue-400" /> Rapports réglementaires
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Période :</span>
              <input type="date" value={reportPeriodStart} onChange={(e) => setReportPeriodStart(e.target.value)}
                className="bg-secondary/30 border border-border/40 rounded-lg px-2 py-1 text-sm text-foreground" />
              <span>→</span>
              <input type="date" value={reportPeriodEnd} onChange={(e) => setReportPeriodEnd(e.target.value)}
                className="bg-secondary/30 border border-border/40 rounded-lg px-2 py-1 text-sm text-foreground" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {REPORT_TYPES.map((rt) => (
              <button key={rt.type}
                onClick={() => generateReportMutation.mutate(rt.type)}
                disabled={generateReportMutation.isPending}
                className="p-4 rounded-xl border border-border/40 bg-secondary/20 hover:bg-secondary/40 transition-colors text-left group">
                <div className="font-medium text-sm group-hover:text-primary transition-colors">{rt.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{rt.description}</div>
                {generateReportMutation.isPending && (
                  <div className="text-xs text-primary mt-1 animate-pulse">Génération en cours...</div>
                )}
              </button>
            ))}
          </div>
          {reports.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border/40">
              <div className="text-sm font-medium text-muted-foreground">Rapports générés ({reports.length})</div>
              {reports.slice(0, 5).map((r: any) => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-xl bg-secondary/20 border border-border/40">
                  <div>
                    <div className="text-sm font-medium capitalize">{(r.reportType || "").replace(/_/g, " ")}</div>
                    <div className="text-xs text-muted-foreground">{formatDate(r.generatedAt || r.createdAt)}</div>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs rounded-xl gap-1.5">
                    <Download className="w-3 h-3" /> Télécharger
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
