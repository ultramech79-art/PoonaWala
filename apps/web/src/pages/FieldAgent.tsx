import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight, Loader2, Target, Scale, Banknote, CheckCircle } from 'lucide-react';
import { apiBase } from '../lib/api';

export function FieldAgent() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState('');
  const [step, setStep] = useState(1); // 1: Lookup, 2: Ground Truth Form
  
  const [xrfKarat, setXrfKarat] = useState('');
  const [scaleWeight, setScaleWeight] = useState('');
  const [finalLoan, setFinalLoan] = useState('');
  const [notes, setNotes] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId) return;
    // In reality, we'd fetch the session details to verify it's ready for dispatch.
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch(`${apiBase}/api/dashboard/agent/${sessionId}/ground-truth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          xrf_karat: parseFloat(xrfKarat),
          scale_weight_g: parseFloat(scaleWeight),
          final_loan_inr: parseInt(finalLoan),
          agent_notes: notes
        }),
      });
      setSuccess(true);
      setLoading(false);
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex h-screen items-center justify-center p-4 bg-zinc-950 text-white">
        <Card className="w-full max-w-md bg-zinc-900 border-zinc-800 text-center py-8">
          <CardHeader>
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4">
              <Banknote className="h-8 w-8 text-emerald-500" />
            </div>
            <CardTitle className="text-2xl text-amber-500">{t('agent_disbursed_title')}</CardTitle>
            <CardDescription className="text-zinc-400">
              {t('agent_disbursed_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full bg-amber-500 hover:bg-amber-600 text-black" onClick={() => {
              setStep(1);
              setSessionId('');
              setSuccess(false);
            }}>
              {t('agent_new_dispatch')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-zinc-950 text-white">
      <Card className="w-full max-w-md bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-2xl text-amber-500">{t('agent_title')}</CardTitle>
          <CardDescription className="text-zinc-400">
            {step === 1 ? t('agent_step1_desc') : t('agent_step2_desc')}
          </CardDescription>
        </CardHeader>
        
        {step === 1 && (
          <form onSubmit={handleLookup}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sessionId" className="text-zinc-300">{t('agent_session_id')}</Label>
                <Input
                  id="sessionId"
                  value={sessionId}
                  onChange={e => setSessionId(e.target.value)}
                  placeholder={t('agent_session_placeholder')} 
                  className="bg-black/50 border-zinc-700 text-white"
                  required 
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" className="w-full bg-amber-500 hover:bg-amber-600 text-black">
                {t('agent_lookup')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label className="text-zinc-300 flex items-center"><Target className="mr-2 h-4 w-4 text-emerald-500"/> {t('agent_xrf')}</Label>
                <Input 
                  type="number" step="0.1" required 
                  value={xrfKarat} onChange={e => setXrfKarat(e.target.value)} 
                  className="bg-black/50 border-zinc-700 text-white font-mono"
                  placeholder="e.g. 21.8" 
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300 flex items-center"><Scale className="mr-2 h-4 w-4 text-emerald-500"/> {t('agent_weight_label')}</Label>
                <Input 
                  type="number" step="0.01" required 
                  value={scaleWeight} onChange={e => setScaleWeight(e.target.value)} 
                  className="bg-black/50 border-zinc-700 text-white font-mono"
                  placeholder="e.g. 14.50" 
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300 flex items-center"><Banknote className="mr-2 h-4 w-4 text-emerald-500"/> {t('agent_loan')}</Label>
                <Input 
                  type="number" required 
                  value={finalLoan} onChange={e => setFinalLoan(e.target.value)} 
                  className="bg-black/50 border-zinc-700 text-white font-mono text-lg"
                  placeholder="e.g. 75000" 
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">{t('agent_notes')}</Label>
                <Textarea
                  value={notes} onChange={e => setNotes(e.target.value)}
                  className="bg-black/50 border-zinc-700 text-white"
                  placeholder={t('agent_notes_placeholder')}
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                {t('agent_submit')}
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  );
}
