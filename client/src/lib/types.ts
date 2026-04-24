export interface DashboardStats {
  totalLeads: number;
  messagesSent: number;
  messagesFailed: number;
  messagesSuccess: number;
  deliveryRate: number;
  activeCampaigns: number;
  totalCampaigns: number;
}

export interface TemplatePreview {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  preview: string;
}

export interface CampaignProgress {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  totalLeads: number;
  sentCount: number;
  failedCount: number;
  progress: number;
  startTime?: string;
  estimatedEnd?: string;
  completedTime?: string;
  duration?: string;
}
