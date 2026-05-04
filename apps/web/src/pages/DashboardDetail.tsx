import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ArrowLeft, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { apiBase } from '../lib/api';

export function DashboardDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/api/dashboard/sessions/${id}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { console.error(e); setLoading(false); });
  }, [id]);

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      await fetch(`${apiBase}/api/dashboard/sessions/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      });
      navigate('/dashboard');
    } catch (e) {
      console.error(e);
      setActionLoading(false);
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <Loader2 className="h-8 w-8 animate-spin text-brand-400" />
    </div>
  );
  if (!data || !data.assessment) return (
    <div className="flex h-screen items-center justify-center text-white bg-zinc-950">
      Session not found or not finalized.
    </div>
  );

  const { assessment, session } = data;

  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-white overflow-y-auto">
      <div className="max-w-5xl mx-auto space-y-6">
        <Button variant="ghost" className="text-zinc-400 hover:text-white mb-4" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Sessions
        </Button>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>Session Review</CardTitle>
                  <Badge variant="outline" className="border-brand-400/50 text-brand-400">{assessment.routing}</Badge>
                </div>
                <CardDescription className="text-zinc-400">
                  {session.phone} · {new Date(session.created_at).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <span className="text-zinc-500">Purity</span>
                    <p className="font-medium">{assessment.purity.point_estimate_karat}K</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-zinc-500">Estimated Value</span>
                    <p className="font-medium text-emerald-400">₹{assessment.value_inr.band_low.toLocaleString()}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-zinc-500">Confidence</span>
                    <p className="font-medium">{(assessment.confidence.score * 100).toFixed(1)}%</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-zinc-500">Fraud Score</span>
                    <p className="font-medium text-rose-400">{(assessment.fraud_signals.score * 100).toFixed(1)}%</p>
                  </div>
                </div>

                <div className="pt-4 border-t border-zinc-800">
                  <h4 className="text-sm font-medium text-zinc-300 mb-2">GoldEye AI Reasoning</h4>
                  <p className="text-sm text-zinc-400 bg-black/20 p-3 rounded-md italic">
                    "{assessment.reasoning_text.text}"
                  </p>
                </div>

                {assessment.xai?.gradcam_url && (
                  <div className="pt-4 border-t border-zinc-800">
                    <h4 className="text-sm font-medium text-zinc-300 mb-2">Grad-CAM Heatmap</h4>
                    <img src={assessment.xai.gradcam_url} alt="Grad-CAM" className="rounded-md max-w-full h-auto max-h-64 object-contain bg-black/50" />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <CardTitle>SHAP Feature Attributions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {assessment.xai?.shap_top_features.map((f: any) => (
                    <div key={f.feature} className="flex justify-between text-sm">
                      <span className="text-zinc-400">{f.feature}</span>
                      <span className={f.contribution > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {f.contribution > 0 ? '+' : ''}{f.contribution.toFixed(3)}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <CardTitle>Risk Officer Action</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-zinc-400">Decision Notes / Reason</label>
                  <Textarea
                    className="bg-black/20 border-zinc-800 focus:border-brand-500 text-white min-h-[100px]"
                    placeholder="Enter notes for field agent or audit log..."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="space-y-2 pt-4">
                  <Button
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={actionLoading}
                    onClick={() => handleAction('approve_dispatch')}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" /> Approve & Dispatch Agent
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full border-brand-400/50 text-brand-400 hover:bg-brand-500/10"
                    disabled={actionLoading}
                    onClick={() => handleAction('request_recapture')}
                  >
                    <AlertTriangle className="mr-2 h-4 w-4" /> Request Recapture
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full border-rose-500/50 text-rose-500 hover:bg-rose-500/10"
                    disabled={actionLoading}
                    onClick={() => handleAction('decline')}
                  >
                    <XCircle className="mr-2 h-4 w-4" /> Decline Loan
                  </Button>
                </div>
              </CardContent>
            </Card>

            {assessment.fraud_signals.triggers.length > 0 && (
              <Card className="bg-rose-950/20 border-rose-900/50">
                <CardHeader>
                  <CardTitle className="text-rose-500 text-sm flex items-center">
                    <AlertTriangle className="mr-2 h-4 w-4" /> Fraud Flags
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc list-inside text-sm text-rose-400 space-y-1">
                    {assessment.fraud_signals.triggers.map((t: string) => (
                      <li key={t}>{t.replace(/_/g, ' ')}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
