import { test, expect, describe } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { getStateDir } from '../src/state-dir'

describe('state-dir', () => {
  test('uses DISCORD_STATE_DIR when set', () => {
    expect(getStateDir({ DISCORD_STATE_DIR: '/tmp/explicit' })).toBe('/tmp/explicit')
  })

  test('DISCORD_STATE_DIR wins over CLAUDE_CONFIG_DIR', () => {
    expect(getStateDir({ DISCORD_STATE_DIR: '/tmp/a', CLAUDE_CONFIG_DIR: '/tmp/b' })).toBe('/tmp/a')
  })

  test('uses CLAUDE_CONFIG_DIR/channels/discord when DISCORD_STATE_DIR unset', () => {
    expect(getStateDir({ CLAUDE_CONFIG_DIR: '/workspaces/.claude' }))
      .toBe('/workspaces/.claude/channels/discord')
  })

  test('falls back to ~/.claude/channels/discord when neither is set', () => {
    expect(getStateDir({})).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  })

  test('treats empty CLAUDE_CONFIG_DIR as unset', () => {
    expect(getStateDir({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  })
})
