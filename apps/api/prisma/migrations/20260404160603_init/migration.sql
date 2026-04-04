-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('twitch', 'youtube', 'facebook', 'custom');

-- CreateEnum
CREATE TYPE "OutputSessionStatus" AS ENUM ('starting', 'live', 'error', 'stopped');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "streamKey" TEXT NOT NULL,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

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

    CONSTRAINT "Output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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
    "status" "OutputSessionStatus" NOT NULL DEFAULT 'starting',
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
CREATE INDEX "User_streamKey_idx" ON "User"("streamKey");

-- CreateIndex
CREATE INDEX "Output_userId_idx" ON "Output"("userId");

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
