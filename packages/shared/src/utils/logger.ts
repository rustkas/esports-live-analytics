/**
 * Structured Logger
 * Simple, fast, JSON-based logging
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export interface LoggerOptions {
    service: string;
    level?: LogLevel;
    pretty?: boolean;
}

export class Logger {
    private service: string;
    private minLevel: number;
    private pretty: boolean;

    constructor(options: LoggerOptions) {
        this.service = options.service;
        this.minLevel = LOG_LEVELS[options.level ?? 'info'];
        this.pretty = options.pretty ?? process.env.NODE_ENV !== 'production';
    }

    private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
        if (LOG_LEVELS[level] < this.minLevel) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            service: this.service,
            message,
            ...context,
        };

        const output = this.pretty
            ? this.formatPretty(entry)
            : JSON.stringify(entry);

        if (level === 'error') {
            console.error(output);
        } else if (level === 'warn') {
            console.warn(output);
        } else {
            console.log(output);
        }
    }

    private formatPretty(entry: LogEntry): string {
        const levelColors: Record<LogLevel, string> = {
            debug: '\x1b[90m',
            info: '\x1b[36m',
            warn: '\x1b[33m',
            error: '\x1b[31m',
        };
        const reset = '\x1b[0m';
        const color = levelColors[entry.level];

        const time = entry.timestamp.substring(11, 23);
        const ctx = Object.entries(entry)
            .filter(([k]) => !['timestamp', 'level', 'service', 'message'].includes(k))
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' ');

        return `${color}[${time}]${reset} ${color}${entry.level.toUpperCase().padEnd(5)}${reset} [${entry.service}] ${entry.message}${ctx ? ' ' + ctx : ''}`;
    }

    debug(message: string, context?: Record<string, unknown>): void {
        this.log('debug', message, context);
    }

    info(message: string, context?: Record<string, unknown>): void {
        this.log('info', message, context);
    }

    warn(message: string, context?: Record<string, unknown>): void {
        this.log('warn', message, context);
    }

    error(message: string, context?: Record<string, unknown>): void {
        this.log('error', message, context);
    }

    child(context: Record<string, unknown>): ChildLogger {
        return new ChildLogger(this, context);
    }
}

class ChildLogger {
    constructor(
        private parent: Logger,
        private context: Record<string, unknown>
    ) { }

    debug(message: string, ctx?: Record<string, unknown>): void {
        this.parent.debug(message, { ...this.context, ...ctx });
    }

    info(message: string, ctx?: Record<string, unknown>): void {
        this.parent.info(message, { ...this.context, ...ctx });
    }

    warn(message: string, ctx?: Record<string, unknown>): void {
        this.parent.warn(message, { ...this.context, ...ctx });
    }

    error(message: string, ctx?: Record<string, unknown>): void {
        this.parent.error(message, { ...this.context, ...ctx });
    }
}

// Factory function
export function createLogger(service: string, level?: LogLevel): Logger {
    return new Logger({
        service,
        level: level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info',
        pretty: process.env.NODE_ENV !== 'production',
    });
}
