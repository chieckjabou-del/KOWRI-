import type { TontineMember, TontineTimelineEvent } from "@/types/akwe";

export function tontineHealthColor(label: TontineMember["reliabilityLabel"]): string {
  if (label === "excellent") return "text-emerald-700 bg-emerald-50";
  if (label === "good") return "text-blue-700 bg-blue-50";
  return "text-amber-700 bg-amber-50";
}

export function timelineBulletColor(status: TontineTimelineEvent["status"]): string {
  if (status === "done") return "bg-emerald-500";
  if (status === "current") return "bg-black";
  return "bg-gray-300";
}

export function nextReceiverLabel(name?: string): string {
  return name ? `Prochaine personne a recevoir: ${name}` : "Prochain receveur a definir";
}
