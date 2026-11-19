import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Known, Off, ServerEntry, SkillEntry } from '../types'

const PANE = 'context-toggles'
const TITLE = 'Context toggles'
const DEFAULTS = 'defaults'
/** Every server and skill seen in any session, so one switched off stays listed. */
const KNOWN = 'known'
/** MCP servers connect after the session starts: read again while they come up. */
const RETRY_MS = [2000, 5000, 10000, 20000]
/** What a deferred tool costs the context: its name on the list ToolSearch reads. */
const NAME_TOKENS = 10

// null until the person changes something in this conversation: until then
// the saved defaults stand.
const off = atom({ plugin: 'context-toggles', key: 'off' } as const, null)
const servers = atom({ plugin: 'context-toggles', key: 'servers' } as const, [])
const skills = atom({ plugin: 'context-toggles', key: 'skills' } as const, [])
const isStarted = atom(
  { plugin: 'context-toggles', key: 'isStarted' } as const,
  false,
)
const open = atom({ plugin: 'context-toggles', key: 'open' } as const, [])
const filter = atom({ plugin: 'context-toggles', key: 'filter' } as const, '')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/

type PoolTool = { name: string; mcp: boolean }

/**
 * The tool pool as the engine built it, before this mod's own `tool.list` hook
 * takes out the servers that are off. Its `$.tool.list()` passes through that
 * same hook, so this is the only place the mod sees a switched-off server's
 * tools, and so its real name (a claude.ai connector is known by a UUID).
 */
let fullPool: PoolTool[] | null = null

/** Reads the whole pool: the mod's own hook stashes it as the call passes through. */
const readPool = async ($: EngineInterface): Promise<PoolTool[]> => {
  const filtered = await $.tool.list().catch(() => [] as PoolTool[])

  return fullPool ?? filtered
}
// The servers Claude's own apps add to a session.
const NATIVE =
  /^(ccd_|Claude_|claude-in-chrome$|claude-artifacts$|terminal$|scheduled-tasks$|mcp-registry$|easel$|plugin-authoring$|visualize$|computer-use$|remote-devices$)/

/** A name a person knows a server by, from its id and its tools' names. */
export const labelOf = (id: string, tools: string[], given?: string): string => {
  if (tools.some(one => /^(outlook|sharepoint|teams)_/.test(one))) {
    return 'Microsoft 365'
  }

  if (UUID.test(id) && tools.includes('guide') && tools.includes('batch')) {
    return 'Claude Docs'
  }

  if (given !== undefined && !UUID.test(given)) {
    return given.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '')
  }

  if (id.startsWith('plugin_')) {
    return id.split('_').at(-1) ?? id
  }

  return UUID.test(id) ? `Connector ${id.slice(0, 8)}` : id
}

export const isNativeServer = (id: string, label: string): boolean =>
  NATIVE.test(id) || label === 'Claude Docs'

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The server a skill belongs with, if any: one the same plugin ships, one the
 * skill is named after, or one its SKILL.md names (its tools, or its name as a word).
 */
export const linkOf = (
  skill: { id: string; group: string },
  text: string,
  candidates: readonly { id: string; label: string }[],
): string | undefined =>
  candidates.find(server => {
    const word = server.label.toLowerCase()
    const name = new RegExp(`(^|[^a-z0-9])${escaped(word)}([^a-z0-9]|$)`, 'i')

    return (
      server.id.startsWith(`plugin_${norm(skill.group)}_`) ||
      text.includes(`mcp__${server.id}__`) ||
      (word.length >= 3 && (name.test(skill.id) || name.test(text)))
    )
  })?.id

const skillGroup = (id: string, source: string, plugin?: string): string =>
  plugin ??
  (id.includes(':')
    ? (id.split(':')[0] ?? source)
    : source === 'userSettings'
      ? 'your skills folder'
      : source === 'projectSettings'
        ? 'this project'
        : source === 'built-in'
          ? 'Claude Code'
          : source)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(one => typeof one === 'string') : []

/** `mcp__server__tool` -> `server`, the id a server is switched by. */
export const serverOf = (tool: string): string | null => {
  if (!tool.startsWith('mcp__')) {
    return null
  }

  const rest = tool.slice(5)
  const end = rest.indexOf('__')

  return end > 0 ? rest.slice(0, end) : null
}

/** The tool pool without the tools of the servers that are off. */
export const keepTools = <T extends { name: string; mcp: boolean }>(
  tools: readonly T[],
  servers: string[],
): T[] =>
  tools.filter(tool => {
    const id = tool.mcp ? serverOf(tool.name) : null

    return id === null || !servers.includes(id)
  })

const norm = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Drops the listing entries (`- name: ...` and their run-on lines) of skills that are off. */
export const stripSkills = (text: string, skills: string[]): string => {
  if (skills.length === 0) {
    return text
  }

  const kept: string[] = []
  let isSkipping = false

  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      const head = line.slice(2)
      isSkipping = skills.some(id => head.startsWith(id + ':'))
    } else if (line.trim() === '') {
      isSkipping = false
    }

    if (!isSkipping) {
      kept.push(line)
    }
  }

  return kept.join('\n')
}

/** Drops the `## server` blocks of servers that are off from an MCP instructions text. */
export const stripServers = (text: string, servers: string[]): string => {
  if (servers.length === 0) {
    return text
  }

  const kept: string[] = []
  let isSkipping = false

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      isSkipping = servers.includes(norm(line.slice(3).trim()))
    } else if (line.startsWith('# ')) {
      isSkipping = false
    }

    if (!isSkipping) {
      kept.push(line)
    }
  }

  return kept.join('\n')
}

const clean = (text: string, type: string, now: Off): string => {
  let out = text

  if (
    type === 'skill_listing' ||
    out.includes('available for use with the Skill tool')
  ) {
    out = stripSkills(out, now.skills)
  }

  if (out.includes('MCP Server Instructions')) {
    out = stripServers(out, now.servers)
  }

  return out
}

const defaults = async ($: EngineInterface): Promise<Off> => {
  const saved = (await $.store.get(DEFAULTS)) as Partial<Off> | undefined

  return { servers: strings(saved?.servers), skills: strings(saved?.skills) }
}

const offNow = async ($: EngineInterface): Promise<Off> =>
  (await read($, off)) ?? (await defaults($))

const apply = ($: EngineInterface): void => {
  $.ui.invalidate('tool.list')
  $.ui.invalidate('prompt.attachment')
  $.ui.invalidate('prompt.section')
}

/** Reads what the session has: its MCP servers (by their tools) and its listed skills. */
const refresh = async ($: EngineInterface): Promise<void> => {
  const names = new Map<string, string[]>()
  const given = new Map<string, string>()
  const loaded = new Map<string, { tokens: number; count: number }>()

  for (const tool of await readPool($)) {
    const id = tool.mcp ? serverOf(tool.name) : null

    if (id !== null) {
      names.set(id, [...(names.get(id) ?? []), tool.name.slice(id.length + 7)])
    }
  }

  const usage = await $.session
    .usage({ breakdown: 'summary' })
    .catch(() => undefined)
  const breakdown = usage?.context.breakdown

  for (const tool of breakdown?.mcpTools ?? []) {
    const id = serverOf(tool.name)

    if (id !== null) {
      given.set(id, tool.serverName)

      if (tool.isLoaded) {
        const had = loaded.get(id) ?? { tokens: 0, count: 0 }
        loaded.set(id, {
          tokens: had.tokens + tool.tokens,
          count: had.count + 1,
        })
      }
    }
  }

  const listed: SkillEntry[] = (breakdown?.skills?.skillFrontmatter ?? []).map(
    skill => {
      const isPrefixed =
        skill.pluginName === undefined ||
        skill.name.startsWith(skill.pluginName + ':')
      const id = isPrefixed ? skill.name : `${skill.pluginName}:${skill.name}`
      const group = skillGroup(id, String(skill.source), skill.pluginName)

      return {
        id,
        group,
        isNative: group === 'Claude Code' || group === 'anthropic-skills',
        tokens: skill.tokens,
      }
    },
  )

  const home = await $.env.get('HOME').catch(() => undefined)
  const mine = [...names]
    .map(([id, tools]) => ({ id, label: labelOf(id, tools, given.get(id)) }))
    .filter(one => !isNativeServer(one.id, one.label))

  // links.json in the mod's folder pairs a skill with a server by hand:
  // { "skill id": "server id or name" }.
  const manual = await $.fs
    .read(`${$.plugin.root}/links.json`)
    .then(text => JSON.parse(text) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>)

  for (const skill of listed) {
    const wanted = manual[skill.id]
    const pinned =
      typeof wanted === 'string'
        ? mine.find(
            one =>
              one.id === wanted ||
              one.label.toLowerCase() === wanted.toLowerCase(),
          )
        : undefined

    if (pinned !== undefined) {
      skill.server = pinned.id
    } else if (!skill.isNative) {
      const text =
        skill.group === 'your skills folder' && home !== undefined
          ? await $.fs
              .read(`${home}/.claude/skills/${skill.id}/SKILL.md`)
              .catch(() => '')
          : ''
      const server = linkOf(skill, text, mine)

      if (server !== undefined) {
        skill.server = server
      }
    }
  }

  // The mod's own `$.tool.list()` passes through its own `tool.list` hook, so a
  // server that is off never shows up in `names`. What earlier sessions saw is
  // kept in the store, and every id that is off is listed even if never seen,
  // so it can always be switched back on.
  const known = await knownOf($)
  const current = await offNow($)
  const saved = await defaults($)
  const offServers = [...new Set([...current.servers, ...saved.servers])]
  const offSkills = [...new Set([...current.skills, ...saved.skills])]

  const nextServers = await update($, servers, (had: ServerEntry[]) => {
    const byId = new Map(
      [...known.servers, ...had].map(one => [one.id, one] as const),
    )

    for (const [id, tools] of names) {
      const label = labelOf(id, tools, given.get(id))
      const now = loaded.get(id)
      // A server that is off has no loaded schemas to count: keep what was seen.
      const tokens =
        now === undefined
          ? (byId.get(id)?.tokens ?? tools.length * NAME_TOKENS)
          : now.tokens + (tools.length - now.count) * NAME_TOKENS

      byId.set(id, {
        id,
        label,
        isNative: isNativeServer(id, label),
        tools: tools.length,
        tokens,
      })
    }

    return withMissingServers([...byId.values()], offServers).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
  })
  const nextSkills = await update($, skills, (had: SkillEntry[]) => {
    const byId = new Map(
      [...known.skills, ...had].map(one => [one.id, one] as const),
    )

    for (const skill of listed) {
      byId.set(skill.id, skill)
    }

    return withMissingSkills([...byId.values()], offSkills).sort((a, b) =>
      a.id.localeCompare(b.id),
    )
  })

  // Remember what was really seen (not placeholders) for the next session.
  await $.store
    .set(KNOWN, {
      servers: (nextServers ?? []).filter(one => one.tools > 0),
      skills: (nextSkills ?? []).filter(one => one.tokens > 0),
    })
    .catch(() => undefined)
}

const knownOf = async ($: EngineInterface): Promise<Known> => {
  const raw = (await $.store.get(KNOWN).catch(() => undefined)) as
    | Partial<Known>
    | undefined
  const list = <T extends { id: unknown }>(value: unknown): T[] =>
    Array.isArray(value)
      ? value.filter(
          (one): one is T =>
            typeof one === 'object' && one !== null && typeof one.id === 'string',
        )
      : []

  return { servers: list(raw?.servers), skills: list(raw?.skills) }
}

/** Adds a placeholder row for each server id that is off but was never seen. */
export const withMissingServers = (
  list: ServerEntry[],
  ids: string[],
): ServerEntry[] => {
  const have = new Set(list.map(one => one.id))
  const extra = ids
    .filter(id => !have.has(id))
    .map(id => {
      const label = labelOf(id, [])

      return { id, label, isNative: isNativeServer(id, label), tools: 0, tokens: 0 }
    })

  return [...list, ...extra]
}

/** Adds a placeholder row for each skill id that is off but was never seen. */
export const withMissingSkills = (
  list: SkillEntry[],
  ids: string[],
): SkillEntry[] => {
  const have = new Set(list.map(one => one.id))
  const extra = ids
    .filter(id => !have.has(id))
    .map(id => {
      const group = skillGroup(id, 'userSettings')

      return { id, group, isNative: false, tokens: 0 }
    })

  return [...list, ...extra]
}

/** Switches servers and skills off, or on, leaving the rest as they are; a server carries its skills. */
const setMany = async (
  $: EngineInterface,
  serverIds: string[],
  skillIds: string[],
  isOff: boolean,
): Promise<void> => {
  const base = await offNow($)
  const linked = (await read($, skills))
    .filter(one => one.server !== undefined && serverIds.includes(one.server))
    .map(one => one.id)
  const change = (had: string[], ids: string[]): string[] => {
    const rest = had.filter(one => !ids.includes(one))

    return isOff ? [...rest, ...ids] : rest
  }

  await update($, off, (cur: Off | null) => {
    const now = cur ?? base

    return {
      servers: change(now.servers, serverIds),
      skills: change(now.skills, [...skillIds, ...linked]),
    }
  })
  apply($)
}

const tokens = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'toggles',
      description:
        'Before the first message: choose which MCP servers and skills this conversation carries',
    })

    return next(e)
  })

  on('command.run', { command: 'toggles' }, async $ => {
    if (await read($, isStarted)) {
      return {
        text: 'This conversation has already started, so its tools are fixed. Run /toggles in a new conversation before the first message.',
      }
    }

    await refresh($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: TITLE })

    // Servers still connecting (npx, uvx, a claude.ai connector) join later.
    for (const ms of RETRY_MS) {
      $.clock.after(ms, () => {
        void refresh($).catch(() => undefined)
      })
    }

    return { text: 'Context toggles opened.' }
  })

  // Once a real turn runs, the choice is made: the panel goes.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !(await read($, isStarted))) {
      await update($, isStarted, () => true)
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    return next(e)
  })

  // The session's tool pool, without the tools of the servers that are off.
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)

    if (listed.value === undefined) {
      return listed
    }

    fullPool = listed.value.map(tool => ({ name: tool.name, mcp: tool.mcp }))
    const now = await offNow($)

    if (now.servers.length === 0) {
      return listed
    }

    return { value: keepTools(listed.value, now.servers) }
  })

  // The skill listing and any MCP instructions the engine injects as a message.
  on('prompt.attachment', async ($, e, next) => {
    const answer = await next(e)

    if (answer.text === null) {
      return answer
    }

    const text = clean(answer.text, String(e.type), await offNow($))

    return text === answer.text ? answer : { text }
  })

  // The same, where they ride in the system prompt.
  on('prompt.section', async ($, e, next) => {
    const answer = await next(e)

    if (answer.text === null) {
      return answer
    }

    const text = clean(answer.text, '', await offNow($))

    return text === answer.text ? answer : { ...answer, text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const saved = await defaults($)
    const chosen = await read($, off)
    const now = chosen ?? saved
    const allServers = await read($, servers)
    const allSkills = await read($, skills)
    const opened = await read($, open)
    const query = (await read($, filter)).trim().toLowerCase()
    const isOffServer = (id: string): boolean => now.servers.includes(id)
    const isOffSkill = (id: string): boolean => now.skills.includes(id)
    const keptOut =
      allServers
        .filter(one => isOffServer(one.id))
        .reduce((sum, one) => sum + one.tokens, 0) +
      allSkills
        .filter(one => isOffSkill(one.id))
        .reduce((sum, one) => sum + one.tokens, 0)
    const summary = `${now.servers.length} servers and ${now.skills.length} skills off`

    if (e.props.placement === 'widget') {
      return <Text>{summary}</Text>
    }

    const linkedTo = (id: string): SkillEntry[] =>
      allSkills.filter(skill => skill.server === id)
    const matches = (...words: string[]): boolean =>
      query === '' || words.some(word => word.toLowerCase().includes(query))
    const isOpen = (key: string): boolean =>
      query !== '' || opened.includes(key)
    const toggleOpen = (key: string) => () =>
      update($, open, (had: string[]) =>
        had.includes(key) ? had.filter(one => one !== key) : [...had, key],
      )
    const mark = (isOff: boolean) =>
      isOff ? <Text color="inactive">○ </Text> : <Text color="success">● </Text>
    const count = (total: number, offCount: number, noun: string): string =>
      `${total} ${noun}${total === 1 ? '' : 's'} · ${
        offCount === 0 ? 'all on' : offCount === total ? 'all off' : `${offCount} off`
      }`

    const bulk = (key: string, serverIds: string[], skillIds: string[]) => (
      <Box gap={1}>
        <Button
          key={`${key}:on`}
          label="All on"
          onPress={() => setMany($, serverIds, skillIds, false)}
        />
        <Button
          key={`${key}:off`}
          label="All off"
          onPress={() => setMany($, serverIds, skillIds, true)}
        />
      </Box>
    )
    const card = (
      title: string,
      note: string,
      side: RenderChildren,
      body: RenderChildren,
    ) => (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        marginTop={1}
      >
        <Box justifyContent="space-between">
          <Box flexDirection="column">
            <Text bold>{title}</Text>
            <Text dimColor>{note}</Text>
          </Box>
          {side}
        </Box>
        {body}
      </Box>
    )
    const serverRows = (list: ServerEntry[]) =>
      list
        .filter(one =>
          matches(one.label, one.id, ...linkedTo(one.id).map(skill => skill.id)),
        )
        .map(one => {
          const linked = linkedTo(one.id)
          const cost = linked.reduce((sum, skill) => sum + skill.tokens, one.tokens)

          return (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Button
                  key={`server:${one.id}`}
                  plain
                  onPress={() => setMany($, [one.id], [], !isOffServer(one.id))}
                >
                  {mark(isOffServer(one.id))}
                  <Text bold={!isOffServer(one.id)} dimColor={isOffServer(one.id)}>
                    {one.label}
                  </Text>
                </Button>
                <Text dimColor>
                  {one.tools === 0
                    ? 'not seen yet'
                    : `${one.tools} tools · ${tokens(cost)}`}
                </Text>
              </Box>
              {linked.length > 0 && (
                <Text dimColor>
                  {'    with '}
                  {linked.length === 1 ? 'skill ' : 'skills '}
                  {linked.map(skill => skill.id).join(', ')}
                </Text>
              )}
            </Box>
          )
        })
    const skillName = (one: SkillEntry): string =>
      one.id.startsWith(one.group + ':')
        ? one.id.slice(one.group.length + 1)
        : one.id
    const skillGroups = (list: SkillEntry[], prefix: string) =>
      [...new Set(list.map(one => one.group))].map(group => {
        const members = list.filter(one => one.group === group)
        const shown = members.filter(one => matches(one.id, group))
        const key = `${prefix}:${group}`

        if (shown.length === 0) {
          return null
        }

        return (
          <Box flexDirection="column" marginTop={1}>
            <Box justifyContent="space-between">
              <Button key={`open:${key}`} plain onPress={toggleOpen(key)}>
                {isOpen(key) ? '▾ ' : '▸ '}
                <Text bold>{group}</Text>
                <Text dimColor>
                  {'  '}
                  {count(
                    members.length,
                    members.filter(one => isOffSkill(one.id)).length,
                    'skill',
                  )}
                </Text>
              </Button>
              {bulk(
                `skills:${key}`,
                [],
                members.map(one => one.id),
              )}
            </Box>
            {isOpen(key) &&
              shown.map(one => (
                <Box justifyContent="space-between" paddingLeft={2}>
                  <Button
                    key={`skill:${one.id}`}
                    plain
                    onPress={() => setMany($, [], [one.id], !isOffSkill(one.id))}
                  >
                    {mark(isOffSkill(one.id))}
                    <Text dimColor={isOffSkill(one.id)}>{skillName(one)}</Text>
                  </Button>
                  <Text dimColor>{tokens(one.tokens)}</Text>
                </Box>
              ))}
          </Box>
        )
      })

    const mine = allServers.filter(one => !one.isNative)
    const native = allServers.filter(one => one.isNative)
    const mySkills = allSkills.filter(
      one => !one.isNative && one.server === undefined,
    )
    const nativeSkills = allSkills.filter(one => one.isNative)
    const isDefault =
      chosen === null ||
      (chosen.servers.length === saved.servers.length &&
        chosen.skills.length === saved.skills.length &&
        chosen.servers.every(one => saved.servers.includes(one)) &&
        chosen.skills.every(one => saved.skills.includes(one)))

    return (
      <Box flexDirection="column">
        <Text bold size="heading">
          What this conversation carries
        </Text>
        <Text color={keptOut > 0 ? 'success' : undefined} dimColor={keptOut === 0}>
          {now.servers.length + now.skills.length === 0
            ? 'Everything is on.'
            : `${summary} · about ${tokens(keptOut)} tokens kept out`}
        </Text>
        <Text dimColor>
          {isDefault
            ? 'This is your saved default.'
            : 'Changed for this conversation only, until you save it as the default.'}
        </Text>
        <Box marginTop={1}>
          <Input
            key="filter"
            placeholder="Filter servers and skills"
            value={query}
            onInput={value => update($, filter, () => value)}
            onSubmit={value => update($, filter, () => value)}
          />
        </Box>

        {card(
          'Your MCP servers',
          mine.length === 0
            ? 'None connected yet. Press Refresh.'
            : `${count(mine.length, mine.filter(one => isOffServer(one.id)).length, 'server')} · a server takes its skills with it`,
          bulk(
            'mine',
            mine.map(one => one.id),
            [],
          ),
          serverRows(mine),
        )}

        {mySkills.length > 0 &&
          card(
            'Your skills',
            count(
              mySkills.length,
              mySkills.filter(one => isOffSkill(one.id)).length,
              'skill',
            ),
            bulk(
              'myskills',
              [],
              mySkills.map(one => one.id),
            ),
            skillGroups(mySkills, 'mine'),
          )}

        {card(
          'Claude built-in',
          `${native.length} servers, ${nativeSkills.length} skills · the app's own tools: task list, browser, sessions, documents`,
          <Button
            key="native"
            label={isOpen('native') ? 'Hide' : 'Show'}
            onPress={toggleOpen('native')}
          />,
          isOpen('native') && (
            <Box flexDirection="column">
              <Text color="warning">
                Switching these off removes app features from the conversation.
              </Text>
              <Box justifyContent="space-between" marginTop={1}>
                <Text bold>Servers</Text>
                {bulk(
                  'native',
                  native.map(one => one.id),
                  [],
                )}
              </Box>
              {serverRows(native)}
              {skillGroups(nativeSkills, 'native')}
            </Box>
          ),
        )}

        <Box gap={1} marginTop={1} flexWrap="wrap">
          <Button
            key="save"
            label="Save as default"
            variant="primary"
            onPress={async () => {
              await $.store.set(DEFAULTS, await offNow($))
              await update($, off, () => null)
              apply($)
              $.ui.toast('New conversations will start with these switched off')
            }}
          />
          {!isDefault && (
            <Button
              key="reset"
              label="Back to default"
              onPress={async () => {
                await update($, off, () => null)
                apply($)
              }}
            />
          )}
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
        <Text dimColor>
          Send your first message when you are done. This panel closes itself.
        </Text>
      </Box>
    )
  })
}
