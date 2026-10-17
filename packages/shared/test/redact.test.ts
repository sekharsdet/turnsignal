import { describe, it, expect } from 'vitest';
import { redactSecrets, secretEnvValues, parseRedactPatterns, REDACTED } from '../src/redact.js';

describe('redactSecrets (ADR-022)', () => {
  const cases: [string, string][] = [
    ['Authorization: Bearer abc.def.ghi123456', 'Authorization: Bearer [REDACTED]'],
    ['"authorization": "Basic dXNlcjpwYXNzd29yZA=="', '"authorization": "Basic [REDACTED]"'],
    ['fetch failed: https://admin:hunter2secret@db.example.com/x', 'fetch failed: https://admin:[REDACTED]@db.example.com/x'],
    ['postgres://app:s3cr3tP4ss@10.0.0.1:5432/db', 'postgres://app:[REDACTED]@10.0.0.1:5432/db'],
    ['login with password=CorrectHorse9 failed', 'login with password=[REDACTED] failed'],
    ['{"api_key": "abcd1234efgh", "user": "ada"}', '{"api_key": "[REDACTED]", "user": "ada"}'],
    ['GET /v1?access_token=zzzz9999yyyy&page=2', 'GET /v1?access_token=[REDACTED]&page=2'],
    [`token ${'ghp_' + 'a'.repeat(36)} leaked`, `token ${REDACTED} leaked`],
    [`npm ${'npm_' + 'B'.repeat(36)}`, `npm ${REDACTED}`],
    ['key AKIAIOSFODNN7EXAMPLE used', `key ${REDACTED} used`],
    [`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`, `jwt ${REDACTED}`],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', REDACTED],
  ];
  for (const [input, expected] of cases) {
    it(`masks: ${input.slice(0, 40)}`, () => expect(redactSecrets(input)).toBe(expected));
  }

  it('leaves ordinary test output alone', () => {
    const text = [
      'Error: expect(received).toBe(expected) // Object.is equality',
      'Expected: 89',
      'Received: 99',
      "Locator: getByRole('button', { name: 'Place order' })",
      'at tests/checkout.spec.ts:11:65',
      'Timeout 5000ms exceeded while waiting for token field to be visible',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('masks exact values and custom patterns', () => {
    expect(redactSecrets('db pass is Zebra-12345!', { values: ['Zebra-12345!'] })).toBe(`db pass is ${REDACTED}`);
    expect(redactSecrets('ssn 123-45-6789', { patterns: parseRedactPatterns('\\d{3}-\\d{2}-\\d{4}') })).toBe(`ssn ${REDACTED}`);
  });

  it('collects secret-looking env values and ignores the rest', () => {
    expect(
      secretEnvValues({ GITHUB_TOKEN: 'abcdefgh12345', DB_PASSWORD: 'p4ssw0rd!!', CI: 'true', NODE_ENV: 'production', SHORT_KEY: 'abc' }),
    ).toEqual(['abcdefgh12345', 'p4ssw0rd!!']);
  });

  it('skips invalid custom patterns instead of throwing', () => {
    expect(parseRedactPatterns('([unclosed, ok\\d+')).toHaveLength(1);
  });
});
