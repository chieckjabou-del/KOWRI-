import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Key, BarChart2, FlaskConical, CheckCircle2, Copy, Check } from "lucide-react";
import { getDevSession, setDevSession, devApiFetch } from "@/lib/devAuth";
import { useToast } from "@/hooks/use-toast";

const PLANS = [
  {
    name: "Free",
    tier: "free",
    requests: "1 000 req/jour",
    scopes: ["wallets:read"],
    color: "border-slate-500/30 bg-slate-500/10",
    badge: "bg-slate-500/20 text-slate-300",
  },
  {
    name: "Starter",
    tier: "starter",
    requests: "10 000 req/jour",
    scopes: ["wallets:read", "transactions:read"],
    color: "border-blue-500/30 bg-blue-500/10",
    badge: "bg-blue-500/20 text-blue-300",
  },
  {
    name: "Growth",
    tier: "growth",
    requests: "100 000 req/jour",
    scopes: ["wallets:read/write", "transactions:read/write"],
    color: "border-violet-500/30 bg-violet-500/10",
    badge: "bg-violet-500/20 text-violet-300",
    popular: true,
  },
  {
    name: "Enterprise",
    tier: "enterprise",
    requests: "Illimité",
    scopes: ["Accès complet", "admin access"],
    color: "border-amber-500/30 bg-amber-500/10",
    badge: "bg-amber-500/20 text-amber-300",
  },
];

export default function Developer() {
  const [, navigate] = useLocation();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", pin: "", country: "SN" });
  const [loading, setLoading] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const session = getDevSession();
    if (session) navigate("/developer/dashboard");
  }, [navigate]);

  const handleRegister = async () => {
    if (!form.firstName || !form.lastName || !form.phone || !form.pin) {
      toast({ title: "Champs requis", description: "Tous les champs sont obligatoires.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const data = await devApiFetch<{
        developerId: string; token: string; apiKey: string; plan: string;
      }>("/developer/register", undefined, {
        method: "POST",
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          pin: form.pin,
          country: form.country,
        }),
      });
      setDevSession({
        token: data.token,
        developerId: data.developerId,
        developerName: `${form.firstName} ${form.lastName}`,
      });
      setNewApiKey(data.apiKey);
    } catch (e: any) {
      toast({ title: "Erreur", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleCopyKey = async () => {
    if (newApiKey) {
      await navigator.clipboard.writeText(newApiKey).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleContinue = () => {
    navigate("/developer/dashboard");
  };

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="text-center py-16 px-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <Badge variant="outline" className="mb-6 border-primary/30 text-primary bg-primary/10 px-3 py-1 text-xs tracking-widest uppercase">
            KOWRI API Platform v5.0
          </Badge>
          <h1 className="text-5xl font-display font-bold text-foreground mb-4 leading-tight">
            KOWRI API Platform
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Construisez des applications financières<br />
            sur l'infrastructure KOWRI
          </p>
          <div className="flex gap-3 justify-center mt-8">
            <Button size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-8" onClick={() => setShowForm(true)}>
              Créer un compte développeur
            </Button>
            <Button size="lg" variant="outline" className="border-border/50" onClick={() => navigate("/developer/docs")}>
              Documentation
            </Button>
          </div>
        </motion.div>
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 max-w-4xl mx-auto px-4">
        {[
          { icon: Key, title: "Clés API", sub: "accès sécurisé", desc: "Gérez vos clés API avec rotation, révocation et scopes granulaires." },
          { icon: BarChart2, title: "Analytics", sub: "usage en temps réel", desc: "Suivez vos appels, latences et taux d'erreur en temps réel." },
          { icon: FlaskConical, title: "Sandbox", sub: "environnement de test", desc: "Testez en toute sécurité avec des wallets de test et des données simulées." },
        ].map(({ icon: Icon, title, sub, desc }) => (
          <motion.div key={title} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="p-6 bg-secondary/20 border-border/40 hover:border-primary/30 transition-colors text-center">
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                <Icon className="w-6 h-6 text-primary" />
              </div>
              <div className="font-semibold text-foreground mb-0.5">{title}</div>
              <div className="text-xs text-primary/80 mb-2">— {sub}</div>
              <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Plan comparison */}
      <div className="max-w-4xl mx-auto px-4 mb-16">
        <h2 className="text-2xl font-bold text-foreground text-center mb-8">Plans tarifaires</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {PLANS.map((plan) => (
            <Card key={plan.tier} className={`p-5 border ${plan.color} relative`}>
              {plan.popular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge className="bg-violet-600 text-white text-xs px-2">Populaire</Badge>
                </div>
              )}
              <div className={`inline-block text-xs font-bold px-2 py-0.5 rounded mb-3 ${plan.badge}`}>
                {plan.name}
              </div>
              <div className="text-sm font-semibold text-foreground mb-3">{plan.requests}</div>
              <div className="space-y-1.5">
                {plan.scopes.map(s => (
                  <div key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Registration Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-background border-border/50 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">Créer un compte développeur</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Prénom</Label>
                <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                  className="bg-secondary/30 border-border/40" placeholder="Jean" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Nom</Label>
                <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                  className="bg-secondary/30 border-border/40" placeholder="Dupont" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Téléphone</Label>
              <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="bg-secondary/30 border-border/40" placeholder="+221 77 000 0000" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">PIN (6 chiffres)</Label>
              <Input type="password" maxLength={6} value={form.pin} onChange={e => setForm(f => ({ ...f, pin: e.target.value }))}
                className="bg-secondary/30 border-border/40 font-mono" placeholder="••••••" />
            </div>
            <Button className="w-full bg-primary hover:bg-primary/90" onClick={handleRegister} disabled={loading}>
              {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Création...</> : "Créer mon compte"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New API Key reveal Dialog */}
      <Dialog open={!!newApiKey} onOpenChange={() => {}}>
        <DialogContent className="bg-background border-border/50 max-w-lg" onPointerDownOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="w-5 h-5" /> Compte créé avec succès !
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Votre première clé API sandbox (plan <strong className="text-foreground">Free</strong>) a été générée.
            </p>
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/40">
              <div className="text-xs font-bold text-amber-400 mb-2 flex items-center gap-1.5">
                ⚠️ Copiez cette clé maintenant. Elle ne sera plus affichée.
              </div>
              <code className="text-xs font-mono text-amber-200 break-all block">{newApiKey}</code>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 gap-2" onClick={handleCopyKey}>
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copié !" : "Copier la clé"}
              </Button>
              <Button className="flex-1 bg-primary hover:bg-primary/90" onClick={handleContinue}>
                Continuer →
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
