-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TWITCH', 'YOUTUBE', 'FACEBOOK', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StreamSessionStatus" AS ENUM ('STARTING', 'LIVE', 'ERROR', 'STOPPED');

-- CreateEnum
CREATE TYPE "OutputSessionStatus" AS ENUM ('STARTING', 'LIVE', 'ERROR', 'STOPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Output" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "rtmpUrl" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "StreamSessionStatus" NOT NULL DEFAULT 'STARTING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "avgBitrate" INTEGER,
    "peakBitrate" INTEGER,

    CONSTRAINT "StreamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutputSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "status" "OutputSessionStatus" NOT NULL DEFAULT 'STARTING',
    "lastError" TEXT,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "OutputSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_streamKey_key" ON "User"("streamKey");

-- CreateIndex
CREATE UNIQUE INDEX "Output_userId_streamKey_key" ON "Output"("userId", "streamKey");

-- CreateIndex
CREATE INDEX "StreamSession_userId_idx" ON "StreamSession"("userId");

-- CreateIndex
CREATE INDEX "StreamSession_startedAt_idx" ON "StreamSession"("startedAt");

-- CreateIndex
CREATE INDEX "OutputSession_sessionId_idx" ON "OutputSession"("sessionId");

-- CreateIndex
CREATE INDEX "OutputSession_outputId_idx" ON "OutputSession"("outputId");

-- AddForeignKey
ALTER TABLE "Output" ADD CONSTRAINT "Output_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamSession" ADD CONSTRAINT "StreamSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputSession" ADD CONSTRAINT "OutputSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StreamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputSession" ADD CONSTRAINT "OutputSession_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "Output"("id") ON DELETE CASCADE ON UPDATE CASCADE;
