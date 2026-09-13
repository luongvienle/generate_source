/*
  Warnings:

  - Added the required column `source_segment_checksum` to the `audio_segments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "audio_segments" ADD COLUMN     "source_segment_checksum" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "voice_identifier" TEXT,
ADD COLUMN     "voice_provider_name" TEXT;
