export type ConfirmationReply = 'confirm' | 'cancel' | 'unresolved';

const CONFIRM_PHRASES = new Set(['да', 'подтверждаю', 'подтвердить', 'подтвердить анализ', '1']);
const CANCEL_PHRASES = new Set(['нет', 'отмена', 'отменить', '0']);

function normalize(message: string): string {
  return message.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function resolveConfirmationReply(message: string): ConfirmationReply {
  const normalized = normalize(message);
  if (CONFIRM_PHRASES.has(normalized)) return 'confirm';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return 'unresolved';
}
