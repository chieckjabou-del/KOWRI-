import { useState } from "react";
import { useListWallets, useCreateWallet } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Wallet as WalletIcon, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Wallets() {
  const { data, isLoading } = useListWallets();
  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { mutate: createWallet, isPending } = useCreateWallet({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
        setIsDialogOpen(false);
        toast({ title: "Wallet created", description: "New wallet provisioned successfully." });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Creation failed", description: err.message || "An error occurred" });
      }
    }
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createWallet({
      data: {
        userId: formData.get("userId") as string,
        currency: formData.get("currency") as string,
        walletType: formData.get("walletType") as any,
      }
    });
  };

  const wallets = data?.wallets || [];
  const filteredWallets = wallets.filter(w => 
    w.id.includes(search) || w.userId.includes(search)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground mt-1">Manage accounts and balances across the network</p>
        </div>
        
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-xl shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-2" /> Provision Wallet
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px] bg-card border-border/50">
            <DialogHeader>
              <DialogTitle>Provision Wallet</DialogTitle>
              <DialogDescription>Create a new sub-wallet for a user or merchant.</DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="userId">User/Merchant ID</Label>
                <Input id="userId" name="userId" required className="bg-secondary/50 rounded-xl" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Select name="currency" defaultValue="XOF">
                    <SelectTrigger className="bg-secondary/50 rounded-xl">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="XOF">XOF (CFA Franc BCEAO)</SelectItem>
                      <SelectItem value="XAF">XAF (CFA Franc BEAC)</SelectItem>
                      <SelectItem value="USD">USD (US Dollar)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="walletType">Type</Label>
                  <Select name="walletType" defaultValue="personal">
                    <SelectTrigger className="bg-secondary/50 rounded-xl">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal</SelectItem>
                      <SelectItem value="merchant">Merchant</SelectItem>
                      <SelectItem value="savings">Savings</SelectItem>
                      <SelectItem value="tontine">Tontine Pool</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button type="submit" className="w-full rounded-xl mt-4" disabled={isPending}>
                {isPending ? "Provisioning..." : "Provision Wallet"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                <WalletIcon className="w-5 h-5 text-primary" />
              </div>
              <Badge variant="outline" className="bg-background/50 border-border/50 text-xs">Total XOF</Badge>
            </div>
            <div className="text-3xl font-bold text-foreground">
              {formatCurrency(wallets.filter(w => w.currency === 'XOF').reduce((acc, w) => acc + w.balance, 0), 'XOF')}
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                <WalletIcon className="w-5 h-5 text-blue-500" />
              </div>
              <Badge variant="outline" className="bg-background/50 border-border/50 text-xs">Total XAF</Badge>
            </div>
            <div className="text-3xl font-bold text-foreground">
              {formatCurrency(wallets.filter(w => w.currency === 'XAF').reduce((acc, w) => acc + w.balance, 0), 'XAF')}
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <ArrowUpRight className="w-5 h-5 text-emerald-500" />
              </div>
              <Badge variant="outline" className="bg-background/50 border-border/50 text-xs">Active Ratio</Badge>
            </div>
            <div className="text-3xl font-bold text-foreground">
              {wallets.length ? Math.round((wallets.filter(w => w.status === 'active').length / wallets.length) * 100) : 0}%
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-border/40 flex items-center justify-between bg-secondary/20">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input 
              placeholder="Search by Wallet ID or User ID..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-background/50 border-border/50 rounded-xl h-10"
            />
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-secondary/30">
              <TableRow className="border-border/40 hover:bg-transparent">
                <TableHead>Wallet ID</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({length: 5}).map((_, i) => (
                  <TableRow key={i} className="border-border/40">
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-20 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-16 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg ml-auto"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg ml-auto"></div></TableCell>
                    <TableCell><div className="h-8 w-20 ml-auto bg-secondary animate-pulse rounded-lg"></div></TableCell>
                  </TableRow>
                ))
              ) : filteredWallets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    No wallets found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredWallets.map((wallet) => (
                  <TableRow key={wallet.id} className="border-border/40 hover:bg-secondary/20 transition-colors">
                    <TableCell className="font-mono text-xs text-muted-foreground">{wallet.id}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{wallet.userId}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize bg-secondary/50 border-border/50">
                        {wallet.walletType}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={wallet.status === "active" ? "default" : "secondary"} className={`
                        ${wallet.status === 'active' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}
                        ${wallet.status === 'frozen' ? 'bg-destructive/10 text-destructive border-destructive/20' : ''}
                        ${wallet.status === 'closed' ? 'bg-secondary/50 text-muted-foreground border-border/50' : ''}
                      `}>
                        {wallet.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(wallet.balance, wallet.currency)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCurrency(wallet.availableBalance, wallet.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="rounded-lg h-8 text-xs hover:bg-secondary/80">
                        View Details
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
