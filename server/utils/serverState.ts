export const serverStartTime = Date.now();

let _lastWebhookEventTime: number | null = null;

export function getLastWebhookEventTime(): number | null {
  return _lastWebhookEventTime;
}

export function updateLastWebhookEvent() {
  _lastWebhookEventTime = Date.now();
}
