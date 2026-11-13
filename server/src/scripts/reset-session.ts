import { prisma } from '../lib/prisma';

async function resetSession() {
  try {
    const session = await prisma.processingSession.update({
      where: { id: process.argv[2] },
      data: { 
        status: 'open',
        publishedAt: null,
        completedAt: null
      }
    });
    console.log('Session reset:', session.batchName, '->', session.status);
  } catch (e) {
    console.error('Error:', e);
  } finally {
    await prisma.$disconnect();
  }
}

resetSession();
