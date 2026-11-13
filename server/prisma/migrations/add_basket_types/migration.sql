-- Add basket type column
ALTER TABLE "baskets" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'batch';

-- Create BasketFolder table
CREATE TABLE IF NOT EXISTS "basket_folders" (
    "id" TEXT NOT NULL,
    "basketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "basket_folders_pkey" PRIMARY KEY ("id")
);

-- Create BasketShare table
CREATE TABLE IF NOT EXISTS "basket_shares" (
    "id" TEXT NOT NULL,
    "basketId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'read',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "basket_shares_pkey" PRIMARY KEY ("id")
);

-- Create unique index on BasketShare
CREATE UNIQUE INDEX IF NOT EXISTS "basket_shares_basketId_projectId_key" ON "basket_shares"("basketId", "projectId");

-- Add foreign keys for BasketFolder
ALTER TABLE "basket_folders" ADD CONSTRAINT "basket_folders_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "basket_folders" ADD CONSTRAINT "basket_folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "basket_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add foreign keys for BasketShare
ALTER TABLE "basket_shares" ADD CONSTRAINT "basket_shares_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "basket_shares" ADD CONSTRAINT "basket_shares_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add folderId to BasketFile
ALTER TABLE "basket_files" ADD COLUMN IF NOT EXISTS "folderId" TEXT;
ALTER TABLE "basket_files" ADD CONSTRAINT "basket_files_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "basket_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
