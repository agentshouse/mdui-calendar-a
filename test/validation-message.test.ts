import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validationMessage } from '../src/validation-message';

describe('human-readable form validation', () => {
  it('keeps field context without exposing datetime regex diagnostics', () => {
    const result = z.object({start: z.iso.datetime({offset:true}), end: z.iso.datetime({offset:true})})
      .safeParse({start:'2026-10-', end:'invalid'});
    expect(result.success).toBe(false);
    if (!result.success) expect(validationMessage(result.error)).toBe(
      'Start: enter a complete ISO date and time with a timezone. End: enter a complete ISO date and time with a timezone.');
  });
  it('retains custom validation and provider errors', () => {
    const result = z.object({title:z.string().min(1,'Enter a title.')}).safeParse({title:''});
    if (!result.success) expect(validationMessage(result.error)).toBe('Title: Enter a title.');
    expect(validationMessage(new Error('Save refused: newer edit'))).toBe('Save refused: newer edit');
    expect(validationMessage('Disconnected')).toBe('Disconnected');
  });
});
