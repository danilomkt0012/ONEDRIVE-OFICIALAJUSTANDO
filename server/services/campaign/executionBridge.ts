export type CampaignExecutionOptions = {
  speedMode?: string;
  batchingRate?: number;
  forcedLanguage?: string;
  customMessages?: Record<number, string>;
  isDynamicUrl?: boolean;
  templateNames?: string[];
  customRate?: number;
  isBlacksky?: boolean;
  blackskyConfig?: { dominios: string[]; variacoes4: string[]; variacoes3?: string[] };
  isParametroUnico?: boolean;
  parametroUnicoConfig?: { singleParamTemplate: string; dominios: string[]; linkPrefixes: string[] };
  usePackageImage?: boolean;
  packageImageType?: 'correios' | 'dirpf' | 'auto';
  packageImageKey?: string;
  customImageTemplateId?: string;
  wabaConfigs?: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[]; wabaDbId?: string }>;
  templateWeights?: Record<string, number>;
};

export type CampaignExecutor = (
  campaignId: string,
  options: CampaignExecutionOptions
) => Promise<void>;

let _executor: CampaignExecutor | null = null;

export function registerExecutor(fn: CampaignExecutor) {
  _executor = fn;
}

export async function triggerCampaignExecution(
  campaignId: string,
  options: CampaignExecutionOptions
): Promise<void> {
  if (!_executor) {
    throw new Error("Campaign executor not registered");
  }
  return _executor(campaignId, options);
}
