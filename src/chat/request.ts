import { z } from 'zod';

// Shape + non-blank only. `.trim()` runs before `.min(1)`, so "" AND whitespace-only
// ("   ", "\n\t ") both fail validation -> the app returns 400 BEFORE the classifier
// is called. The max-length cap is enforced by the app prefilter using
// CHAT_MAX_MESSAGE_CHARS, so the schema stays config-free.
export const ChatMessageRequestSchema = z.object({
  message: z.string().trim().min(1),
  sessionId: z.string().min(1).optional(),
  channel: z.enum(['web', 'telegram']).default('web'),
});

export type ChatMessageRequest = z.infer<typeof ChatMessageRequestSchema>;

export const ChatConfirmRequestSchema = z.object({
  pendingInteractionId: z.string().min(1),
  sessionId: z.string().min(1),
  decision: z.enum(['confirm', 'cancel']),
});

export type ChatConfirmRequest = z.infer<typeof ChatConfirmRequestSchema>;
