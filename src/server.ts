import { createContainer } from './container.js';
import { createApp } from './app.js';
import { connectMongo, disconnectMongo } from './infra/database.js';
import { resumePersistedWhatsAppSessions } from './infra/resume-wa-sessions.js';
import { logger } from './common/logger.js';

const gracefulShutdownTimeout = 30000; // 30 seconds

async function main() {
  try {
    // Connect to database
    await connectMongo();
    logger.info('Database connected');

    // Create DI container
    const container = createContainer();

    // Create Express app
    const app = createApp(container);
    const port = container.config.PORT;

    // Start HTTP server
    const server = app.listen(port, () => {
      logger.info({ port }, 'HTTP server listening');
    });

    // Resume WhatsApp sessions from persistent storage
    void resumePersistedWhatsAppSessions(container).catch((err) =>
      logger.error({ err }, 'resumePersistedWhatsAppSessions failed')
    );

    container.campaignQueue.startScheduler();
    container.campaignQueue.recoverAfterBoot();

    // Graceful shutdown on SIGTERM (used by container orchestration)
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received - starting graceful shutdown');
      
      // Stop accepting new connections
      server.close(async () => {
        logger.info('HTTP server closed');
        
        try {
          // Close database connection
          await disconnectMongo();
          logger.info('Database disconnected');
        } catch (err) {
          logger.error({ err }, 'Error disconnecting database');
        }
        
        logger.info('Graceful shutdown complete');
        process.exit(0);
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.error('Graceful shutdown timeout - forcing exit');
        process.exit(1);
      }, gracefulShutdownTimeout);
    });

    // Graceful shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      logger.info('SIGINT received - starting graceful shutdown');
      process.emit('SIGTERM');
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception');
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal({ reason, promise }, 'Unhandled rejection');
      process.exit(1);
    });
  } catch (e) {
    logger.error(e, 'Fatal startup error');
    process.exit(1);
  }
}

main();

