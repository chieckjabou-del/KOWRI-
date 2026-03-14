import { useListMerchants } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Store, Key, Activity } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";

export default function Merchants() {
  const { data, isLoading } = useListMerchants();
  const merchants = data?.merchants || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Merchants</h1>
          <p className="text-muted-foreground mt-1">Business accounts and API access</p>
        </div>
        <Button className="rounded-xl bg-primary text-primary-foreground">Register Merchant</Button>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40 hover:bg-transparent">
              <TableHead>Business</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total Revenue</TableHead>
              <TableHead className="text-right">Tx Count</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Integration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center">Loading...</TableCell></TableRow>
            ) : merchants.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No merchants registered.</TableCell></TableRow>
            ) : (
              merchants.map(m => (
                <TableRow key={m.id} className="border-border/40">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                        <Store className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{m.businessName}</div>
                        <div className="text-xs text-muted-foreground">{m.businessType} • {m.country}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={m.status === 'active' ? 'border-emerald-500/30 text-emerald-500' : ''}>
                      {m.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-bold text-emerald-500">
                    {formatCurrency(m.totalRevenue, 'XOF')}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>{m.transactionCount}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(m.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="h-8 rounded-lg text-xs font-mono bg-secondary/50">
                      <Key className="w-3 h-3 mr-2" /> {m.apiKey ? 'Revoke Key' : 'Generate Key'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
