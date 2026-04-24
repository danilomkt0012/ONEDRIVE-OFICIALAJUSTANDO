import { botFlowEngine } from '../services/bot/BotFlowEngine';
import { wabaStorage } from '../wabaStorage';
import { db } from '../db';
import { botFlows, botConversationStates, campaigns as campaignsSchema } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logError } from '../utils/logger';

const INTERVAL_MS = 60_000;

let intervalHandle: NodeJS.Timeout | null = null;

async function checkTimeouts(): Promise<void> {
  try {
    const timedOut = await botFlowEngine.getTimedOutStates(50);
    if (timedOut.length === 0) return;

    console.log(`[BotTimeout] Processando ${timedOut.length} timeouts`);

    for (const { state, node } of timedOut) {
      try {
        const [flow] = await db.select().from(botFlows)
          .where(eq(botFlows.id, state.flowId));
        if (!flow) continue;

        const [campaign] = await db.select().from(campaignsSchema).where(eq(campaignsSchema.id, flow.campaignId));
        if (!campaign || !campaign.wabaId) continue;

        const waba = await wabaStorage.getWabaById(campaign.wabaId);
        if (!waba) continue;

        const numbers = await wabaStorage.getWabaNumbers(waba.id);
        if (numbers.length === 0) continue;

        const convo = await wabaStorage.getOrCreateConversation(waba.id, state.phone);

        await botFlowEngine.handleTimeout(
          state,
          node,
          numbers[0].phoneNumberId,
          waba.accessToken,
          convo.id
        );
      } catch (err) {
        logError("botTimeoutJob.processTimeout", { flowId: state.flowId, phone: state.phone }, err);
      }
    }
  } catch (err) {
    logError("botTimeoutJob.checkTimeouts", {}, err);
  }
}

export function startBotTimeoutJob(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(checkTimeouts, INTERVAL_MS);
  console.log('[BotTimeout] Job de timeout iniciado (intervalo: 60s)');
}

export function stopBotTimeoutJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
