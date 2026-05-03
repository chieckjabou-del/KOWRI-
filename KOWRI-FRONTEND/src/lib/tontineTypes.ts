export const TYPE_META: Record<string, { label: string; icon: string; colorClass: string; desc: string }> = {
  classic:    { label: "Classique",      icon: "🤝", colorClass: "bg-green-100 text-green-800",   desc: "Rotation mensuelle classique entre membres" },
  investment: { label: "Investissement", icon: "📈", colorClass: "bg-blue-100 text-blue-800",     desc: "Fonds commun d'investissement" },
  project:    { label: "Projet",         icon: "🎯", colorClass: "bg-amber-100 text-amber-800",   desc: "Achat collectif avec objectif" },
  solidarity: { label: "Solidarité",     icon: "💜", colorClass: "bg-purple-100 text-purple-800", desc: "Fonds d'entraide communautaire" },
  business:   { label: "Business",       icon: "🏪", colorClass: "bg-teal-100 text-teal-800",     desc: "Croissance d'activité commerciale" },
  diaspora:   { label: "Diaspora",       icon: "🌍", colorClass: "bg-indigo-100 text-indigo-800", desc: "Multi-pays, multi-devises" },
  yield:      { label: "Rendement",      icon: "💰", colorClass: "bg-orange-100 text-orange-800", desc: "Intérêts pour les premiers payés" },
  growth:     { label: "Croissance",     icon: "🌱", colorClass: "bg-lime-100 text-lime-800",     desc: "Cotisation qui croît à chaque cycle" },
  hybrid:     { label: "Hybride",        icon: "⚡", colorClass: "bg-green-50 text-green-800",    desc: "Combine rotation, investissement, solidarité et rendement" },
};

export const STATUS_META: Record<string, { label: string; colorClass: string }> = {
  active:    { label: "Actif",      colorClass: "bg-green-100 text-green-800"   },
  pending:   { label: "En attente", colorClass: "bg-yellow-100 text-yellow-800" },
  completed: { label: "Complété",   colorClass: "bg-gray-100 text-gray-600"     },
  cancelled: { label: "Annulé",     colorClass: "bg-red-100 text-red-800"       },
};

export const FREQ_LABELS: Record<string, string> = {
  weekly:   "Hebdomadaire",
  biweekly: "Bimensuel",
  monthly:  "Mensuel",
};
