import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Phone, Shield, AlertTriangle, CheckCircle, XCircle, Activity } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';

interface PhoneNumberWithStatus {
  id: string;
  phoneNumberId: string;
  displayPhone: string;
  maskedPhone: string;
  verifiedName: string;
  qualityRating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  tier: string;
  tierLimit: number;
  accountMode: string;
  status: 'AVAILABLE' | 'BUSY' | 'BLOCKED' | 'DEGRADED';
  canSend: boolean;
  estimatedDailyLimit: number;
}

interface ThroughputEstimate {
  totalPhones: number;
  availablePhones: number;
  estimatedMsgPerSec: number;
  estimatedDailyCapacity: number;
  estimatedTimeToComplete: number;
  breakdown: {
    phoneId: string;
    displayPhone: string;
    contribution: number;
    limit: number;
  }[];
}

type DistributionStrategy = 'round_robin' | 'weighted' | 'adaptive';

interface PhoneNumberSelectorProps {
  selectedPhones: string[];
  onSelectionChange: (phones: string[]) => void;
  distributionStrategy: DistributionStrategy;
  onStrategyChange: (strategy: DistributionStrategy) => void;
  totalLeads?: number;
}

const DISTRIBUTION_STRATEGIES = [
  { 
    value: 'adaptive' as const, 
    label: 'Adaptativo (Recomendado)', 
    description: 'Distribui baseado em saúde, RTT e taxa atual' 
  },
  { 
    value: 'weighted' as const, 
    label: 'Por Qualidade', 
    description: 'Prioriza números com melhor quality rating' 
  },
  { 
    value: 'round_robin' as const, 
    label: 'Alternado', 
    description: 'Alterna entre os números sequencialmente' 
  }
];

const qualityColors = {
  GREEN: 'bg-green-500',
  YELLOW: 'bg-yellow-500',
  RED: 'bg-red-500',
  UNKNOWN: 'bg-gray-500'
};

const qualityLabels = {
  GREEN: 'Excelente',
  YELLOW: 'Atenção',
  RED: 'Crítico',
  UNKNOWN: 'Desconhecido'
};

export function PhoneNumberSelector({
  selectedPhones,
  onSelectionChange,
  distributionStrategy,
  onStrategyChange,
  totalLeads = 1000
}: PhoneNumberSelectorProps) {
  const [localSelected, setLocalSelected] = useState<string[]>(selectedPhones);

  const { data: phoneData, isLoading, error, refetch } = useQuery<{
    total: number;
    available: number;
    blocked: number;
    phoneNumbers: PhoneNumberWithStatus[];
  }>({
    queryKey: ['/api/phone-numbers/detailed'],
    refetchInterval: 30000
  });

  const estimateMutation = useMutation({
    mutationFn: async (params: { selectedPhoneIds: string[]; totalLeads: number; distributionStrategy: string }) => {
      const response = await apiRequest('POST', '/api/phone-numbers/estimate-throughput', params);
      return response.json() as Promise<ThroughputEstimate>;
    }
  });

  useEffect(() => {
    if (localSelected.length > 0) {
      estimateMutation.mutate({
        selectedPhoneIds: localSelected,
        totalLeads,
        distributionStrategy
      });
    }
  }, [localSelected, totalLeads, distributionStrategy]);

  const handleTogglePhone = (phoneId: string) => {
    const newSelection = localSelected.includes(phoneId)
      ? localSelected.filter(id => id !== phoneId)
      : [...localSelected, phoneId];
    
    setLocalSelected(newSelection);
    onSelectionChange(newSelection);
  };

  const handleSelectAll = () => {
    const availableIds = (phoneData?.phoneNumbers || [])
      .filter(p => p.canSend)
      .map(p => p.id);
    setLocalSelected(availableIds);
    onSelectionChange(availableIds);
  };

  const handleClearAll = () => {
    setLocalSelected([]);
    onSelectionChange([]);
  };

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>Carregando números...</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8 text-red-500">
          <AlertTriangle className="h-6 w-6 mr-2" />
          <span>Erro ao carregar números</span>
        </CardContent>
      </Card>
    );
  }

  const phones = phoneData?.phoneNumbers || [];
  const estimate = estimateMutation.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Phone className="h-5 w-5" />
                Seleção de Números
              </CardTitle>
              <CardDescription>
                {phoneData?.available || 0} de {phoneData?.total || 0} números disponíveis
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                Selecionar Todos
              </Button>
              <Button variant="outline" size="sm" onClick={handleClearAll}>
                Limpar
              </Button>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Atualizar
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            {phones.map((phone) => (
              <div
                key={phone.id}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  phone.canSend ? 'border-gray-200 hover:border-gray-300' : 'border-red-200 bg-red-50'
                } ${localSelected.includes(phone.id) ? 'ring-2 ring-blue-500 bg-blue-50' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={localSelected.includes(phone.id)}
                    onCheckedChange={() => handleTogglePhone(phone.id)}
                    disabled={!phone.canSend}
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{phone.maskedPhone}</span>
                      <Badge variant="outline" className="text-xs">
                        {phone.tier.replace('TIER_', '')}
                      </Badge>
                      <div className={`w-2 h-2 rounded-full ${qualityColors[phone.qualityRating]}`} />
                      <span className="text-xs text-muted-foreground">
                        {qualityLabels[phone.qualityRating]}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {phone.verifiedName} - Limite: {phone.tierLimit.toLocaleString()}/dia
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {phone.canSend ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className={`text-xs ${phone.canSend ? 'text-green-600' : 'text-red-600'}`}>
                    {phone.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Estratégia de Distribuição
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={distributionStrategy} onValueChange={(v) => onStrategyChange(v as DistributionStrategy)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISTRIBUTION_STRATEGIES.map((strategy) => (
                <SelectItem key={strategy.value} value={strategy.value}>
                  <div>
                    <div className="font-medium">{strategy.label}</div>
                    <div className="text-xs text-muted-foreground">{strategy.description}</div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {estimate && localSelected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-[#0066FF]" />
              Estimativa de Throughput
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-2xl font-bold text-blue-600">
                  {estimate.estimatedMsgPerSec}
                </div>
                <div className="text-xs text-muted-foreground">msgs/segundo</div>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-2xl font-bold text-green-600">
                  {estimate.estimatedDailyCapacity.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">capacidade/dia</div>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-2xl font-bold text-purple-600">
                  {estimate.availablePhones}
                </div>
                <div className="text-xs text-muted-foreground">números ativos</div>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-2xl font-bold text-orange-600">
                  {formatTime(estimate.estimatedTimeToComplete)}
                </div>
                <div className="text-xs text-muted-foreground">tempo estimado</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
