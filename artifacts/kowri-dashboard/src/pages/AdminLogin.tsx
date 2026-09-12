import { useState, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ShieldCheck, KeyRound, LogOut } from "lucide-react";
import {
  adminLogin, adminChangePassword, adminLogout, getAdminSession,
  type AdminSession,
} from "@/lib/adminAuth";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4 py-10 relative">
      <div className="absolute inset-0 opacity-20 pointer-events-none"
           style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/kowri-bg-mesh.png)`, backgroundSize: "cover", backgroundPosition: "center" }} />
      <div className="relative z-10 w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-2xl font-bold">K</span>
          </div>
          <div>
            <div className="text-primary font-bold leading-tight">KOWRI</div>
            <div className="text-xs text-muted-foreground">Back-office opérateurs</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function ChangePasswordForm({ session, onDone }: { session: AdminSession; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError("Les deux mots de passe ne correspondent pas"); return; }
    setBusy(true);
    try {
      await adminChangePassword(current, next);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec du changement de mot de passe");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border border-border/40 bg-card/70 backdrop-blur-xl rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="w-5 h-5 text-primary" /> Nouveau mot de passe requis</CardTitle>
        <CardDescription>
          Bonjour {session.admin.name}. Ce compte utilise un mot de passe provisoire : choisissez-en un nouveau
          (12 caractères minimum, lettres et chiffres) avant de continuer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="current">Mot de passe provisoire</Label>
            <Input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next">Nouveau mot de passe</Label>
            <Input id="next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm">Confirmer</Label>
            <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} />
          </div>
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1 rounded-xl" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer et continuer"}</Button>
            <Button type="button" variant="ghost" className="rounded-xl" onClick={() => adminLogout()}><LogOut className="w-4 h-4" /></Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AdminSession | null>(() => {
    const s = getAdminSession();
    return s?.admin.mustChangePassword ? s : null;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await adminLogin(email.trim(), password);
      if (session.admin.mustChangePassword) setPending(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion impossible");
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <Shell>
        <ChangePasswordForm session={pending} onDone={() => setPending(null)} />
      </Shell>
    );
  }

  return (
    <Shell>
      <Card className="border border-border/40 bg-card/70 backdrop-blur-xl rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" /> Connexion opérateur</CardTitle>
          <CardDescription>Accès nominatif au back-office. Chaque action est journalisée à votre nom.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Mot de passe</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            <Button type="submit" className="w-full rounded-xl" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</Button>
          </form>
          <p className="text-xs text-muted-foreground mt-4">
            Pas de compte ? Un super administrateur peut en créer un depuis Admin → Utilisateurs, ou via
            <code className="mx-1">POST /api/admin/auth/users</code>. Cinq échecs verrouillent l'accès 15 minutes.
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}
