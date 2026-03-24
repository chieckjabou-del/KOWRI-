import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Users, ShieldCheck, ShieldAlert, DollarSign,
  BarChart2, Ticket, Store, Activity, TrendingUp,
  ArrowRight, Zap,
} from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/format";

interface NavCard {
  icon: React.ElementType;
  label: string;
  desc: string;
  href: string;
  accent: string;
  bgAccent: string;
  stat?: string | number;
  statLabel?: string;
  alert?: boolean;
}

function AdminNavCard({ icon: Icon, label, desc, href, accent, bgAccent, stat, statLabel, alert }: NavCard) {
  return (
    <Link href={href} className="block group">
      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl hover:border-primary/30 transition-all duration-300 hover:shadow-lg cursor-pointer overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-start justify-between mb-4">
            <div className={`p-3 rounded-xl ${bgAccent}`}>
              <Icon className={`w-6 h-6 ${accent}`} />
            </div>
            {alert && (
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            )}
          </div>
          <h3 className="font-semibold text-base mb-1 group-hover:text-primary transition-colors">{label}</h3>
          <p className="text-sm text-muted-foreground leading-tight mb-3">{desc}</p>
          {stat !== undefined && (
            <div className="flex items-end gap-1">
              <span className="text-2xl font-bold">{stat}</span>
              {statLabel && <span className="text-xs text-muted-foreground mb-0.5">{statLabel}</span>}
            </div>
          )}
          <div className={`flex items-center gap-1 text-xs mt-2 ${accent} opacity-0 group-hover:opacity-100 transition-opacity`}>
            Accéder <ArrowRight className="w-3 h-3" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function Admin() {
  const { data: overview } = useQuery({
    queryKey: ["admin-analytics-overview"],
    queryFn: () => fetch("/api/analytics/overview").then((r) => r.json()),
    staleTime: 30000,
  });

  const { data: kycData } = useQuery({
    queryKey: ["admin-kyc-overview"],
    queryFn: () => fetch("/api/compliance/kyc?status=pending&limit=1").then((r) => r.json()),
    staleTime: 30000,
  });

  const { data: amlStats } = useQuery({
    queryKey: ["admin-aml-stats"],
    queryFn: () => fetch("/api/aml/stats").then((r) => r.json()),
    staleTime: 30000,
  });

  const { data: supportData } = useQuery({
    queryKey: ["admin-support-overview"],
    queryFn: () => fetch("/api/support/tickets?limit=100").then((r) => r.json()),
    staleTime: 30000,
  });

  const { data: agentsData } = useQuery({
    queryKey: ["admin-agents-overview"],
    queryFn: () => fetch("/api/agents?limit=1").then((r) => r.json()),
    staleTime: 30000,
  });

  const ov = overview || {};
  const pendingKyc = kycData?.pagination?.total ?? "—";
  const openCases = amlStats?.openCases ?? 0;
  const criticalFlags = amlStats?.bySeverity?.CRITICAL ?? 0;
  const openTickets = (supportData?.tickets || []).filter((t: any) => t.status === "OPEN").length;
  const urgentTickets = (supportData?.tickets || []).filter((t: any) => t.priority === "URGENT").length;
  const agentCount = agentsData?.total ?? agentsData?.agents?.length ?? "—";

  const NAV_CARDS: NavCard[] = [
    {
      icon: Users,
      label: "Utilisateurs",
      desc: "Gérer les comptes, suspendre, débloquer, recalculer les scores",
      href: "/admin/users",
      accent: "text-blue-400",
      bgAccent: "bg-blue-500/10",
      stat: formatNumber(ov.totalUsers || 0),
      statLabel: "comptes",
    },
    {
      icon: ShieldCheck,
      label: "Revue KYC",
      desc: "Approuver ou rejeter les demandes de vérification d'identité",
      href: "/admin/kyc",
      accent: "text-amber-400",
      bgAccent: "bg-amber-500/10",
      stat: pendingKyc,
      statLabel: "en attente",
      alert: Number(pendingKyc) > 0,
    },
    {
      icon: ShieldAlert,
      label: "AML & Conformité",
      desc: "Flags anti-blanchiment, dossiers et rapports réglementaires",
      href: "/admin/aml",
      accent: "text-red-400",
      bgAccent: "bg-red-500/10",
      stat: openCases,
      statLabel: "dossiers ouverts",
      alert: criticalFlags > 0 || openCases > 0,
    },
    {
      icon: DollarSign,
      label: "Moteur de frais",
      desc: "Règles tarifaires, taux par opération et revenus plateforme",
      href: "/admin/fees",
      accent: "text-emerald-400",
      bgAccent: "bg-emerald-500/10",
      stat: formatCurrency(ov.platformRevenue || 0),
      statLabel: "revenus estimés",
    },
    {
      icon: BarChart2,
      label: "Analytics",
      desc: "Métriques, graphiques de croissance et tableaux de bord",
      href: "/admin/analytics",
      accent: "text-purple-400",
      bgAccent: "bg-purple-500/10",
      stat: formatNumber(ov.totalTxCount || 0),
      statLabel: "transactions",
    },
    {
      icon: Ticket,
      label: "Support tickets",
      desc: "Kanban des tickets: OPEN, EN COURS, RÉSOLU, FERMÉ",
      href: "/admin/support",
      accent: "text-cyan-400",
      bgAccent: "bg-cyan-500/10",
      stat: openTickets,
      statLabel: "ouverts",
      alert: urgentTickets > 0,
    },
    {
      icon: Store,
      label: "Agents",
      desc: "Réseau d'agents, liquidité par zone, scores de confiance",
      href: "/admin/agents",
      accent: "text-orange-400",
      bgAccent: "bg-orange-500/10",
      stat: agentCount,
      statLabel: "agents réseau",
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="px-2.5 py-0.5 rounded-lg bg-primary/10 border border-primary/20 text-primary text-xs font-bold tracking-widest uppercase">
              Admin
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Tableau de bord opérateur</h1>
          <p className="text-muted-foreground mt-1">Centre de contrôle KOWRI — accès complet à toutes les fonctions d'administration</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-primary bg-primary/10 border border-primary/20 px-3 py-2 rounded-xl">
          <Zap className="w-3.5 h-3.5" />
          <span>Autopilot actif</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-4 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl col-span-1 sm:col-span-1">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-primary/10 rounded-xl"><Activity className="w-5 h-5 text-primary" /></div>
            <div>
              <div className="text-xl font-bold">{formatNumber(ov.activeWallets || 0)}</div>
              <div className="text-xs text-muted-foreground">Wallets actifs</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-emerald-500/10 rounded-xl"><TrendingUp className="w-5 h-5 text-emerald-500" /></div>
            <div>
              <div className="text-xl font-bold">{formatCurrency(ov.totalVolume || 0)}</div>
              <div className="text-xs text-muted-foreground">Volume total</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-blue-500/10 rounded-xl"><Users className="w-5 h-5 text-blue-400" /></div>
            <div>
              <div className="text-xl font-bold">{formatNumber(ov.activeTontines || 0)}</div>
              <div className="text-xs text-muted-foreground">Tontines actives</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 bg-purple-500/10 rounded-xl"><DollarSign className="w-5 h-5 text-purple-400" /></div>
            <div>
              <div className="text-xl font-bold">{formatNumber(ov.activeLoans || 0)}</div>
              <div className="text-xs text-muted-foreground">Prêts actifs</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {(Number(pendingKyc) > 0 || criticalFlags > 0 || urgentTickets > 0) && (
        <div className="flex flex-wrap gap-2">
          {Number(pendingKyc) > 0 && (
            <Link href="/admin/kyc"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm hover:bg-amber-500/20 transition-colors">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              {pendingKyc} demande{Number(pendingKyc) > 1 ? "s" : ""} KYC en attente
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {criticalFlags > 0 && (
            <Link href="/admin/aml"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm hover:bg-red-500/20 transition-colors">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
              {criticalFlags} flag{criticalFlags > 1 ? "s" : ""} AML critique{criticalFlags > 1 ? "s" : ""}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {urgentTickets > 0 && (
            <Link href="/admin/support"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm hover:bg-red-500/20 transition-colors">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
              {urgentTickets} ticket{urgentTickets > 1 ? "s" : ""} URGENT{urgentTickets > 1 ? "S" : ""}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-4 uppercase tracking-wider">Sections administratives</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {NAV_CARDS.map((card) => (
            <AdminNavCard key={card.href} {...card} />
          ))}
        </div>
      </div>
    </div>
  );
}
