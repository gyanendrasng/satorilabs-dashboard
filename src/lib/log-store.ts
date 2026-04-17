export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  logger?: string;
  receivedAt: number;
  // Status-specific fields (from STATUS_WEBHOOK_URL)
  source: 'log' | 'status';
  statusType?: string; // info, action, waiting, success, error, milestone
  step?: number;
  totalSteps?: number;
  agent?: string;
  details?: Record<string, unknown>;
}

type Listener = (log: LogEntry) => void;

const MAX_LOGS = 500;

class LogStore {
  private logs: LogEntry[] = [];
  private listeners: Set<Listener> = new Set();

  push(entry: LogEntry) {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS);
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  getRecent(count = 100): LogEntry[] {
    return this.logs.slice(-count);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear() {
    this.logs = [];
  }
}

// Use globalThis to survive HMR reloads in Next.js dev mode
const globalForLogs = globalThis as unknown as { __logStore?: LogStore };
if (!globalForLogs.__logStore) {
  globalForLogs.__logStore = new LogStore();
}
export const logStore = globalForLogs.__logStore;
