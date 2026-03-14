import { useState } from "react";
import { useListTransactions } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ArrowUpRight, ArrowDownLeft, Filter } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";

export default function Transactions() {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  
  const { data, isLoading } = useListTransactions({
    type: filterType !== "all" ? filterType as any : undefined,
    status: filterStatus !== "all" ? filterStatus as any : undefined,
    limit: 50
  });

  const transactions = data?.transactions || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Global Ledger</h1>
        <p className="text-muted-foreground mt-1">Real-time view of all network transactions</p>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden flex flex-col h-[calc(100vh-200px)] min-h-[500px]">
        <div className="p-4 border-b border-border/40 flex flex-wrap items-center gap-4 bg-secondary/20 shrink-0">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input 
              placeholder="Search references, IDs..." 
              className="pl-9 bg-background/50 border-border/50 rounded-xl h-10 w-full"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-[160px] bg-background/50 border-border/50 rounded-xl h-10">
                <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="deposit">Deposit</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
                <SelectItem value="merchant_payment">Merchant Payment</SelectItem>
                <SelectItem value="tontine_contribution">Tontine Contribution</SelectItem>
                <SelectItem value="loan_disbursement">Loan Disbursement</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-[140px] bg-background/50 border-border/50 rounded-xl h-10">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        
        <div className="overflow-y-auto flex-1 relative">
          <Table>
            <TableHeader className="bg-secondary/30 sticky top-0 z-20 backdrop-blur-md">
              <TableRow className="border-border/40 hover:bg-transparent">
                <TableHead className="w-[180px]">Reference / ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Wallets (From → To)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({length: 10}).map((_, i) => (
                  <TableRow key={i} className="border-border/40">
                    <TableCell><div className="h-6 w-32 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-48 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-20 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-32 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg ml-auto"></div></TableCell>
                  </TableRow>
                ))
              ) : transactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No transactions found for the selected filters.
                  </TableCell>
                </TableRow>
              ) : (
                transactions.map((tx) => {
                  const isCredit = tx.type === 'deposit' || tx.type === 'loan_disbursement';
                  return (
                    <TableRow key={tx.id} className="border-border/40 hover:bg-secondary/20 transition-colors">
                      <TableCell>
                        <div className="font-medium">{tx.reference}</div>
                        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{tx.id}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-md ${isCredit ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>
                            {isCredit ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                          </div>
                          <span className="capitalize text-sm font-medium">{tx.type.replace('_', ' ')}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                          <span className="truncate max-w-[100px]" title={tx.fromWalletId || 'System'}>{tx.fromWalletId || 'System'}</span>
                          <span className="text-border">→</span>
                          <span className="truncate max-w-[100px]" title={tx.toWalletId || 'System'}>{tx.toWalletId || 'System'}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`
                          ${tx.status === 'completed' ? 'border-emerald-500/30 text-emerald-500 bg-emerald-500/5' : ''}
                          ${tx.status === 'pending' ? 'border-amber-500/30 text-amber-500 bg-amber-500/5' : ''}
                          ${tx.status === 'failed' ? 'border-destructive/30 text-destructive bg-destructive/5' : ''}
                          ${tx.status === 'reversed' ? 'border-purple-500/30 text-purple-500 bg-purple-500/5' : ''}
                        `}>
                          {tx.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(tx.createdAt)}
                      </TableCell>
                      <TableCell className={`text-right font-bold ${isCredit ? 'text-emerald-500' : 'text-foreground'}`}>
                        {isCredit ? '+' : ''}{formatCurrency(tx.amount, tx.currency)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
