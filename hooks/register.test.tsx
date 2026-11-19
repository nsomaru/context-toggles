import { expect, mock, test } from 'claude-code/testing'

import {
  isNativeServer,
  keepTools,
  linkOf,
  labelOf,
  stripServers,
  stripSkills,
} from './register'

const TOOLS = [
  { name: 'Read', description: 'reads', mcp: false },
  { name: 'mcp__blender__look', description: 'looks', mcp: true },
  { name: 'mcp__rea__open_binary', description: 'opens', mcp: true },
]

const PANE = {
  plugin: 'context-toggles',
  component: 'Pane',
  requestId: 'context-toggles',
  props: {
    title: 'Context toggles',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the tools of a server that is off leave the pool', () => {
  expect(keepTools(TOOLS, ['blender']).map(tool => tool.name)).toEqual([
    'Read',
    'mcp__rea__open_binary',
  ])
  expect(keepTools(TOOLS, []).length).toBe(3)
})

test('servers are named and sorted into yours and built-in', () => {
  const uuid = 'd9c7b121-3b7e-4e63-b7b7-d739c98bbfe7'

  expect(labelOf(uuid, ['outlook_send_mail', 'get_me'])).toBe('Microsoft 365')
  expect(labelOf('plugin_serena_serena', ['serena_repl'])).toBe('serena')
  expect(labelOf('rea', ['open_binary'], 'rea')).toBe('rea')
  expect(isNativeServer('ccd_turn', 'ccd_turn')).toBe(true)
  expect(isNativeServer('Claude_Browser', 'Claude_Browser')).toBe(true)
  expect(isNativeServer('blender', 'blender')).toBe(false)
  expect(isNativeServer(uuid, 'Microsoft 365')).toBe(false)
})

test('a skill is linked to the server it belongs with', () => {
  const candidates = [
    { id: 'rea', label: 'rea' },
    { id: 'blender', label: 'blender' },
    { id: 'plugin_serena_serena', label: 'serena' },
  ]
  const folder = 'your skills folder'

  expect(
    linkOf(
      { id: 'reverse-engineer-anything', group: folder },
      'Reverse engineer targets with REA. Use shipped evidence.',
      candidates,
    ),
  ).toBe('rea')
  expect(
    linkOf({ id: 'ipsw', group: folder }, 'Apple firmware research and more.', candidates),
  ).toBeUndefined()
  expect(linkOf({ id: 'blender-scenes', group: folder }, '', candidates)).toBe('blender')
  expect(linkOf({ id: 'serena:onboard', group: 'serena' }, '', candidates)).toBe(
    'plugin_serena_serena',
  )
  expect(
    linkOf({ id: 'x', group: folder }, 'call mcp__blender__look first', candidates),
  ).toBe('blender')
})

test('the panel switches a server, hides built-ins, and closes once a turn starts', async ($, on) => {
  let closed = 0
  mock.store(on)
  on('tool.list', () => ({
    value: [...TOOLS, { name: 'mcp__ccd_turn__wrap_up', description: 'wraps', mcp: true }],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => {
    closed += 1

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toggles' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = () =>
    $.command.run({ command: 'toggles', args: '' } as Parameters<
      typeof $.command.run
    >[0])
  await run()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'server:rea' }))?.text).toMatch(/●/)
    expect(await ui.find({ key: 'server:ccd_turn' })).toBeUndefined()
    await ui.press({ key: 'server:rea' })
    expect((await ui.find({ key: 'server:rea' }))?.text).toMatch(/○/)
    await ui.press({ key: 'mine:on' })
    expect((await ui.find({ key: 'server:rea' }))?.text).toMatch(/●/)
    await ui.press({ key: 'native' })
    expect(await ui.find({ key: 'server:ccd_turn' })).toBeDefined()
    await ui.press({ key: 'native' })
    await ui.input({ key: 'filter', text: 'blen' })
    expect(await ui.find({ key: 'server:rea' })).toBeUndefined()
    expect(await ui.find({ key: 'server:blender' })).toBeDefined()
    await ui.input({ key: 'filter', text: '' })
    await ui.unmount()
  }

  await $.turn.start({ text: 'hello', turnId: 't1' } as Parameters<
    typeof $.turn.start
  >[0])
  expect(closed).toBe(1)
  expect(JSON.stringify(await run())).toMatch(/already started/)
})

test('servers switched off by default still show, so they can be switched back on', async ($, on) => {
  const ms365 = 'd9c7b121-3b7e-4e63-b7b7-d739c98bbfe7'
  mock.store(on, {
    defaults: { servers: ['blender', 'rea', ms365], skills: ['ipsw'] },
    // What an earlier session saw while Microsoft 365 was on.
    known: {
      servers: [
        { id: ms365, label: 'Microsoft 365', isNative: false, tools: 50, tokens: 500 },
      ],
      skills: [],
    },
  })
  on('tool.list', () => ({ value: TOOLS }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toggles' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'toggles', args: '' } as Parameters<
    typeof $.command.run
  >[0])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'server:rea' }))?.text).toMatch(/○/)
    expect((await ui.find({ key: 'server:blender' }))?.text).toMatch(/○/)
    expect((await ui.find({ key: `server:${ms365}` }))?.text).toMatch(
      /○.*Microsoft 365/,
    )
    await ui.press({ key: 'server:rea' })
    expect((await ui.find({ key: 'server:rea' }))?.text).toMatch(/●/)
    await ui.press({ key: 'server:rea' })
    await ui.unmount()
  }
})

test('a connector switched off by default keeps its real name and tool count', async ($, on) => {
  const ms365 = 'd9c7b121-3b7e-4e63-b7b7-d739c98bbfe7'
  mock.store(on, { defaults: { servers: [ms365], skills: [] } })
  on('tool.list', () => ({
    value: [
      ...TOOLS,
      { name: `mcp__${ms365}__outlook_send_mail`, description: 'sends', mcp: true },
      { name: `mcp__${ms365}__teams_post`, description: 'posts', mcp: true },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toggles' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'toggles', args: '' } as Parameters<
    typeof $.command.run
  >[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await ui.find({ key: `server:${ms365}` }))?.text ?? ''
  expect(row).toMatch(/○.*Microsoft 365/)
  expect(row).not.toMatch(/Connector/)
  expect(JSON.stringify(await ui.find({ key: `server:${ms365}` }))).not.toMatch(/not seen yet/)
  await ui.unmount()
})

test('the skill listing loses the entries that are off, run-on lines included', () => {
  const listing = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- pdf: Work with PDFs.',
    '- claude-api: Reference for the API.',
    'TRIGGER - read first.',
    '- mattpocock-skills:pr: Use when writing a PR body.',
    '- prototype: Build a prototype.',
  ].join('\n')

  expect(stripSkills(listing, ['claude-api', 'mattpocock-skills:pr'])).toBe(
    [
      'The following skills are available for use with the Skill tool:',
      '',
      '- pdf: Work with PDFs.',
      '- prototype: Build a prototype.',
    ].join('\n'),
  )
})

test('MCP instructions lose the blocks of servers that are off', () => {
  const text = [
    '# MCP Server Instructions',
    '## blender',
    'Drive Blender.',
    '## plugin:serena:serena',
    'Read the manual.',
    '# Next',
    'kept',
  ].join('\n')

  expect(stripServers(text, ['plugin_serena_serena'])).toBe(
    ['# MCP Server Instructions', '## blender', 'Drive Blender.', '# Next', 'kept'].join('\n'),
  )
})
