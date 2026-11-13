import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const logLevels = process.env.LOG_LEVEL === 'debug' 
  ? ['query', 'info', 'warn', 'error'] as const
  : ['error', 'warn'] as const;

export const prisma = globalForPrisma.prisma || new PrismaClient({
  log: logLevels.map(level => ({ emit: 'stdout', level })),
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Connection management
let isConnected = false;

export async function connectDatabase(): Promise<void> {
  if (isConnected) {
    console.log('Database already connected');
    return;
  }

  try {
    await prisma.$connect();
    isConnected = true;
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (!isConnected) {
    console.log('Database not connected');
    return;
  }

  try {
    await prisma.$disconnect();
    isConnected = false;
    console.log('✅ Database disconnected successfully');
  } catch (error) {
    console.error('❌ Database disconnection error:', error);
    throw error;
  }
}

export function getPrismaClient(): PrismaClient {
  return prisma;
}

// Handle graceful shutdown
process.on('beforeExit', async () => {
  await disconnectDatabase();
});

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, disconnecting from database...');
  await disconnectDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, disconnecting from database...');
  await disconnectDatabase();
  process.exit(0);
});

// Transaction helper
export async function withTransaction<T>(
  callback: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<T>
): Promise<T> {
  return prisma.$transaction(callback);
}

export default prisma;
