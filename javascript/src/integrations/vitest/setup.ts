import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../events/event-bus';
import { Logger } from '../../utils/logger';

const logger = Logger.create('integrations:vitest:setup');

function getProjectRoot() {
  return process.cwd();
}

const projectRoot = getProjectRoot();
const logDir = path.join(projectRoot, '.scenario');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function getLogFilePath(testName: string) {
  return path.join(logDir, `${testName.replace(/[^a-z0-9]/gi, '_')}.log`);
}

let currentTestName: string = '';
let subs: Array<{ unsubscribe: () => void }> = [];

beforeEach((ctx) => {
  currentTestName = ctx.task.id;

  const filePath = getLogFilePath(currentTestName);

  // Clean up any previous log for this test
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  subs = Array.from(EventBus.getAllBuses()).map(bus =>
    bus.eventsObservable.subscribe(event => {
      try {
        fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
      } catch (error) {
        logger.error('Error writing to log file:', error);
      }
    })
  );
});

EventBus.addGlobalListener((bus) => {
  subs.push(
    bus.eventsObservable.subscribe(event => {
      const filePath = getLogFilePath(currentTestName);
      try {
        fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
      } catch (error) {
        logger.error('Error writing to log file:', error);
      }
    })
  );
});

afterEach(() => {
  subs.forEach(sub => sub.unsubscribe());
  subs = [];
  currentTestName = '';
});
