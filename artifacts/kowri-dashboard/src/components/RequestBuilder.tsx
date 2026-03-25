import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Send, ChevronDown, ChevronUp } from "lucide-react";

interface RequestBuilderProps {
  defaultEndpoint?: string;
  apiKey?: string;
  baseUrl?: string;
  suggestions?: string[];
}

const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
type Method = typeof METHODS[number];

const METHOD_COLORS: Record<Method, string> = {
  GET:    "bg-blue-500/20 text-blue-400 border-blue-500/30",
  POST:   "bg-green-500/20 text-green-400 border-green-500/30",
  PATCH:  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  DELETE: "bg-red-500/20 text-red-400 border-red-500/30",
};

function syntaxHighlight(json: string): string {
  return json
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = "text-yellow-300";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "text-blue-300" : "text-green-300";
      } else if (/true|false/.test(match)) {
        cls = "text-purple-300";
      } else if (/null/.test(match)) {
        cls = "text-red-300";
      }
      return `<span class="${cls}">${match}</span>`;
    });
}

export function RequestBuilder({ defaultEndpoint = "/wallet/balance", apiKey = "", baseUrl = "/api", suggestions = [] }: RequestBuilderProps) {
  const [method, setMethod] = useState<Method>("GET");
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [headersText, setHeadersText] = useState(
    apiKey ? `Authorization: Bearer ${apiKey}\nContent-Type: application/json` : "Content-Type: application/json"
  );
  const [bodyText, setBodyText] = useState("{}");
  const [response, setResponse] = useState<{ status: number; body: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showBody, setShowBody] = useState(false);

  const parseHeaders = (text: string): Record<string, string> => {
    return text.split("\n").reduce<Record<string, string>>((acc, line) => {
      const idx = line.indexOf(":");
      if (idx > 0) acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      return acc;
    }, {});
  };

  const handleSend = async () => {
    setLoading(true);
    setResponse(null);
    try {
      const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
      const headers = parseHeaders(headersText);
      const options: RequestInit = { method, headers };
      if (method !== "GET" && bodyText.trim() !== "{}") {
        options.body = bodyText;
      }
      const res = await fetch(url, options);
      const text = await res.text();
      let formatted = text;
      try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      setResponse({ status: res.status, body: formatted });
    } catch (e: any) {
      setResponse({ status: 0, body: JSON.stringify({ error: e.message }, null, 2) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
          <SelectTrigger className="w-28 bg-secondary/30 border-border/40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map(m => (
              <SelectItem key={m} value={m}>
                <Badge variant="outline" className={`text-xs font-mono ${METHOD_COLORS[m]}`}>{m}</Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Input
            value={endpoint}
            onChange={e => { setEndpoint(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            className="font-mono text-sm bg-secondary/30 border-border/40"
            placeholder="/wallet/balance"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-background border border-border/50 rounded-lg z-50 max-h-40 overflow-y-auto shadow-xl">
              {suggestions
                .filter(s => s.toLowerCase().includes(endpoint.toLowerCase()))
                .slice(0, 8)
                .map(s => (
                  <button key={s} className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                    onClick={() => { setEndpoint(s); setShowSuggestions(false); }}>
                    {s}
                  </button>
                ))}
            </div>
          )}
        </div>

        <Button onClick={handleSend} disabled={loading} className="gap-2 bg-primary hover:bg-primary/90">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Envoyer
        </Button>
      </div>

      <div>
        <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-1.5"
          onClick={() => setShowBody(!showBody)}>
          {showBody ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {showBody ? "Masquer" : "Headers & Body"}
        </button>
        {showBody && (
          <div className="space-y-2">
            <textarea
              value={headersText}
              onChange={e => setHeadersText(e.target.value)}
              rows={3}
              className="w-full font-mono text-xs bg-secondary/20 border border-border/40 rounded-lg p-2.5 text-foreground resize-none focus:outline-none focus:border-primary/50"
              placeholder="Authorization: Bearer kowri_..."
            />
            {method !== "GET" && (
              <textarea
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                rows={4}
                className="w-full font-mono text-xs bg-secondary/20 border border-border/40 rounded-lg p-2.5 text-foreground resize-none focus:outline-none focus:border-primary/50"
                placeholder='{"key": "value"}'
              />
            )}
          </div>
        )}
      </div>

      {response && (
        <div className="rounded-lg bg-secondary/10 border border-border/40 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-secondary/20">
            <Badge variant="outline" className={`text-xs font-mono ${
              response.status >= 200 && response.status < 300
                ? "border-green-500/30 text-green-400 bg-green-500/10"
                : "border-red-500/30 text-red-400 bg-red-500/10"
            }`}>
              {response.status || "Error"}
            </Badge>
            <span className="text-xs text-muted-foreground">Response</span>
          </div>
          <pre
            className="p-3 text-xs font-mono overflow-x-auto max-h-64 text-slate-300"
            dangerouslySetInnerHTML={{ __html: syntaxHighlight(response.body) }}
          />
        </div>
      )}
    </div>
  );
}
