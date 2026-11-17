import type { AiSetting, Prisma, PrismaClient } from '@prisma/client';

/**
 * Claves de configuración del negocio. Todas arrancan vacías: si un dato no está cargado,
 * las herramientas responden "sin dato" y la IA deriva a una persona.
 */
export const BUSINESS_SETTING_KEYS = [
  'business_profile',
  'store_links',
  'payment_methods',
  'shipping_policy',
  'wholesale_conditions',
  'retail_conditions',
  'handoff_rules',
  'faq',
] as const;

export type BusinessSettingKey = (typeof BUSINESS_SETTING_KEYS)[number];

export class SettingsService {
  constructor(private readonly db: PrismaClient) {}

  async getAi(): Promise<AiSetting> {
    const row = await this.db.aiSetting.findUnique({ where: { id: 1 } });
    if (!row) throw new Error('Falta la configuración de IA (ejecutá el seed)');
    return row;
  }

  async getBusiness(key: BusinessSettingKey): Promise<Prisma.JsonValue | null> {
    const row = await this.db.businessSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async getAllBusiness(): Promise<Record<string, Prisma.JsonValue>> {
    const rows = await this.db.businessSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setBusiness(key: BusinessSettingKey, value: Prisma.InputJsonValue, userId: string | null) {
    await this.db.businessSetting.upsert({
      where: { key },
      create: { key, value, updatedById: userId },
      update: { value, updatedById: userId },
    });
  }
}
