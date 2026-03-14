import { useListLoans, useListCreditScores } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Landmark, TrendingUp, AlertTriangle, ShieldCheck } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";

export default function Credit() {
  const { data: loansData, isLoading: loansLoading } = useListLoans({ limit: 10 });
  const { data: scoresData, isLoading: scoresLoading } = useListCreditScores({ limit: 5 });

  const loans = loansData?.loans || [];
  const scores = scoresData?.scores || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Credit Engine</h1>
        <p className="text-muted-foreground mt-1">Micro-loans and alternative credit scoring</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Overview Cards */}
        <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border border-border/40 bg-gradient-to-br from-indigo-500/10 to-card shadow-xl shadow-black/5 rounded-2xl">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <CardTitle className="text-sm text-muted-foreground font-medium">Active Portfolio</CardTitle>
                <Landmark className="w-4 h-4 text-indigo-500" />
              </div>
              <div className="text-3xl font-bold text-foreground mb-1">{formatCurrency(4500000, 'XOF')}</div>
              <p className="text-xs text-indigo-500 font-medium">+12% this month</p>
            </CardContent>
          </Card>
          <Card className="border border-border/40 bg-gradient-to-br from-emerald-500/10 to-card shadow-xl shadow-black/5 rounded-2xl">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <CardTitle className="text-sm text-muted-foreground font-medium">Repayment Rate</CardTitle>
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="text-3xl font-bold text-foreground mb-1">94.2%</div>
              <p className="text-xs text-emerald-500 font-medium">Healthy portfolio</p>
            </CardContent>
          </Card>
          <Card className="border border-border/40 bg-gradient-to-br from-amber-500/10 to-card shadow-xl shadow-black/5 rounded-2xl">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <CardTitle className="text-sm text-muted-foreground font-medium">Default Risk</CardTitle>
                <AlertTriangle className="w-4 h-4 text-amber-500" />
              </div>
              <div className="text-3xl font-bold text-foreground mb-1">5.8%</div>
              <p className="text-xs text-amber-500 font-medium">Requires attention</p>
            </CardContent>
          </Card>
        </div>

        {/* Loan List */}
        <Card className="lg:col-span-2 border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl flex flex-col">
          <CardHeader className="border-b border-border/20 pb-4">
            <CardTitle>Recent Loan Applications</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto flex-1">
            <Table>
              <TableHeader className="bg-secondary/30">
                <TableRow className="border-border/40 hover:bg-transparent">
                  <TableHead>User ID</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Terms</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loansLoading ? (
                  <TableRow><TableCell colSpan={5} className="h-32 text-center">Loading...</TableCell></TableRow>
                ) : loans.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No loans found.</TableCell></TableRow>
                ) : (
                  loans.map(loan => (
                    <TableRow key={loan.id} className="border-border/40">
                      <TableCell className="font-mono text-xs">{loan.userId.substring(0, 12)}...</TableCell>
                      <TableCell className="font-semibold">{formatCurrency(loan.amount, loan.currency)}</TableCell>
                      <TableCell>
                        <div className="text-sm">{loan.termDays} Days</div>
                        <div className="text-xs text-muted-foreground">{loan.interestRate}% APR</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`
                          ${loan.status === 'approved' ? 'border-primary/50 text-primary' : ''}
                          ${loan.status === 'disbursed' ? 'border-emerald-500/50 text-emerald-500' : ''}
                          ${loan.status === 'repaid' ? 'border-blue-500/50 text-blue-500 bg-blue-500/10' : ''}
                          ${loan.status === 'defaulted' ? 'border-destructive/50 text-destructive bg-destructive/10' : ''}
                          ${loan.status === 'pending' ? 'border-border text-muted-foreground' : ''}
                        `}>
                          {loan.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{formatDate(loan.createdAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* Credit Scores */}
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl flex flex-col">
          <CardHeader className="border-b border-border/20 pb-4">
            <CardTitle>Top Credit Profiles</CardTitle>
          </CardHeader>
          <div className="p-0">
            {scoresLoading ? (
               <div className="p-8 text-center text-muted-foreground">Loading scores...</div>
            ) : (
              <div className="divide-y divide-border/20">
                {scores.map(score => (
                  <div key={score.userId} className="p-4 hover:bg-secondary/20 transition-colors flex items-center justify-between">
                    <div>
                      <div className="font-mono text-xs text-muted-foreground mb-1">{score.userId.substring(0, 8)}</div>
                      <Badge variant="outline" className={`
                        ${score.tier === 'platinum' ? 'bg-slate-300 text-slate-900 border-slate-400' : ''}
                        ${score.tier === 'gold' ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30' : ''}
                        ${score.tier === 'silver' ? 'bg-zinc-400/20 text-zinc-400 border-zinc-400/30' : ''}
                        ${score.tier === 'bronze' ? 'bg-orange-800/20 text-orange-600 border-orange-800/30' : ''}
                      `}>
                        {score.tier.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold font-display text-primary">{score.score}</div>
                      <div className="text-xs text-muted-foreground">Max: {formatCurrency(score.maxLoanAmount, 'XOF')}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
