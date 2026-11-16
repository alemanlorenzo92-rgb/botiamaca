import { EventEmitter } from 'node:events';

export type BusEvent =
  | { type: 'message.created'; conversationId: string; messageId: string }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'whatsapp.status'; status: string; qr?: string | null }
  | { type: 'followup.due'; followupId: string }
  | { type: 'human.requested'; conversationId: string; reason: string | null };

/** Bus en memoria: el sistema corre en un único proceso (Baileys exige una sola instancia). */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: BusEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
