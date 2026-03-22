import { useGetAnalyticsOverview, useGetTransactionAnalytics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Users, Wallet, ArrowLeftRight, TrendingUp, AlertCircle, Store, Landmark } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar } from "recharts";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useGetAnalyticsOverview();
  const { data: txAnalytics, isLoading: txLoading } = useGetTransactionAnalytics({ period: "30d" });

  if (overviewLoading || txLoading) {
    return <div className="w-full h-96 flex items-center justify-center">
      <div className="animate-pulse flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <div className="text-muted-foreground font-medium">Loading platform data...</div>
      </div>
    </div>;
  }

  if (!overview || !txAnalytics) {
    return <div className="text-destructive p-8 bg-destructive/10 rounded-2xl border border-destructive/20 flex items-center gap-3">
      <AlertCircle className="w-6 h-6" />
      <span className="font-medium">Failed to load dashboard data. Ensure the backend is running.</span>
    </div>;
  }

  const statCards = [
    {
      title: "Total Volume (30d)",
      value: formatCurrency(overview.totalTransactionVolume, overview.currency),
      trend: overview.growthRates?.volume ? `+${overview.growthRates.volume}%` : "+12.5%",
      icon: TrendingUp,
      color: "text-primary",
      bg: "bg-primary/10"
    },
    {
      title: "Active Users",
      value: formatNumber(overview.totalUsers),
      trend: overview.growthRates?.users ? `+${overview.growthRates.users}%` : "+4.2%",
      icon: Users,
      color: "text-blue-500",
      bg: "bg-blue-500/10"
    },
    {
      title: "Active Wallets",
      value: formatNumber(overview.activeWallets),
      trend: "+8.1%",
      icon: Wallet,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10"
    },
    {
      title: "Transactions",
      value: formatNumber(overview.totalTransactions),
      trend: overview.growthRates?.transactions ? `+${overview.growthRates.transactions}%` : "+15.3%",
      icon: ArrowLeftRight,
      color: "text-purple-500",
      bg: "bg-purple-500/10"
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Platform Overview</h1>
          <p className="text-muted-foreground mt-1">KOWRI V5.0 Infrastructure Analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="rounded-xl border-border/50 hover:bg-secondary/50">Export Report</Button>
          <Button className="rounded-xl shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90">Settle Funds</Button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat, i) => (
          <Card key={i} className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 hover:border-primary/20 transition-all duration-300 rounded-2xl overflow-hidden group">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold tracking-tight text-foreground">{stat.value}</p>
                </div>
                <div className={`p-3 rounded-xl ${stat.bg} ${stat.color} group-hover:scale-110 transition-transform duration-300`}>
                  <stat.icon className="w-5 h-5" />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className="text-emerald-500 font-medium flex items-center">
                  <TrendingUp className="w-3 h-3 mr-1" /> {stat.trend}
                </span>
                <span className="text-muted-foreground ml-2">from last month</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart */}
        <Card className="lg:col-span-2 border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl">
          <CardHeader className="pb-2 border-b border-border/20 mb-4">
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Transaction Volume</CardTitle>
                <CardDescription>Daily volume in {overview.currency} over 30 days</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-8 text-xs rounded-lg">7D</Button>
                <Button variant="secondary" size="sm" className="h-8 text-xs rounded-lg bg-secondary/80">30D</Button>
                <Button variant="ghost" size="sm" className="h-8 text-xs rounded-lg">90D</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={txAnalytics.dataPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorVolume" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => new Date(val).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => val >= 1000000 ? `${(val/1000000).toFixed(1)}M` : val}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                    formatter={(value: number) => [formatCurrency(value, overview.currency), 'Volume']}
                    labelFormatter={(label) => new Date(label).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                  />
                  <Area type="monotone" dataKey="volume" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorVolume)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Breakdown Chart */}
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl flex flex-col">
          <CardHeader className="pb-2 border-b border-border/20 mb-4">
            <CardTitle>Volume by Type</CardTitle>
            <CardDescription>Distribution of transaction flows</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <div className="h-[220px] w-full mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={Object.entries(txAnalytics.byType).map(([name, value]) => ({ name: name.replace('_', ' '), value }))} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} width={100} />
                  <Tooltip 
                    cursor={{fill: 'hsl(var(--secondary))', opacity: 0.5}}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
                    formatter={(value: number) => [formatCurrency(value, overview.currency), 'Amount']}
                  />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} barSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-auto pt-4 border-t border-border/20">
               <div className="flex justify-between items-center text-sm">
                 <span className="text-muted-foreground">Platform Revenue</span>
                 <span className="font-bold text-emerald-500">{formatCurrency(overview.platformRevenue, overview.currency)}</span>
               </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Active Tontines</CardTitle>
            <div className="p-2 bg-indigo-500/10 rounded-lg"><Users className="w-4 h-4 text-indigo-500" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(overview.activeTontines)}</div>
            <p className="text-sm text-muted-foreground mt-1">Groups currently saving</p>
          </CardContent>
        </Card>
        
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Active Loans</CardTitle>
            <div className="p-2 bg-orange-500/10 rounded-lg"><Landmark className="w-4 h-4 text-orange-500" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(overview.activeLoans)}</div>
            <p className="text-sm text-muted-foreground mt-1">Micro-credit issued</p>
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Merchants</CardTitle>
            <div className="p-2 bg-pink-500/10 rounded-lg"><Store className="w-4 h-4 text-pink-500" /></div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(overview.activeMerchants)}</div>
            <p className="text-sm text-muted-foreground mt-1">Registered businesses</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
