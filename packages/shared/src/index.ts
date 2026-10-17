export * from './events.js';
export * from './testKey.js';
export * from './redact.js';
export * from './redact-trace.js';

export const REPORTER_VERSION = '0.6.5';

/** The hosted TurnSignal service: the reporter and CLI use it when a token is set but no API URL (ADR-028). */
export const DEFAULT_API_URL = 'https://app.turnsignal.ai';
