import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, MapPin, Store, AlertTriangle, X, TrendingUp, Wallet, UserX, UserCheck, BarChart2 } from "lucide-react";
import { formatDate, formatCurrency, formatNumber } from "@/lib/format";

interface Zone {
  zoneId: string;
  zoneName: string;
  agentCount: number;
  totalFloat: number;
  alertCount: number;
  tensionLevel: string;
}

interface Agent {
  id: string;
  userId: string;
  agentCode: string;
  type: string;
  zoneId: string;
  status: string;
  trustScore: number;
  monthlyVolume?: number;
  cashBalance?: number;
  createdAt: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

const TENSION_CONFIG: Record<string, { label: string; cls: string }> = {
  low:      { label: "Normal",   cls: "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" },
  medium:   { label: "Moyen",    cls: "border-amber-500/30 text-amber-400 bg-amber-500/10" },
  high:     { label: "Élevé",    cls: "border-orange-500/30 text-orange-400 bg-orange-500/10" },
  critical: { label: "Critique", cls: "border-red-500/30 text-red-500 bg-red-500/10" },
};

function TrustScoreBar({ score }: { score: number }) {
  const pct = Math.min(Math.max(score, 0), 100);
  const color = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  const textColor = pct >= 80 ? "text-emerald-400" : pct >= 60 ? "text-amber-400" : "text-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary/50 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono font-bold ${textColor}`}>{pct}</span>
    </div>
  );
}

function AgentDetailPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();

  const { data: agent, isLoading } = useQuery<Agent>({
    queryKey: ["admin-agent-detail", agentId],
    queryFn: () => fetch(`/api/agents/${agentId}`).then((r) => r.json()),
  });

  const { data: liquidityData } = useQuery({
    queryKey: ["admin-agent-liquidity", agentId],
    queryFn: () => fetch(`/api/agents/${agentId}/liquidity`).then((r) => r.json()),
  });

  const { data: commissionsData } = useQuery({
    queryKey: ["admin-agent-commissions", agentId],
    queryFn: () => fetch(`/api/agents/${agentId}/commissions`).then((r) => r.json()),
  });

  const { data: anomaliesData } = useQuery({
    queryKey: ["admin-agent-anomalies", agentId],
    queryFn: () => fetch(`/api/agents/${agentId}/anomalies`).then((r) => r.json()),
  });

  const suspendMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-agents"] }),
  });

  const unlockMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-agents"] }),
  });

  const liquidity = liquidityData?.liquidity || liquidityData;
  const commissions = commissionsData?.commissions || [];
  const anomalies = anomaliesData?.anomalies || [];

  const fullName = agent ? `${agent.firstName || ""} ${agent.lastName || ""}`.trim() || agent.agentCode || "—" : "—";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border-l border-border/40 h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card/95 backdrop-blur-xl border-b border-border/40 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="font-bold text-lg">{fullName}</h2>
            {agent && <p className="text-xs text-muted-foreground font-mono">{agent.agentCode} · {agent.type}</p>}
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">Chargement...</div>
        ) : agent ? (
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
                <div className="text-xs text-muted-foreground mb-1">Statut</div>
                <Badge variant="outline" className={`text-xs ${agent.status === "active" ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-red-500/30 text-red-400 bg-red-500/10"}`}>
                  {agent.status === "active" ? "Actif" : agent.status}
                </Badge>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
                <div className="text-xs text-muted-foreground mb-1">Zone</div>
                <div className="text-sm font-medium">{agent.zoneId || "—"}</div>
              </div>
              <div className="p-3 rounded-xl bg-secondary/30 border border-border/40 col-span-2">
                <div className="text-xs text-muted-foreground mb-1.5">Score de confiance</div>
                <TrustScoreBar score={agent.trustScore || 0} />
              </div>
            </div>

            {liquidity && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><Wallet className="w-4 h-4 text-primary" /> Liquidité</h3>
                <div className="grid grid-cols-2 gap-2">
                  {([ 
                    { label: "Solde liquide", value: formatCurrency(Number(liquidity.cashBalance || 0)) },
                    { label: "Solde wallet", value: formatCurrency(Number(liquidity.walletBalance || 0)) },
                    { label: "Limite flottante", value: formatCurrency(Number(liquidity.floatLimit || 0)) },
                    { label: "Statut", value: liquidity.status || "—" },
                  ] as { label: string; value: string }[]).map(({ label, value }) => (
                    <div key={label} className="p-2.5 rounded-lg bg-secondary/20 border border-border/40">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="text-sm font-medium mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {commissions.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> Commissions récentes</h3>
                <div className="space-y-1.5">
                  {commissions.slice(0, 4).map((c: any) => (
                    <div key={c.id} className="p-2.5 rounded-lg bg-secondary/20 border border-border/40 flex justify-between text-sm">
                      <div>
                        <span className="font-medium capitalize">{(c.transactionType || "").replace(/_/g, " ")}</span>
                        <span className="text-xs text-muted-foreground ml-2">{formatDate(c.createdAt)}</span>
                      </div>
                      <span className="font-bold text-emerald-400">{formatCurrency(Number(c.commissionAmount || 0))}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {anomalies.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-amber-400"><AlertTriangle className="w-4 h-4" /> Anomalies ({anomalies.length})</h3>
                <div className="space-y-1.5">
                  {anomalies.slice(0, 4).map((a: any) => (
                    <div key={a.id} className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm flex justify-between">
                      <span>{(a.type || a.anomalyType || "").replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-border/40 space-y-2">
              <h3 className="text-sm font-semibold mb-2">Actions administratives</h3>
              {agent.status !== "suspended" ? (
                <Button variant="outline" className="w-full rounded-xl gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400 justify-start"
                  disabled={suspendMutation.isPending} onClick={() => suspendMutation.mutate()}>
                  <UserX className="w-4 h-4" /> Suspendre l'agent
                </Button>
              ) : (
                <Button variant="outline" className="w-full rounded-xl gap-2 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-400 justify-start"
                  disabled={unlockMutation.isPending} onClick={() => unlockMutation.mutate()}>
                  <UserCheck className="w-4 h-4" /> Débloquer l'agent
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function AdminAgents() {
  const [search, setSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const { data: agentsData, isLoading } = useQuery({
    queryKey: ["admin-agents"],
    queryFn: () => fetch("/api/agents?limit=100").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const { data: zonesData } = useQuery({
    queryKey: ["admin-agent-zones"],
    queryFn: () => fetch("/api/agents/zones").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const agents: Agent[] = agentsData?.agents || [];
  const zones: Zone[] = zonesData?.zones || [];

  const filtered = search
    ? agents.filter((a) =>
        a.agentCode?.toLowerCase().includes(search.toLowerCase()) ||
        `${a.firstName} ${a.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
        a.zoneId?.toLowerCase().includes(search.toLowerCase()) ||
        a.type?.toLowerCase().includes(search.toLowerCase())
      )
    : agents;

  const totalFloat = zones.reduce((s, z) => s + z.totalFloat, 0);
  const totalAlerts = zones.reduce((s, z) => s + z.alertCount, 0);

  return (
    <div className="space-y-6">
      {selectedAgent && (
        <AgentDetailPanel agentId={selectedAgent} onClose={() => setSelectedAgent(null)} />
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Gestion des agents</h1>
          <p className="text-muted-foreground mt-1">Réseau d'agents, liquidité et zones</p>
        </div>
        <div className="flex gap-2 text-sm">
          <div className="px-3 py-1.5 rounded-xl border border-border/40 bg-secondary/30 text-muted-foreground">
            <Store className="w-4 h-4 inline mr-1.5 -mt-0.5" />{agents.length} agents
          </div>
          {totalAlerts > 0 && (
            <div className="px-3 py-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 font-medium animate-pulse">
              <AlertTriangle className="w-4 h-4 inline mr-1.5 -mt-0.5" />{totalAlerts} alerte{totalAlerts > 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {zones.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4" /> Vue par zone
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {zones.map((z) => {
              const tension = TENSION_CONFIG[z.tensionLevel?.toLowerCase()] || TENSION_CONFIG.low;
              return (
                <Card key={z.zoneId} className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl hover:border-primary/30 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-sm">{z.zoneName || z.zoneId}</span>
                      <Badge variant="outline" className={`text-[10px] ${tension.cls}`}>{tension.label}</Badge>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>Agents</span><span className="font-medium text-foreground">{z.agentCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Flottant</span><span className="font-medium text-foreground">{formatCurrency(z.totalFloat)}</span>
                      </div>
                      {z.alertCount > 0 && (
                        <div className="flex justify-between">
                          <span>Alertes</span><span className="font-medium text-amber-400">{z.alertCount}</span>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-primary/10 rounded-xl"><Store className="w-6 h-6 text-primary" /></div>
            <div>
              <div className="text-2xl font-bold">{agents.filter(a => a.status === "active").length}</div>
              <div className="text-xs text-muted-foreground">Agents actifs</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-emerald-500/10 rounded-xl"><Wallet className="w-6 h-6 text-emerald-500" /></div>
            <div>
              <div className="text-lg font-bold">{formatCurrency(totalFloat)}</div>
              <div className="text-xs text-muted-foreground">Flottant total réseau</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-blue-500/10 rounded-xl"><BarChart2 className="w-6 h-6 text-blue-400" /></div>
            <div>
              <div className="text-2xl font-bold">{zones.length}</div>
              <div className="text-xs text-muted-foreground">Zones opérationnelles</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="relative max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Code agent, nom, zone..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40">
              <TableHead>Agent</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Zone</TableHead>
              <TableHead>Score confiance</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Inscription</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Chargement...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Aucun agent trouvé.</TableCell></TableRow>
            ) : filtered.map((a) => (
              <TableRow key={a.id} className="border-border/40 hover:bg-secondary/20 cursor-pointer transition-colors"
                onClick={() => setSelectedAgent(a.id)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                      {(a.agentCode?.[0] || a.firstName?.[0] || "A").toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium">{`${a.firstName || ""} ${a.lastName || ""}`.trim() || a.agentCode || "—"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{a.agentCode}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs border-blue-500/30 text-blue-400 bg-blue-500/10 capitalize">
                    {a.type || "standard"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{a.zoneId || "—"}</TableCell>
                <TableCell className="w-36">
                  <TrustScoreBar score={a.trustScore || 0} />
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={`text-xs ${a.status === "active" ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-red-500/30 text-red-400 bg-red-500/10"}`}>
                    {a.status === "active" ? "Actif" : a.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" className="h-7 text-xs rounded-xl"
                    onClick={(e) => { e.stopPropagation(); setSelectedAgent(a.id); }}>
                    Détails
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
