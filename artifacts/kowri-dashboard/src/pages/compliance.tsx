import { useListKycRecords } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, FileText, CheckCircle, XCircle } from "lucide-react";
import { formatDate } from "@/lib/format";

export default function Compliance() {
  const { data, isLoading } = useListKycRecords();
  const records = data?.records || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Compliance & KYC</h1>
          <p className="text-muted-foreground mt-1">Review and approve identity verification requests</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-amber-500/10 rounded-xl"><ShieldAlert className="w-6 h-6 text-amber-500" /></div>
            <div>
              <div className="text-2xl font-bold">{records.filter(r => r.status === 'pending').length}</div>
              <div className="text-sm text-muted-foreground">Pending Review</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-emerald-500/10 rounded-xl"><ShieldCheck className="w-6 h-6 text-emerald-500" /></div>
            <div>
              <div className="text-2xl font-bold">{records.filter(r => r.status === 'verified').length}</div>
              <div className="text-sm text-muted-foreground">Verified Users</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-border/40 bg-card/50 backdrop-blur-xl shadow-xl shadow-black/5 rounded-2xl overflow-hidden">
        <Table>
          <TableHeader className="bg-secondary/30">
            <TableRow className="border-border/40">
              <TableHead>User</TableHead>
              <TableHead>Document Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Target Level</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center">Loading...</TableCell></TableRow>
            ) : records.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No KYC records found.</TableCell></TableRow>
            ) : (
              records.map(record => (
                <TableRow key={record.id} className="border-border/40">
                  <TableCell>
                    <div className="font-medium">{record.userName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{record.userId.substring(0,8)}...</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 capitalize">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      {record.documentType.replace('_', ' ')}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`
                      ${record.status === 'pending' ? 'border-amber-500/30 text-amber-500 bg-amber-500/10' : ''}
                      ${record.status === 'verified' ? 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10' : ''}
                      ${record.status === 'rejected' ? 'border-destructive/30 text-destructive bg-destructive/10' : ''}
                    `}>
                      {record.status}
                    </Badge>
                  </TableCell>
                  <TableCell>Level {record.kycLevel}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(record.submittedAt)}</TableCell>
                  <TableCell className="text-right space-x-2">
                    {record.status === 'pending' ? (
                      <>
                        <Button size="sm" variant="outline" className="h-8 rounded-lg border-emerald-500/20 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500">
                          <CheckCircle className="w-4 h-4 mr-1" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 rounded-lg border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive">
                          <XCircle className="w-4 h-4 mr-1" /> Reject
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg">View Details</Button>
                    )}
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
