import { format } from "date-fns";

export function formatCurrency(amount: number, currency: string = "XOF") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateString: string | undefined | null) {
  if (!dateString) return "N/A";
  try {
    return format(new Date(dateString), "MMM d, yyyy h:mm a");
  } catch (e) {
    return dateString;
  }
}

export function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US").format(num);
}
