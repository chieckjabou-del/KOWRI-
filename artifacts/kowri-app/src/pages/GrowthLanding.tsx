import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function GrowthLanding() {
  return (
    <div className="min-h-screen bg-[#FAFAF8] px-6 py-10">
      <div className="mx-auto flex max-w-md flex-col gap-8">
        <div className="pt-6">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1A6B32] text-2xl font-black text-white">
            A
          </div>
          <h1 className="text-3xl font-black tracking-tight text-gray-900">AKWÊ</h1>
          <p className="mt-2 text-sm text-gray-600">
            Paiements, tontines et epargne mobile pour accelerer ta croissance financiere.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">Pourquoi rejoindre maintenant ?</p>
          <ul className="mt-3 space-y-2 text-sm text-gray-600">
            <li>• Tontines simples avec suivi en temps reel.</li>
            <li>• Envois rapides et securises en FCFA.</li>
            <li>• Bonus de bienvenue apres premiere operation eligible.</li>
          </ul>
        </div>

        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-800">
          Connexion chiffree. Donnees protegees. Support local disponible.
        </div>

        <div className="space-y-3">
          <Link href="/register">
            <Button className="h-12 w-full rounded-xl bg-black text-white hover:bg-black/90">
              Creer mon compte
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="outline" className="h-12 w-full rounded-xl">
              J'ai deja un compte
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
