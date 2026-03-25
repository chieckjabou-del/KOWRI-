import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Loader2, ChevronRight, Play, Copy, Check } from "lucide-react";
import { RequestBuilder } from "@/components/RequestBuilder";
import { devApiFetch } from "@/lib/devAuth";

interface ApiEndpoint {
  method: string; path: string; scope: string; description: string;
}
interface ApiDocs {
  version: string; title: string; baseUrl: string; authScheme: string;
  endpoints: ApiEndpoint[];
  sdks: string[];
  environments: { sandbox: string; production: string };
}

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-blue-500/20 text-blue-400 border-blue-500/30",
  POST:   "bg-green-500/20 text-green-400 border-green-500/30",
  PATCH:  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  DELETE: "bg-red-500/20 text-red-400 border-red-500/30",
};

const CATEGORIES: { id: string; label: string; prefix: string }[] = [
  { id: "auth",         label: "Authentication",  prefix: "auth" },
  { id: "wallets",      label: "Wallets",          prefix: "/wallet" },
  { id: "transactions", label: "Transactions",     prefix: "/transaction" },
  { id: "merchants",    label: "Marchands",        prefix: "/merchant" },
  { id: "fx",           label: "Change (FX)",      prefix: "/fx" },
  { id: "tontines",     label: "Tontines",         prefix: "/tontine" },
  { id: "credit",       label: "Crédit",           prefix: "/credit" },
  { id: "analytics",    label: "Analytics",        prefix: "/analytics" },
  { id: "webhooks",     label: "Webhooks",         prefix: "/webhook" },
];

const ENDPOINT_PARAMS: Record<string, {
  params?: { name: string; type: string; required: boolean; desc: string }[];
  example?: object;
  codes?: { code: number; desc: string }[];
}> = {
  "POST /wallet/create": {
    params: [
      { name: "userId", type: "string", required: true,  desc: "Owner user ID" },
      { name: "currency", type: "string", required: true, desc: "ISO 4217 code (XOF, USD, EUR)" },
      { name: "type", type: "string", required: false, desc: "personal | merchant | savings" },
    ],
    example: { walletId: "wal_abc123", currency: "XOF", balance: 0, status: "active" },
    codes: [{ code: 201, desc: "Wallet created" }, { code: 409, desc: "Duplicate wallet" }],
  },
  "GET /wallet/balance": {
    params: [{ name: "walletId", type: "string", required: true, desc: "Wallet identifier" }],
    example: { walletId: "wal_abc123", balance: 150000, currency: "XOF", lastUpdated: "2026-03-25T10:00:00Z" },
    codes: [{ code: 200, desc: "Balance returned" }, { code: 404, desc: "Wallet not found" }],
  },
  "POST /wallet/transfer": {
    params: [
      { name: "fromWalletId", type: "string", required: true,  desc: "Source wallet" },
      { name: "toWalletId",   type: "string", required: true,  desc: "Destination wallet" },
      { name: "amount",       type: "number", required: true,  desc: "Amount in smallest unit (XOF cents)" },
      { name: "reference",    type: "string", required: false, desc: "Idempotency key" },
    ],
    example: { transactionId: "txn_xyz789", status: "completed", amount: 5000, fee: 25 },
    codes: [{ code: 200, desc: "Transfer success" }, { code: 402, desc: "Insufficient funds" }, { code: 422, desc: "Invalid amount" }],
  },
  "GET /fx/rates/:from/:to": {
    params: [
      { name: "from", type: "string", required: true, desc: "Source currency (e.g. EUR)" },
      { name: "to",   type: "string", required: true, desc: "Target currency (e.g. XOF)" },
    ],
    example: { from: "EUR", to: "XOF", rate: 655.957, mid: 655.957, timestamp: "2026-03-25T10:00:00Z" },
    codes: [{ code: 200, desc: "Rate returned" }, { code: 404, desc: "Pair not supported" }],
  },
};

const AUTH_SECTION = {
  id: "auth",
  content: (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        All requests must include an <code className="text-primary bg-primary/10 px-1 rounded">Authorization</code> header with your API key.
      </p>
      <div className="rounded-lg bg-secondary/20 border border-border/40 p-4">
        <pre className="text-xs font-mono text-slate-300">
{`Authorization: Bearer kowri_fre_a1b2c3d4_...

curl https://api.kowri.io/v1/wallet/balance \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json"`}
        </pre>
      </div>
      <div className="text-sm text-muted-foreground">
        API keys are environment-specific — use <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 mx-1">SANDBOX</Badge> keys for testing.
      </div>
    </div>
  ),
};

function EndpointSection({ ep, sandboxMode }: { ep: ApiEndpoint; sandboxMode: boolean }) {
  const [open, setOpen] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = ENDPOINT_PARAMS[`${ep.method} ${ep.path}`];
  const exampleJson = detail?.example ? JSON.stringify(detail.example, null, 2) : '{ "status": "ok" }';

  return (
    <div className="border border-border/40 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-5 py-4 bg-secondary/20 hover:bg-secondary/30 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <Badge variant="outline" className={`text-xs font-mono shrink-0 ${METHOD_COLORS[ep.method] || ""}`}>
          {ep.method}
        </Badge>
        <code className="text-sm font-mono text-foreground flex-1">{ep.path}</code>
        <span className="text-xs text-muted-foreground hidden md:block">{ep.description}</span>
        <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="px-5 py-5 space-y-5 border-t border-border/30">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">{ep.description}</span>
            <Badge variant="outline" className="text-xs font-mono border-primary/30 text-primary/80">{ep.scope}</Badge>
          </div>

          {detail?.params && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Paramètres</h4>
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30">
                    <TableHead className="text-xs">Nom</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">Requis</TableHead>
                    <TableHead className="text-xs">Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.params.map(p => (
                    <TableRow key={p.name} className="border-border/20">
                      <TableCell className="font-mono text-xs text-primary">{p.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{p.type}</TableCell>
                      <TableCell>{p.required ? <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">oui</Badge> : <span className="text-xs text-muted-foreground">non</span>}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.desc}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exemple de réponse</h4>
              <button onClick={async () => {
                await navigator.clipboard.writeText(exampleJson).catch(() => {});
                setCopied(true); setTimeout(() => setCopied(false), 2000);
              }} className="text-muted-foreground hover:text-foreground">
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <pre className="rounded-lg bg-secondary/10 border border-border/30 p-3 text-xs font-mono text-emerald-300 overflow-x-auto">
              {exampleJson}
            </pre>
          </div>

          {detail?.codes && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Codes de statut</h4>
              <div className="flex flex-wrap gap-2">
                {detail.codes.map(c => (
                  <div key={c.code} className="flex items-center gap-1.5 text-xs">
                    <Badge variant="outline" className={`font-mono ${c.code < 300 ? "border-green-500/30 text-green-400" : "border-red-500/30 text-red-400"}`}>
                      {c.code}
                    </Badge>
                    <span className="text-muted-foreground">{c.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sandboxMode && (
            <div>
              <Button size="sm" variant="outline" className="gap-2 border-primary/30 text-primary hover:bg-primary/10"
                onClick={() => setShowBuilder(!showBuilder)}>
                <Play className="w-3.5 h-3.5" /> {showBuilder ? "Fermer" : "Tester"}
              </Button>
              {showBuilder && (
                <div className="mt-3 p-4 rounded-xl bg-secondary/10 border border-border/30">
                  <RequestBuilder defaultEndpoint={ep.path} baseUrl="/api" suggestions={[ep.path]} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DeveloperDocs() {
  const [activeCategory, setActiveCategory] = useState("wallets");

  const { data, isLoading } = useQuery({
    queryKey: ["dev-docs"],
    queryFn: () => devApiFetch<ApiDocs>("/developer/docs"),
  });

  const byCategory = (catPrefix: string) => {
    if (!data?.endpoints) return [];
    return data.endpoints.filter(e => e.path.startsWith(catPrefix));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Documentation API</h1>
        {data && (
          <p className="text-muted-foreground mt-1">
            v{data.version} · <code className="text-xs font-mono text-primary/80">{data.baseUrl}</code>
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="flex gap-6">
          {/* Sidebar */}
          <div className="w-52 shrink-0 space-y-1 sticky top-0 self-start">
            {CATEGORIES.map(cat => (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors ${
                  activeCategory === cat.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}>
                {cat.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 space-y-4">
            {activeCategory === "auth" ? (
              <Card className="p-6 bg-secondary/20 border-border/40">
                <h2 className="text-xl font-semibold mb-4">Authentication</h2>
                {AUTH_SECTION.content}
              </Card>
            ) : (
              <>
                <h2 className="text-xl font-semibold">
                  {CATEGORIES.find(c => c.id === activeCategory)?.label}
                </h2>
                {(() => {
                  const cat = CATEGORIES.find(c => c.id === activeCategory);
                  const eps = cat ? byCategory(cat.prefix) : [];
                  return eps.length === 0 ? (
                    <Card className="p-8 text-center bg-secondary/10 border-border/30">
                      <p className="text-sm text-muted-foreground">Aucun endpoint disponible dans cette catégorie.</p>
                    </Card>
                  ) : (
                    <div className="space-y-3">
                      {eps.map(ep => (
                        <EndpointSection key={`${ep.method}-${ep.path}`} ep={ep} sandboxMode={true} />
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
