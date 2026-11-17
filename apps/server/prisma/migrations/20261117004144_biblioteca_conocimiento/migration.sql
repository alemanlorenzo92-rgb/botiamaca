/*
  Warnings:

  - You are about to drop the `sync_runs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `webhook_events` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('UPLOAD', 'IMPORT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeKind" AS ENUM ('STYLE', 'FAQ', 'PRODUCT', 'SERVICE', 'POLICY', 'OBJECTION', 'SALES_PROCESS', 'OTHER');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DISABLED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "ChunkKind" AS ENUM ('DOCUMENT', 'EXAMPLE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "description" TEXT,
ALTER COLUMN "external_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "media_id" UUID;

-- AlterTable
ALTER TABLE "product_variants" ALTER COLUMN "external_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "faqs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "features" TEXT,
ADD COLUMN     "recommendations" TEXT,
ADD COLUMN     "usage" TEXT,
ALTER COLUMN "external_id" DROP NOT NULL;

-- DropTable
DROP TABLE "sync_runs";

-- DropTable
DROP TABLE "webhook_events";

-- CreateTable
CREATE TABLE "services" (
    "service" "EventService" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "conditions" TEXT NOT NULL DEFAULT '',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "info" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("service")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[],
    "is_tutorial" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" "MediaSource" NOT NULL DEFAULT 'UPLOAD',
    "product_id" UUID,
    "category_id" UUID,
    "service" "EventService",
    "imported_chat_id" UUID,
    "search_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutorials" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "product_id" UUID,
    "category_id" UUID,
    "service" "EventService",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "search_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutorials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_chats" (
    "id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "participants" TEXT[],
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "media_count" INTEGER NOT NULL DEFAULT 0,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "media_consent" BOOLEAN NOT NULL DEFAULT false,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "imported_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "imported_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_messages" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "author" TEXT NOT NULL,
    "from_owner" BOOLEAN NOT NULL,
    "text" TEXT NOT NULL,
    "media_file" TEXT,
    "dedupe_key" TEXT NOT NULL,

    CONSTRAINT "imported_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "kind" "KnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "temporal" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "conflict_with_id" UUID,
    "conflict_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chat_id" UUID,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "kind" "ChunkKind" NOT NULL,
    "document_id" UUID,
    "chat_id" UUID,
    "text" TEXT NOT NULL,
    "embedding" vector(1536),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_reviews" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "user_id" UUID,
    "note" TEXT,
    "before" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_MediaAssetToTutorial" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_MediaAssetToTutorial_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_sha256_key" ON "media_assets"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_active_kind_idx" ON "media_assets"("active", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "imported_chats_sha256_key" ON "imported_chats"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "imported_messages_dedupe_key_key" ON "imported_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "imported_messages_chat_id_position_idx" ON "imported_messages"("chat_id", "position");

-- CreateIndex
CREATE INDEX "knowledge_documents_status_kind_idx" ON "knowledge_documents"("status", "kind");

-- CreateIndex
CREATE INDEX "knowledge_sources_document_id_idx" ON "knowledge_sources"("document_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_kind_active_idx" ON "knowledge_chunks"("kind", "active");

-- CreateIndex
CREATE INDEX "knowledge_reviews_document_id_idx" ON "knowledge_reviews"("document_id");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "_MediaAssetToTutorial_B_index" ON "_MediaAssetToTutorial"("B");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_service_fkey" FOREIGN KEY ("service") REFERENCES "services"("service") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_imported_chat_id_fkey" FOREIGN KEY ("imported_chat_id") REFERENCES "imported_chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutorials" ADD CONSTRAINT "tutorials_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutorials" ADD CONSTRAINT "tutorials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutorials" ADD CONSTRAINT "tutorials_service_fkey" FOREIGN KEY ("service") REFERENCES "services"("service") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_messages" ADD CONSTRAINT "imported_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "imported_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_conflict_with_id_fkey" FOREIGN KEY ("conflict_with_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "imported_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "imported_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reviews" ADD CONSTRAINT "knowledge_reviews_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MediaAssetToTutorial" ADD CONSTRAINT "_MediaAssetToTutorial_A_fkey" FOREIGN KEY ("A") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MediaAssetToTutorial" ADD CONSTRAINT "_MediaAssetToTutorial_B_fkey" FOREIGN KEY ("B") REFERENCES "tutorials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Búsqueda semántica (pgvector, distancia coseno)
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);
