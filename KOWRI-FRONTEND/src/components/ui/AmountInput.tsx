import { useRef } from "react";

interface AmountInputProps {
  value: string;
  onChange: (raw: string) => void;
  currency?: string;
  placeholder?: string;
  availableLabel?: string;
  availableAmount?: number | null;
  disabled?: boolean;
  autoFocus?: boolean;
}

function formatDisplay(raw: string): string {
  const n = parseFloat(raw.replace(/\s/g, ""));
  if (isNaN(n)) return "";
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

export function AmountInput({
  value,
  onChange,
  currency = "XOF",
  placeholder = "0",
  availableLabel = "Disponible",
  availableAmount,
  disabled = false,
  autoFocus = false,
}: AmountInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/[^\d]/g, "");
    onChange(raw);
  }

  const displayVal = formatDisplay(value);

  return (
    <div
      className="rounded-2xl border-2 border-gray-200 focus-within:border-[#1A6B32] bg-white transition-colors p-4"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={displayVal}
          onChange={handleChange}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className="flex-1 text-3xl font-bold text-gray-900 bg-transparent outline-none placeholder-gray-300 min-w-0"
        />
        <span className="text-lg font-semibold text-gray-400 flex-shrink-0">{currency}</span>
      </div>
      {availableAmount != null ? (
        <p className="text-xs text-gray-400 mt-1">
          {availableLabel} :{" "}
          <span className="font-semibold text-gray-600">
            {availableAmount.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} {currency}
          </span>
        </p>
      ) : null}
    </div>
  );
}
