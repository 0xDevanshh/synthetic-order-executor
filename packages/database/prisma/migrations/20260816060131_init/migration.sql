-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'TRIGGERED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lastProcessedBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_logs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "kind" TEXT NOT NULL,
    "discrepancy" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "triggerPrice" DECIMAL(38,18) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "executionId" TEXT NOT NULL,
    "txHash" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "blockNumber" BIGINT,
    "gasUsed" BIGINT,
    "amountOut" DECIMAL(78,0),
    "monitorAttempts" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_logs_orderId_idx" ON "reconciliation_logs"("orderId");

-- CreateIndex
CREATE INDEX "reconciliation_logs_kind_createdAt_idx" ON "reconciliation_logs"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_executionId_key" ON "orders"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_txHash_key" ON "orders"("txHash");

-- CreateIndex
CREATE INDEX "orders_status_triggerPrice_idx" ON "orders"("status", "triggerPrice");

-- CreateIndex
CREATE INDEX "orders_userAddress_status_idx" ON "orders"("userAddress", "status");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "orders_status_submittedAt_idx" ON "orders"("status", "submittedAt");
