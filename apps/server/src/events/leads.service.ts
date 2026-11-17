import type { EventLead, EventLeadStatus, EventService, PrismaClient } from '@prisma/client';
import type { EventBus } from '../core/events.js';

export interface LeadFields {
  customer_name?: string | null;
  event_date?: string | null;
  event_date_text?: string | null;
  location?: string | null;
  event_type?: string | null;
  guests?: number | null;
  start_time?: string | null;
  duration?: string | null;
  services_requested?: string | null;
  measures?: string | null;
  color_style?: string | null;
  rental_duration?: string | null;
  extra_info?: string | null;
}

const REQUIRED: Record<EventService, (keyof EventLead)[]> = {
  GLITTER_BAR: ['eventDateText', 'location', 'eventType', 'guests', 'startTime', 'duration'],
  SHIMMER_WALL: ['eventDateText', 'location', 'eventType', 'colorStyle', 'rentalDuration'],
};

const LABELS: Partial<Record<keyof EventLead, string>> = {
  eventDateText: 'fecha del evento',
  location: 'lugar / ciudad',
  eventType: 'tipo de evento',
  guests: 'cantidad aproximada de invitados',
  startTime: 'horario',
  duration: 'duración del servicio',
  colorStyle: 'color o estilo',
  rentalDuration: 'tiempo de alquiler',
};

function parseDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class LeadsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
  ) {}

  private toData(f: LeadFields) {
    const data: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '') data[k] = v;
    };
    set('customerName', f.customer_name);
    set('eventDate', parseDate(f.event_date));
    set('eventDateText', f.event_date_text ?? f.event_date);
    set('location', f.location);
    set('eventType', f.event_type);
    set('guests', f.guests);
    set('startTime', f.start_time);
    set('duration', f.duration);
    set('servicesRequested', f.services_requested);
    set('measures', f.measures);
    set('colorStyle', f.color_style);
    set('rentalDuration', f.rental_duration);
    set('extraInfo', f.extra_info);
    return data;
  }

  missingFields(lead: EventLead): string[] {
    return REQUIRED[lead.service].filter((k) => lead[k] === null || lead[k] === undefined).map((k) => LABELS[k] ?? String(k));
  }

  /** Crea o completa el lead abierto del cliente para ese servicio. */
  async upsert(contactId: string, conversationId: string | null, service: EventService, fields: LeadFields) {
    const open = await this.db.eventLead.findFirst({
      where: { contactId, service, status: { in: ['NEW', 'QUOTING'] } },
      orderBy: { createdAt: 'desc' },
    });
    const data = this.toData(fields);
    let lead = open
      ? await this.db.eventLead.update({ where: { id: open.id }, data })
      : await this.db.eventLead.create({ data: { ...data, contactId, conversationId, service, status: 'NEW' } });
    const missing = this.missingFields(lead);
    const status: EventLeadStatus = missing.length ? 'NEW' : 'QUOTING';
    if (lead.status !== status) lead = await this.db.eventLead.update({ where: { id: lead.id }, data: { status } });
    if (conversationId) this.bus.publish({ type: 'conversation.updated', conversationId });
    return { lead_id: lead.id, service, status: lead.status, missing_fields: missing };
  }
}
