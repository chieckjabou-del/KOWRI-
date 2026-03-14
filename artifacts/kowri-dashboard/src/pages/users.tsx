import { useState } from "react";
import { useListUsers, useCreateUser } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, MoreHorizontal, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Users() {
  const { data, isLoading } = useListUsers();
  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { mutate: createUser, isPending } = useCreateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/users"] });
        setIsDialogOpen(false);
        toast({ title: "User created", description: "New user successfully onboarded." });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Creation failed", description: err.message || "An error occurred" });
      }
    }
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createUser({
      data: {
        phone: formData.get("phone") as string,
        firstName: formData.get("firstName") as string,
        lastName: formData.get("lastName") as string,
        email: formData.get("email") as string || null,
        country: formData.get("country") as string,
        pin: formData.get("pin") as string,
      }
    });
  };

  const users = data?.users || [];
  const filteredUsers = users.filter(u => 
    u.firstName.toLowerCase().includes(search.toLowerCase()) || 
    u.lastName.toLowerCase().includes(search.toLowerCase()) ||
    u.phone.includes(search)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground mt-1">Manage platform users and KYC status</p>
        </div>
        
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-xl shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-2" /> Add User
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px] bg-card border-border/50">
            <DialogHeader>
              <DialogTitle>Onboard New User</DialogTitle>
              <DialogDescription>Create a new KOWRI user account manually.</DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input id="firstName" name="firstName" required className="bg-secondary/50 rounded-xl" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input id="lastName" name="lastName" required className="bg-secondary/50 rounded-xl" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input id="phone" name="phone" placeholder="+225..." required className="bg-secondary/50 rounded-xl" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email (Optional)</Label>
                <Input id="email" name="email" type="email" className="bg-secondary/50 rounded-xl" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="country">Country Code</Label>
                  <Input id="country" name="country" defaultValue="CI" required className="bg-secondary/50 rounded-xl" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pin">Initial PIN</Label>
                  <Input id="pin" name="pin" type="password" required className="bg-secondary/50 rounded-xl" />
                </div>
              </div>
              <Button type="submit" className="w-full rounded-xl mt-4" disabled={isPending}>
                {isPending ? "Creating..." : "Create Account"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-border/40 flex items-center justify-between bg-secondary/20">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input 
              placeholder="Search by name or phone..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-background/50 border-border/50 rounded-xl h-10"
            />
          </div>
          <div className="text-sm text-muted-foreground font-medium">
            {filteredUsers.length} users
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-secondary/30">
              <TableRow className="border-border/40 hover:bg-transparent">
                <TableHead>User</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>KYC Level</TableHead>
                <TableHead>Credit Score</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({length: 5}).map((_, i) => (
                  <TableRow key={i} className="border-border/40">
                    <TableCell><div className="h-10 w-32 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-20 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-16 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-16 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-6 w-24 bg-secondary animate-pulse rounded-lg"></div></TableCell>
                    <TableCell><div className="h-8 w-8 ml-auto bg-secondary animate-pulse rounded-full"></div></TableCell>
                  </TableRow>
                ))
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    No users found matching your search.
                  </TableCell>
                </TableRow>
              ) : (
                filteredUsers.map((user) => (
                  <TableRow key={user.id} className="border-border/40 hover:bg-secondary/20 transition-colors">
                    <TableCell>
                      <div className="font-medium text-foreground">{user.firstName} {user.lastName}</div>
                      <div className="text-xs text-muted-foreground">{user.id.substring(0, 8)}...</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{user.phone}</div>
                      <div className="text-xs text-muted-foreground">{user.country}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.status === "active" ? "default" : "secondary"} className={`
                        ${user.status === 'active' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}
                        ${user.status === 'suspended' ? 'bg-destructive/10 text-destructive border-destructive/20' : ''}
                        ${user.status === 'pending_kyc' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : ''}
                      `}>
                        {user.status.replace('_', ' ').toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {user.kycLevel >= 2 ? <ShieldCheck className="w-4 h-4 text-emerald-500" /> : <ShieldAlert className="w-4 h-4 text-amber-500" />}
                        <span className="font-medium">Lvl {user.kycLevel}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {user.creditScore ? (
                        <div className="flex items-center gap-2">
                          <div className="w-full bg-secondary rounded-full h-1.5 max-w-[60px]">
                            <div className="bg-primary h-1.5 rounded-full" style={{ width: `${Math.min(100, (user.creditScore / 850) * 100)}%` }}></div>
                          </div>
                          <span className="text-sm font-medium">{user.creditScore}</span>
                        </div>
                      ) : <span className="text-muted-foreground text-sm">N/A</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="rounded-xl text-muted-foreground hover:text-foreground">
                        <MoreHorizontal className="w-4 h-4" />
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
