import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Phone, RefreshCw, Shield, AlertTriangle, CheckCircle } from 'lucide-react';

interface PhoneNumberWithDetails {
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

interface PhoneNumberListProps {
  selectedPhones: string[];
  onSelectionChange: (phones: string[]) => void;
}

const qualityConfig = {
  GREEN: { color: 'bg-green-500', label: 'Excelente', icon: '🟢' },
  YELLOW: { color: 'bg-yellow-500', label: 'Atenção', icon: '🟡' },
  RED: { color: 'bg-red-500', label: 'Crítico', icon: '🔴' },
  UNKNOWN: { color: 'bg-gray-500', label: 'Desconhecido', icon: '⚪' }
};

const circuitStatusConfig = {
  AVAILABLE: { label: 'Normal', color: 'text-green-600', bg: 'bg-green-100' },
  BUSY: { label: 'Em uso', color: 'text-blue-600', bg: 'bg-blue-100' },
  BLOCKED: { label: 'Proteção ativa', color: 'text-red-600', bg: 'bg-red-100' },
  DEGRADED: { label: 'Lentidão detectada', color: 'text-yellow-600', bg: 'bg-yellow-100' }
};

export function PhoneNumberList({ selectedPhones, onSelectionChange }: PhoneNumberListProps) {
  const { data, isLoading, error, refetch, isFetching } = useQuery<{
    total: number;
    available: number;
    blocked: number;
    phoneNumbers: PhoneNumberWithDetails[];
  }>({
    queryKey: ['/api/phone-numbers/detailed'],
    refetchInterval: 30000
  });

  const handleToggle = (phoneId: string) => {
    if (selectedPhones.includes(phoneId)) {
      onSelectionChange(selectedPhones.filter(id => id !== phoneId));
    } else {
      onSelectionChange([...selectedPhones, phoneId]);
    }
  };

  const handleSelectAll = () => {
    const availableIds = (data?.phoneNumbers || [])
      .filter(p => p.canSend)
      .map(p => p.id);
    onSelectionChange(availableIds);
  };

  const handleClearAll = () => {
    onSelectionChange([]);
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
        <CardContent className="flex flex-col items-center justify-center py-8 text-center">
          <AlertTriangle className="h-8 w-8 text-yellow-500 mb-2" />
          <p className="text-muted-foreground mb-4">Erro ao carregar números</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  const phones = data?.phoneNumbers || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Phone className="h-5 w-5" />
              Números para Disparo
            </CardTitle>
            <CardDescription>
              {data?.available || 0} de {data?.total || 0} números disponíveis
              {selectedPhones.length > 0 && ` • ${selectedPhones.length} selecionado(s)`}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              Selecionar Todos
            </Button>
            <Button variant="outline" size="sm" onClick={handleClearAll}>
              Limpar
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {phones.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Phone className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Nenhum número encontrado</p>
            <p className="text-xs">Configure sua WABA nas configurações</p>
          </div>
        ) : (
          <div className="space-y-2">
            {phones.map((phone) => {
              const quality = qualityConfig[phone.qualityRating];
              const circuit = circuitStatusConfig[phone.status];
              const isSelected = selectedPhones.includes(phone.id);

              return (
                <div
                  key={phone.id}
                  onClick={() => phone.canSend && handleToggle(phone.id)}
                  className={`
                    flex items-center justify-between p-3 rounded-lg border-2 cursor-pointer transition-all
                    ${phone.canSend ? 'hover:bg-gray-50 dark:hover:bg-gray-800' : 'opacity-60 cursor-not-allowed'}
                    ${isSelected ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-gray-200 dark:border-gray-700'}
                  `}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => handleToggle(phone.id)}
                      disabled={!phone.canSend}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{phone.maskedPhone}</span>
                        <span className="text-lg" title={quality.label}>{quality.icon}</span>
                        <Badge variant="outline" className="text-xs">
                          {phone.tier.replace('TIER_', '')}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {phone.verifiedName} • Limite: {phone.tierLimit.toLocaleString()}/dia
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Status do Circuito */}
                    <div className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${circuit.bg} ${circuit.color}`}>
                      {phone.status === 'BLOCKED' ? (
                        <Shield className="h-3 w-3" />
                      ) : phone.status === 'AVAILABLE' ? (
                        <CheckCircle className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {circuit.label}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
