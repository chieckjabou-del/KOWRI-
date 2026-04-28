import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, Loader2, Plus, Sparkles, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { formatXOF } from "@/lib/api";
import {
  createTontine,
  joinTontine,
  listPublicTontines,
  listUserTontines,
} from "@/services/api/tontineService";
import type { TontineFrequency } from "@/types/akwe";

const FREQUENCIES: TontineFrequency[] = ["weekly", "biweekly", "monthly"];
const FREQ_LABEL: Record<TontineFrequency, string> = {
  weekly: "Hebdo",
  biweekly: "Bimensuel",
  monthly: "Mensuel",
};

export default function TontineHome() {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("50000");
  const [maxMembers, setMaxMembers] = useState("10");
  const [frequency, setFrequency] = useState<TontineFrequency>("monthly");
  const [createError, setCreateError] = useState("");

  const userTontinesQuery = useQuery({
    queryKey: ["akwe-tontines", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => listUserTontines(token),
  });

  const publicTontinesQuery = useQuery({
    queryKey: ["akwe-public-tontines"],
    enabled: Boolean(user?.id),
    queryFn: () => listPublicTontines(token),
  });

  const myTontines = userTontinesQuery.data?.tontines ?? [];
  const discoverTontines = useMemo(() => {
    const ownIds = new Set(myTontines.map((item) => item.id));
    return (publicTontinesQuery.data?.tontines ?? []).filter((item) => !ownIds.has(item.id));
  }, [myTontines, publicTontinesQuery.data?.tontines]);

  const usingMock = Boolean(userTontinesQuery.data?.usingMock || publicTontinesQuery.data?.usingMock);

  const joinMutation = useMutation({
    mutationFn: async (tontineId: string) => {
      if (!user) return;
      await joinTontine(token, tontineId, user.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontines", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-public-tontines"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user) return { tontineId: "", usingMock: false };
      const payloadName = name.trim() || "Nouvelle tontine";
      const result = await createTontine(token, user.id, {
        name: payloadName,
        contributionAmount: Number(amount),
        maxMembers: Number(maxMembers),
        frequency,
        tontineType: "classic",
      });
      return result;
    },
    onSuccess: async (result) => {
      setShowCreate(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontines", user?.id] });
      if (result.tontineId) {
        navigate(`/tontine/${result.tontineId}`);
      }
    },
    onError: (error: unknown) => {
      setCreateError(error instanceof Error ? error.message : "Creation impossible");
    },
  });

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Tontine" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-5">
        {usingMock && (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: fallback visuel active pour garantir la demo.
          </div>
        )}

        <Card className="rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Mes tontines</CardTitle>
            <Button className="rounded-xl bg-black text-white hover:bg-black/90" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Creer
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {userTontinesQuery.isLoading ? (
              <p className="text-sm text-gray-500">Chargement des tontines...</p>
            ) : myTontines.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                Aucune tontine active. Creez votre premiere tontine pour demarrer.
              </div>
            ) : (
              myTontines.map((item) => (
                <Link key={item.id} href={`/tontine/${item.id}`}>
                  <div className="cursor-pointer rounded-2xl border border-gray-100 px-4 py-4 transition hover:border-black/15">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-black">{item.name}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {formatXOF(item.contributionAmount)} - {item.memberCount}/{item.maxMembers} membres
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                        {FREQ_LABEL[item.frequency]}
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="mt-3 h-1.5 rounded-full bg-gray-100">
                      <div
                        className="h-1.5 rounded-full bg-black"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((item.currentRound / Math.max(item.totalRounds, 1)) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-black/5 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Rejoindre une tontine</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {publicTontinesQuery.isLoading ? (
              <p className="text-sm text-gray-500">Chargement des tontines publiques...</p>
            ) : discoverTontines.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                Aucune tontine publique disponible.
              </div>
            ) : (
              discoverTontines.slice(0, 6).map((item) => (
                <div key={item.id} className="rounded-2xl border border-gray-100 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-black">{item.name}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        {formatXOF(item.contributionAmount)} - {FREQ_LABEL[item.frequency]}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="rounded-xl"
                      onClick={() => joinMutation.mutate(item.id)}
                      disabled={joinMutation.isPending}
                    >
                      {joinMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Rejoindre
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <section className="grid gap-3 sm:grid-cols-2">
          <Card className="rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <Users className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Suivi des cotisations</p>
                <p className="mt-1 text-xs text-gray-500">
                  Badge paye/en retard et indicateurs de fiabilite membre.
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <Sparkles className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Timeline intelligente</p>
                <p className="mt-1 text-xs text-gray-500">
                  Vision claire des tours passes, en cours et a venir.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Creer une tontine</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nom de la tontine"
              className="h-11 rounded-xl"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="numeric"
                placeholder="Cotisation XOF"
                className="h-11 rounded-xl"
              />
              <Input
                value={maxMembers}
                onChange={(event) => setMaxMembers(event.target.value)}
                inputMode="numeric"
                placeholder="Nb membres"
                className="h-11 rounded-xl"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {FREQUENCIES.map((freq) => (
                <Button
                  key={freq}
                  type="button"
                  variant={frequency === freq ? "default" : "outline"}
                  className="rounded-xl"
                  onClick={() => setFrequency(freq)}
                >
                  {FREQ_LABEL[freq]}
                </Button>
              ))}
            </div>
            {createError ? (
              <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                {createError}
              </div>
            ) : null}
            <Button
              className="w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={() => {
                setCreateError("");
                const amountValue = Number(amount);
                const membersValue = Number(maxMembers);
                if (!Number.isFinite(amountValue) || amountValue <= 0) {
                  setCreateError("Montant de cotisation invalide.");
                  return;
                }
                if (!Number.isFinite(membersValue) || membersValue < 2) {
                  setCreateError("Le nombre de membres doit etre >= 2.");
                  return;
                }
                createMutation.mutate();
              }}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Creer maintenant
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
}
