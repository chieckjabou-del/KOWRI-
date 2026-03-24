import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  Wallet,
  ArrowLeftRight,
  PiggyBank,
  Landmark,
  Store,
  ShieldCheck,
  BookOpen,
  LogOut,
  Bell,
  Search,
  Siren,
  ShieldAlert,
  DollarSign,
  BarChart2,
  Ticket,
  UserCog,
  ChevronLeft,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { motion, AnimatePresence } from "framer-motion";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "War Room",  url: "/war-room", icon: Siren },
  { title: "Users", url: "/users", icon: Users },
  { title: "Wallets", url: "/wallets", icon: Wallet },
  { title: "Transactions", url: "/transactions", icon: ArrowLeftRight },
  { title: "Tontines", url: "/tontines", icon: PiggyBank },
  { title: "Credit & Loans", url: "/credit", icon: Landmark },
  { title: "Merchants", url: "/merchants", icon: Store },
  { title: "Compliance", url: "/compliance", icon: ShieldCheck },
  { title: "Ledger", url: "/ledger", icon: BookOpen },
];

const adminNavItems = [
  { title: "Vue d'ensemble", url: "/admin", icon: LayoutDashboard, exact: true },
  { title: "Utilisateurs",   url: "/admin/users",      icon: UserCog },
  { title: "KYC",            url: "/admin/kyc",        icon: ShieldCheck },
  { title: "AML",            url: "/admin/aml",        icon: ShieldAlert },
  { title: "Frais",          url: "/admin/fees",       icon: DollarSign },
  { title: "Analytics",      url: "/admin/analytics",  icon: BarChart2 },
  { title: "Support",        url: "/admin/support",    icon: Ticket },
  { title: "Agents",         url: "/admin/agents",     icon: Store },
];

function NavItem({ item, location }: { item: typeof navItems[0] & { exact?: boolean }; location: string }) {
  const isActive = item.exact
    ? location === item.url
    : location === item.url || (item.url !== "/" && location.startsWith(item.url));
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={item.title}>
        <Link
          href={item.url}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 ${
            isActive
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          }`}
        >
          <item.icon className={`w-5 h-5 ${isActive ? "text-primary" : ""}`} />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function AppSidebar({ location }: { location: string }) {
  return (
    <Sidebar className="border-r border-border/50 bg-background/50 backdrop-blur-xl">
      <SidebarHeader className="h-16 px-6 flex items-center justify-center border-b border-border/50">
        <div className="flex items-center gap-2 text-primary font-display font-bold text-2xl tracking-tight">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-xl">K</span>
          </div>
          KOWRI
        </div>
      </SidebarHeader>
      <SidebarContent className="px-4 py-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navItems.map((item) => (
                <NavItem key={item.title} item={item} location={location} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-4 pt-4 border-t border-border/40">
          <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider px-3 mb-1">Administration</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Admin">
                  <Link href="/admin"
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 ${
                      location.startsWith("/admin")
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    }`}>
                    <UserCog className={`w-5 h-5 ${location.startsWith("/admin") ? "text-primary" : ""}`} />
                    <span>Admin Panel</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-border/50">
        <Button variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl px-3">
          <LogOut className="w-5 h-5 mr-3" />
          Sign Out
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

function AdminSidebar({ location }: { location: string }) {
  return (
    <Sidebar className="border-r border-border/50 bg-background/50 backdrop-blur-xl">
      <SidebarHeader className="h-16 px-6 flex items-center border-b border-border/50 gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <span className="text-primary-foreground text-xl font-bold">K</span>
        </div>
        <div>
          <div className="text-primary font-bold text-sm leading-tight">KOWRI Admin</div>
          <div className="text-xs text-muted-foreground">Opérateur</div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-4 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider px-3 mb-1">Administration</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {adminNavItems.map((item) => (
                <NavItem key={item.title} item={item} location={location} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-4 pt-4 border-t border-border/40">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Retour au dashboard">
                  <Link href="/"
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-200">
                    <ChevronLeft className="w-5 h-5" />
                    <span>Retour au Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-border/50">
        <Button variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-xl px-3">
          <LogOut className="w-5 h-5 mr-3" />
          Sign Out
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const isAdmin = location.startsWith("/admin");

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full bg-background overflow-hidden relative">
        <div className="absolute inset-0 z-0 opacity-20 pointer-events-none"
             style={{
               backgroundImage: `url(${import.meta.env.BASE_URL}images/kowri-bg-mesh.png)`,
               backgroundSize: "cover",
               backgroundPosition: "center",
             }}
        />

        {isAdmin ? <AdminSidebar location={location} /> : <AppSidebar location={location} />}

        <div className="flex flex-col flex-1 relative z-10 w-full min-w-0">
          <header className="h-16 flex items-center justify-between px-8 border-b border-border/50 bg-background/80 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              {isAdmin && (
                <div className="px-2.5 py-0.5 rounded-lg bg-primary/10 border border-primary/20 text-primary text-xs font-bold tracking-widest uppercase">
                  Admin
                </div>
              )}
              <div className="flex items-center w-full max-w-md relative">
                <Search className="w-4 h-4 text-muted-foreground absolute left-3" />
                <Input
                  placeholder={isAdmin ? "Rechercher dans l'admin..." : "Search transactions, users, or wallets..."}
                  className="pl-9 bg-secondary/30 border-transparent focus-visible:border-primary/50 focus-visible:ring-primary/20 rounded-xl h-10"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Button size="icon" variant="ghost" className="rounded-full relative text-muted-foreground hover:text-foreground hover:bg-secondary/50">
                <Bell className="w-5 h-5" />
                <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full border-2 border-background"></span>
              </Button>
              <div className="h-8 w-[1px] bg-border/50"></div>
              <div className="flex items-center gap-3 pl-2">
                <div className="text-right hidden md:block">
                  <div className="text-sm font-medium leading-none text-foreground">Admin User</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Super Admin</div>
                </div>
                <Avatar className="h-9 w-9 border-2 border-primary/20">
                  <AvatarFallback className="bg-primary/10 text-primary font-bold">A</AvatarFallback>
                </Avatar>
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden p-8 scroll-smooth relative">
            <AnimatePresence mode="wait">
              <motion.div
                key={location}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="w-full max-w-7xl mx-auto pb-12"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
