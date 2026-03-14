import { useGetLedgerEntries } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { BookOpen } from "lucide-react";

export default function Ledger() {
  const { data, isLoading } = useGetLedgerEntries({ limit: 50 });
  const entries = data?.entries || [];

  // Double entry check
  const isBalanced = data ? Math.abs(data.totalDebits - data.totalCredits) < 0.01 : true;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">System Ledger</h1>
        <p className="text-muted-foreground mt-1">Immutable double-entry accounting audit trail</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className={`border ${isBalanced ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5'} backdrop-blur-xl rounded-2xl`}>
          <CardHeader className="py-4 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Ledger Integrity</CardTitle>
              <CardDescription>Total System Debits == Credits</CardDescription>
            </div>
            {isBalanced ? (
              <Badge className="bg-emerald-500 text-black hover:bg-emerald-500">BALANCED</Badge>
            ) : (
              <Badge variant="destructive">UNBALANCED - AUDIT REQUIRED</Badge>
            )}
          </CardHeader>
        </Card>
        
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardHeader className="py-4 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Total Processed Volume</CardTitle>
              <CardDescription>Aggregate system throughput</CardDescription>
            </div>
            <BookOpen className="w-5 h-5 text-primary" />
          </CardHeader>
        </Card>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40">
              <TableHead className="font-mono text-xs">Entry ID</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead>Timestamp</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center">Loading immutable ledger...</TableCell></TableRow>
            ) : entries.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No ledger entries generated.</TableCell></TableRow>
            ) : (
              entries.map((entry, index) => {
                // Group related entries with subtle alternating backgrounds
                const txGroupClass = index % 4 < 2 ? "bg-transparent" : "bg-secondary/10";
                
                return (
                  <TableRow key={entry.id} className={`border-border/20 ${txGroupClass} hover:bg-secondary/30`}>
                    <TableCell>
                      <div className="font-mono text-[10px] text-muted-foreground">{entry.id}</div>
                      <div className="font-mono text-[10px] text-primary/70" title="Transaction Ref">{entry.transactionId}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-background/50 text-[10px] border-border/50 uppercase tracking-wider">
                        {entry.eventType}
                      </Badge>
                      {entry.description && <div className="text-xs text-muted-foreground mt-1 truncate max-w-[200px]">{entry.description}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm">{entry.accountType}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{entry.accountId}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-blue-400">
                      {entry.debitAmount > 0 ? formatCurrency(entry.debitAmount, entry.currency) : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-emerald-400">
                      {entry.creditAmount > 0 ? formatCurrency(entry.creditAmount, entry.currency) : '-'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {formatDate(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
