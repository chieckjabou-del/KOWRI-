import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { TicketCheck, X, MessageSquare, Clock, ArrowUpCircle, CheckCircle2 } from "lucide-react";
import { formatDate } from "@/lib/format";

type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

interface Ticket {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: string;
  category: string;
  title: string;
  description: string;
  userPhone?: string;
  agentId?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

const COLUMNS: { status: TicketStatus; label: string; color: string }[] = [
  { status: "OPEN",        label: "Ouvert",       color: "text-amber-400" },
  { status: "IN_PROGRESS", label: "En cours",     color: "text-blue-400" },
  { status: "RESOLVED",    label: "Résolu",       color: "text-emerald-400" },
  { status: "CLOSED",      label: "Fermé",        color: "text-slate-400" },
];

const PRIORITY_CONFIG: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  URGENT: { label: "URGENT", cls: "border-red-500/30 text-red-500 bg-red-500/10", pulse: true },
  HIGH:   { label: "Haut",   cls: "border-red-500/30 text-red-400 bg-red-500/10" },
  MEDIUM: { label: "Moyen",  cls: "border-amber-500/30 text-amber-400 bg-amber-500/10" },
  LOW:    { label: "Bas",    cls: "border-slate-500/30 text-slate-400 bg-slate-500/10" },
};

const CATEGORY_CONFIG: Record<string, string> = {
  transaction: "border-blue-500/30 text-blue-400 bg-blue-500/10",
  account:     "border-purple-500/30 text-purple-400 bg-purple-500/10",
  kyc:         "border-amber-500/30 text-amber-400 bg-amber-500/10",
  loan:        "border-green-500/30 text-green-400 bg-green-500/10",
  tontine:     "border-indigo-500/30 text-indigo-400 bg-indigo-500/10",
  agent:       "border-orange-500/30 text-orange-400 bg-orange-500/10",
  other:       "border-slate-500/30 text-slate-400 bg-slate-500/10",
};

function PriorityBadge({ priority }: { priority: string }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.LOW;
  return (
    <span className="relative inline-flex items-center">
      {cfg.pulse && <span className="absolute -inset-0.5 rounded-full animate-ping bg-red-500/30" />}
      <Badge variant="outline" className={`text-[10px] font-bold relative ${cfg.cls}`}>{cfg.label}</Badge>
    </span>
  );
}

function TicketDetailPanel({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const qc = useQueryClient();
  const [resolution, setResolution] = useState("");

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      fetch(`/api/support/tickets/${ticket.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-support"] }); onClose(); },
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/support/tickets/${ticket.id}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-support"] }); onClose(); },
  });

  const escalateMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/support/tickets/${ticket.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_PROGRESS", priority: "URGENT" }),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-support"] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border-l border-border/40 h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card/95 backdrop-blur-xl border-b border-border/40 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <div className="font-mono text-xs text-muted-foreground mb-0.5">#{ticket.ticketNumber}</div>
            <h2 className="font-bold text-base leading-tight">{ticket.title}</h2>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full shrink-0" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>
        <div className="p-6 space-y-5">
          <div className="flex flex-wrap gap-2">
            <PriorityBadge priority={ticket.priority} />
            <Badge variant="outline" className={`text-xs ${CATEGORY_CONFIG[ticket.category] || CATEGORY_CONFIG.other}`}>{ticket.category}</Badge>
            <Badge variant="outline" className="text-xs border-slate-500/30 text-slate-400 bg-slate-500/10">
              {COLUMNS.find(c => c.status === ticket.status)?.label || ticket.status}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
              <div className="text-xs text-muted-foreground mb-0.5">Utilisateur</div>
              <div className="font-medium text-sm">{ticket.userPhone || "—"}</div>
            </div>
            <div className="p-3 rounded-xl bg-secondary/30 border border-border/40">
              <div className="text-xs text-muted-foreground mb-0.5">Ouvert le</div>
              <div className="font-medium text-sm">{formatDate(ticket.createdAt)}</div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-secondary/20 border border-border/40">
            <div className="text-xs text-muted-foreground mb-2 font-medium">Description</div>
            <p className="text-sm leading-relaxed">{ticket.description || "—"}</p>
          </div>

          {ticket.status === "RESOLVED" && (
            <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
              <div className="text-xs text-muted-foreground mb-0.5">Résolu le</div>
              <div className="text-sm">{formatDate(ticket.resolvedAt)}</div>
            </div>
          )}

          {(ticket.status === "OPEN" || ticket.status === "IN_PROGRESS") && (
            <div className="space-y-3 pt-2 border-t border-border/40">
              <div className="text-sm font-semibold">Actions</div>
              <div className="flex flex-col gap-2">
                {ticket.status === "OPEN" && (
                  <Button variant="outline" className="rounded-xl gap-2 justify-start"
                    disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("IN_PROGRESS")}>
                    <Clock className="w-4 h-4 text-blue-400" /> Prendre en charge
                  </Button>
                )}
                <Button variant="outline" className="rounded-xl gap-2 justify-start text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                  disabled={escalateMutation.isPending} onClick={() => escalateMutation.mutate()}>
                  <ArrowUpCircle className="w-4 h-4" /> Escalader (marquer URGENT)
                </Button>
              </div>
              {ticket.status === "IN_PROGRESS" && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Résolution</label>
                  <textarea value={resolution} onChange={(e) => setResolution(e.target.value)}
                    placeholder="Décrivez la résolution apportée..."
                    className="w-full h-24 rounded-xl bg-secondary/30 border border-border/40 p-3 text-sm resize-none focus:outline-none focus:border-primary/50 mb-2" />
                  <Button className="w-full rounded-xl gap-2" disabled={resolveMutation.isPending || !resolution.trim()}
                    onClick={() => resolveMutation.mutate()}>
                    <CheckCircle2 className="w-4 h-4" />
                    {resolveMutation.isPending ? "Résolution en cours..." : "Résoudre le ticket"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TicketCard({ ticket, onClick }: { ticket: Ticket; onClick: () => void }) {
  const pri = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.LOW;
  const cat = CATEGORY_CONFIG[ticket.category] || CATEGORY_CONFIG.other;
  return (
    <div onClick={onClick}
      className="p-3 rounded-xl border border-border/40 bg-card/40 hover:bg-card/80 cursor-pointer transition-all group">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-mono text-xs text-muted-foreground">#{ticket.ticketNumber}</span>
        <PriorityBadge priority={ticket.priority} />
      </div>
      <p className="text-sm font-medium leading-tight line-clamp-2 mb-2 group-hover:text-primary transition-colors">{ticket.title}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="outline" className={`text-[10px] ${cat}`}>{ticket.category}</Badge>
      </div>
      <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{ticket.userPhone || "—"}</span>
        <span className="text-xs text-muted-foreground">{formatDate(ticket.createdAt).split(",")[0]}</span>
      </div>
    </div>
  );
}

export default function AdminSupport() {
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-support"],
    queryFn: () => fetch("/api/support/tickets?limit=100").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const tickets: Ticket[] = data?.tickets || [];
  const filtered = search
    ? tickets.filter((t) =>
        t.title?.toLowerCase().includes(search.toLowerCase()) ||
        t.ticketNumber?.includes(search) ||
        t.userPhone?.includes(search)
      )
    : tickets;

  const byStatus = (status: TicketStatus) => filtered.filter((t) => t.status === status);

  const totalOpen = tickets.filter(t => t.status === "OPEN").length;
  const totalUrgent = tickets.filter(t => t.priority === "URGENT").length;

  return (
    <div className="space-y-6">
      {selectedTicket && (
        <TicketDetailPanel ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Support tickets</h1>
          <p className="text-muted-foreground mt-1">Vue Kanban de tous les tickets support</p>
        </div>
        <div className="flex gap-2">
          {totalUrgent > 0 && (
            <div className="px-3 py-1.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm font-medium animate-pulse">
              {totalUrgent} URGENT{totalUrgent > 1 ? "S" : ""}
            </div>
          )}
          <div className="px-3 py-1.5 rounded-xl border border-border/40 bg-secondary/30 text-muted-foreground text-sm">
            <TicketCheck className="w-4 h-4 inline mr-1.5 -mt-0.5" />{totalOpen} ouverts
          </div>
        </div>
      </div>

      <div className="relative max-w-xs">
        <MessageSquare className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Rechercher un ticket..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-secondary/30 border-border/40 rounded-xl h-9 text-sm" />
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Chargement des tickets...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((col) => {
            const colTickets = byStatus(col.status);
            return (
              <div key={col.status} className="flex flex-col gap-3">
                <div className="flex items-center justify-between px-1">
                  <span className={`text-sm font-semibold ${col.color}`}>{col.label}</span>
                  <span className="text-xs text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded-full">{colTickets.length}</span>
                </div>
                <div className="flex flex-col gap-2 min-h-[120px]">
                  {colTickets.length === 0 ? (
                    <div className="flex items-center justify-center h-20 rounded-xl border border-dashed border-border/30 text-xs text-muted-foreground">
                      Aucun ticket
                    </div>
                  ) : colTickets.map((t) => (
                    <TicketCard key={t.id} ticket={t} onClick={() => setSelectedTicket(t)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
