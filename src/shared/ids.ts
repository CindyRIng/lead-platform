/** ULID / ID 生成（无外部依赖，单调递增粗实现） */
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(prefix?: string, now = Date.now()): string {
  let ts = now;
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(B32[ts % 32] ?? '0');
    ts = Math.floor(ts / 32);
  }
  const rand = randomBytes(10);
  const randChars: string[] = [];
  for (let i = 0; i < 16; i++) randChars.push(B32[(rand[i % rand.length] ?? 0) % 32] ?? '0');
  const id = timeChars.join('') + randChars.join('');
  return prefix ? `${prefix}_${id}` : id;
}

export const newGoalId = (): string => ulid('goal');
export const newRunId = (): string => ulid('run');
export const newCompanyId = (): string => ulid('cmp');
export const newJobId = (): string => ulid('job');
export const newEventId = (): string => ulid('evt');
export const newWebhookId = (): string => ulid('whk');
export const newDeliveryId = (): string => ulid('dlv');
export const newQueryId = (): string => ulid('q');
export const newRequestId = (): string => ulid('req');
