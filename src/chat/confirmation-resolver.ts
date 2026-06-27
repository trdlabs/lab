export type ConfirmationReply = 'confirm' | 'accept_as_is' | 'cancel' | 'unresolved';

const CONFIRM_PHRASES = new Set(['да', 'подтверждаю', 'подтвердить', 'подтвердить анализ', 'улучшить', 'улучшить и анализировать', '1']);
const ACCEPT_AS_IS_PHRASES = new Set(['как есть', 'анализировать как есть', 'оставить как есть', '2']);
const CANCEL_PHRASES = new Set(['нет', 'отмена', 'отменить', '0']);

function normalize(message: string): string {
  return message.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function resolveConfirmationReply(message: string): ConfirmationReply {
  const normalized = normalize(message);
  if (CONFIRM_PHRASES.has(normalized)) return 'confirm';
  if (ACCEPT_AS_IS_PHRASES.has(normalized)) return 'accept_as_is';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return 'unresolved';
}
