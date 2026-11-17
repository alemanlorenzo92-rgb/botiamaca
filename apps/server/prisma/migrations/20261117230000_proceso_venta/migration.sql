ALTER TABLE "ai_settings" ADD COLUMN "followup_after_hours" INTEGER DEFAULT 72;
ALTER TABLE "ai_settings" ADD COLUMN "followup_message" TEXT NOT NULL DEFAULT '¡Hola! ¿Pudiste ver lo que te pasé? Contame qué producto te interesó y te paso la info 😊';
ALTER TABLE "conversations" ADD COLUMN "auto_followup_at" TIMESTAMP(3);
