import { useState } from "react";
import { useListTontines, useCreateTontine } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Users, Calendar, Coins, Clock, PiggyBank } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";

export default function Tontines() {
  const { data, isLoading } = useListTontines();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { mutate: createTontine, isPending } = useCreateTontine({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/tontines"] });
        setIsDialogOpen(false);
        toast({ title: "Tontine Created", description: "New savings group has been established." });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Creation failed", description: err.message || "An error occurred" });
      }
    }
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createTontine({
      data: {
        name: formData.get("name") as string,
        description: formData.get("description") as string,
        contributionAmount: Number(formData.get("amount")),
        currency: formData.get("currency") as string,
        frequency: formData.get("frequency") as any,
        maxMembers: Number(formData.get("maxMembers")),
        adminUserId: "admin-system-id", // mock
      }
    });
  };

  const tontines = data?.tontines || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tontines</h1>
          <p className="text-muted-foreground mt-1">Group savings and rotating credit associations</p>
        </div>
        
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-xl shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-2" /> Create Group
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px] bg-card border-border/50">
            <DialogHeader>
              <DialogTitle>Create Tontine Group</DialogTitle>
              <DialogDescription>Setup a new rotating savings pool.</DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Group Name</Label>
                <Input id="name" name="name" placeholder="Market Sellers Q1" required className="bg-secondary/50 rounded-xl" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="amount">Contribution Amount</Label>
                  <Input id="amount" name="amount" type="number" required className="bg-secondary/50 rounded-xl" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Select name="currency" defaultValue="XOF">
                    <SelectTrigger className="bg-secondary/50 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="XOF">XOF</SelectItem>
                      <SelectItem value="XAF">XAF</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="frequency">Frequency</Label>
                  <Select name="frequency" defaultValue="weekly">
                    <SelectTrigger className="bg-secondary/50 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Bi-weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxMembers">Max Members</Label>
                  <Input id="maxMembers" name="maxMembers" type="number" defaultValue="10" required className="bg-secondary/50 rounded-xl" />
                </div>
              </div>
              <Button type="submit" className="w-full rounded-xl mt-4" disabled={isPending}>
                {isPending ? "Creating..." : "Launch Group"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {[1,2,3,4,5,6].map(i => (
            <Card key={i} className="border border-border/40 bg-card/30 animate-pulse h-64 rounded-2xl"></Card>
          ))}
        </div>
      ) : tontines.length === 0 ? (
        <div className="text-center p-12 border border-dashed border-border rounded-2xl">
          <PiggyBank className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-medium">No Tontines Active</h3>
          <p className="text-muted-foreground mt-1">Create the first group savings pool to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {tontines.map(tontine => {
            const potSize = tontine.contributionAmount * tontine.memberCount;
            const progress = (tontine.currentRound / tontine.totalRounds) * 100;
            
            return (
              <Card key={tontine.id} className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 hover:border-primary/30 hover:-translate-y-1 transition-all duration-300 rounded-2xl flex flex-col group">
                <CardHeader className="pb-4 border-b border-border/20">
                  <div className="flex justify-between items-start">
                    <div>
                      <Badge variant="outline" className={`mb-2 font-mono text-[10px] uppercase tracking-wider
                        ${tontine.status === 'active' ? 'bg-primary/10 text-primary border-primary/20' : ''}
                        ${tontine.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}
                        ${tontine.status === 'pending' ? 'bg-secondary text-muted-foreground border-border' : ''}
                      `}>
                        {tontine.status}
                      </Badge>
                      <CardTitle className="text-xl group-hover:text-primary transition-colors">{tontine.name}</CardTitle>
                    </div>
                    <div className="w-10 h-10 rounded-xl bg-secondary/80 flex items-center justify-center border border-border/50">
                      <Users className="w-5 h-5 text-muted-foreground" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 flex-1 space-y-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
                        <Coins className="w-3.5 h-3.5" /> Contribution
                      </p>
                      <p className="font-semibold text-foreground">{formatCurrency(tontine.contributionAmount, tontine.currency)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
                        <Calendar className="w-3.5 h-3.5" /> Payout Pot
                      </p>
                      <p className="font-bold text-primary">{formatCurrency(potSize, tontine.currency)}</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-muted-foreground">Round {tontine.currentRound} of {tontine.totalRounds}</span>
                      <span className="text-foreground">{Math.round(progress)}% Complete</span>
                    </div>
                    <Progress value={progress} className="h-2 bg-secondary" />
                  </div>

                  <div className="flex items-center justify-between text-sm pt-2 border-t border-border/20">
                    <span className="text-muted-foreground">Members: <strong className="text-foreground">{tontine.memberCount}/{tontine.maxMembers}</strong></span>
                    <span className="capitalize text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> {tontine.frequency}
                    </span>
                  </div>
                </CardContent>
                <CardFooter className="pt-0 pb-4 px-6 mt-auto">
                  <Button variant="secondary" className="w-full rounded-xl bg-secondary/50 hover:bg-secondary border border-transparent hover:border-border/50 transition-all">
                    Manage Pool
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
