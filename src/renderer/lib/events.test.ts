import { describe, expect, it } from 'vitest';
import type { LoginStatusDTO } from '../../shared/types';
import { isAppPath } from './events';
import { isLoginActive, isLoginUpdate } from './queries';

const status = (state: LoginStatusDTO['state'], startedAt: number | null = 1): LoginStatusDTO => ({
  state,
  message: '',
  startedAt,
  error: null,
  teams: [],
  connection: null,
});

describe('isAppPath (main’s navigate event)', () => {
  it('accepts in-app paths only', () => {
    expect(isAppPath('/settings')).toBe(true);
    expect(isAppPath('/c/C123?ts=1712345678.123456&thread=1712345678.000100')).toBe(true);
    expect(isAppPath('/')).toBe(true);
    for (const bad of [
      'https://evil.example.com/',
      '//evil.example.com',
      'settings',
      '/a b',
      '/\\evil',
      '',
      null,
      42,
    ]) {
      expect(isAppPath(bad), String(bad)).toBe(false);
    }
  });
});

describe('isLoginUpdate', () => {
  it('never moves one sign-in backwards', () => {
    expect(isLoginUpdate(status('waiting'), status('opening'))).toBe(false);
    expect(isLoginUpdate(status('choose_team'), status('waiting'))).toBe(false);
    expect(isLoginUpdate(status('waiting'), status('verifying'))).toBe(true);
    expect(isLoginUpdate(status('waiting'), status('cancelled'))).toBe(true);
    expect(isLoginUpdate(status('verifying'), status('verifying'))).toBe(true);
  });

  it('always takes a new sign-in or a first answer', () => {
    expect(isLoginUpdate(undefined, status('opening'))).toBe(true);
    expect(isLoginUpdate(status('cancelled', 1), status('opening', 2))).toBe(true);
    expect(isLoginUpdate(status('idle', null), status('opening', 2))).toBe(true);
  });

  it('knows which states mean the Slack window is still in use', () => {
    expect(['opening', 'waiting', 'choose_team', 'verifying'].every((s) => isLoginActive(s as never))).toBe(true);
    expect(['idle', 'connected', 'error', 'cancelled'].some((s) => isLoginActive(s as never))).toBe(false);
    expect(isLoginActive(undefined)).toBe(false);
  });
});
