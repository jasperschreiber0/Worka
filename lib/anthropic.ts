/**
 * Central Anthropic model configuration.
 *
 * Single source of truth for the Claude model used across all Next.js API
 * routes. Override per-environment with the ANTHROPIC_MODEL env var without
 * touching code.
 *
 * `claude-sonnet-4-6` is a currently supported model. It runs with no
 * extended thinking by default, so `response.content[0]` is a text block —
 * which every caller here relies on when reading the model's reply.
 */
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
