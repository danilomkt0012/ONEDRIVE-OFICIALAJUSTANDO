import { resetDaily } from '../services/engine/SenderPool';
import { logError } from '../utils/logger';

let resetTimer: ReturnType<typeof setTimeout> | null = null;

function getMillisUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

function scheduleNextReset(): void {
  const msUntilMidnight = getMillisUntilMidnightUTC();
  console.log(`[ResetCron] Próximo reset em ${(msUntilMidnight / 1000 / 60).toFixed(1)} minutos (00:00 UTC)`);

  resetTimer = setTimeout(async () => {
    try {
      await resetDaily();
      console.log(`[ResetCron] Reset diário executado com sucesso às ${new Date().toISOString()}`);
    } catch (err: any) {
      logError("resetcron.dailyReset", {}, err);
    }
    scheduleNextReset();
  }, msUntilMidnight);
}

export function startDailyResetJob(): void {
  console.log(`[ResetCron] Agendando reset diário de sender_usage para 00:00 UTC`);
  scheduleNextReset();
}

export function stopDailyResetJob(): void {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
    console.log(`[ResetCron] Reset diário cancelado`);
  }
}
