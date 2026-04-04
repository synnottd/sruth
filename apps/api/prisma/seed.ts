import { PrismaClient, Platform } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  // Idempotent on email — outputs are only created on first run.
  // To reset, delete the user record and re-run.
  const user = await prisma.user.upsert({
    where: { email: 'dev@omega-stream.local' },
    update: {},
    create: {
      email: 'dev@omega-stream.local',
      passwordHash,
      outputs: {
        create: [
          {
            name: 'Twitch Test',
            platform: Platform.TWITCH,
            rtmpUrl: 'rtmp://live.twitch.tv/app',
            streamKey: 'live_test_key_twitch',
            enabled: true,
          },
          {
            name: 'YouTube Test',
            platform: Platform.YOUTUBE,
            rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
            streamKey: 'test-youtube-key',
            enabled: false,
          },
        ],
      },
    },
    include: { outputs: true },
  });

  console.log(`Seeded user: ${user.email} (streamKey: ${user.streamKey})`);
  console.log(`  Outputs: ${user.outputs.map(o => o.name).join(', ')}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
