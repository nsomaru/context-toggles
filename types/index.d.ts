export type Off = { servers: string[]; skills: string[] }

export type ServerEntry = {
  id: string
  label: string
  isNative: boolean
  tools: number
  /** Estimated tokens the server puts in the context: loaded schemas and deferred tool names. */
  tokens: number
}

export type SkillEntry = {
  id: string
  group: string
  isNative: boolean
  tokens: number
  /** The id of the MCP server this skill belongs with, when it has one: it follows that server's switch. */
  server?: string
}

/** What `$.store` keeps under `known`: every server and skill seen in any session. */
export type Known = { servers: ServerEntry[]; skills: SkillEntry[] }

declare module 'claude-code' {
  interface PluginState {
    'context-toggles': {
      off: Off | null
      servers: ServerEntry[]
      skills: SkillEntry[]
      isStarted: boolean
      /** The groups the person has expanded in the panel. */
      open: string[]
      /** What the panel's search box holds. */
      filter: string
    }
  }
}
