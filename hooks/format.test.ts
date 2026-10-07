import { expect, test } from 'claude-code/testing'

import type { Level, Reading } from '../types'
import {
  detailsOf,
  levelOf,
  parseCores,
  parseLoadavg,
  parseMemoryFree,
  parseSimulators,
  runtimeName,
  statusOf,
  toastOf,
} from './format'

const reading = (patch: Partial<Reading> = {}): Reading => ({
  load: [3, 3, 3],
  cores: 10,
  memoryFree: 40,
  simulators: [],
  ...patch,
})

const sims = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `iPhone ${i + 1}`, runtime: 'iOS 26.0' }))

test('reads the load average', async () => {
  expect(parseLoadavg('{ 3.12 2.95 2.80 }\n')).toEqual([3.12, 2.95, 2.8])
  expect(parseLoadavg('{ 212,40 90,10 55,00 }')).toEqual([212.4, 90.1, 55])
  expect(parseLoadavg('')).toBe(undefined)
  expect(parseLoadavg('sysctl: unknown oid')).toBe(undefined)
})

test('reads the core count', async () => {
  expect(parseCores('10\n')).toBe(10)
  expect(parseCores('')).toBe(undefined)
  expect(parseCores('0')).toBe(undefined)
})

test('reads free memory from the line after the page size', async () => {
  const text = 'The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 23%\n'
  expect(parseMemoryFree(text)).toBe(23)
  expect(parseMemoryFree('nothing here')).toBe(undefined)
})

test('names a runtime from its identifier', async () => {
  expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-26-0')).toBe('iOS 26.0')
  expect(runtimeName('com.apple.CoreSimulator.SimRuntime.watchOS-11-0')).toBe('watchOS 11.0')
  expect(runtimeName('com.apple.CoreSimulator.SimRuntime.visionOS')).toBe('visionOS')
})

test('lists the booted simulators and ignores anything unreadable', async () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { name: 'iPhone 17 Pro', state: 'Booted', udid: 'A' },
        { name: 'iPhone 17', state: 'Shutdown', udid: 'B' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{ name: 'iPad Air', state: 'Booted', udid: 'C' }],
      'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [],
    },
  })
  expect(parseSimulators(json)).toEqual([
    { name: 'iPhone 17 Pro', runtime: 'iOS 26.0' },
    { name: 'iPad Air', runtime: 'iOS 18.2' },
  ])
  expect(parseSimulators('{ "devices": {} }')).toEqual([])
  expect(parseSimulators('not json')).toEqual([])
  expect(parseSimulators('null')).toEqual([])
  expect(parseSimulators('{ "devices": { "x": [null, 3] } }')).toEqual([])
})

test('is normal on a calm Mac', async () => {
  expect(levelOf(reading(), 'normal')).toBe('normal')
})

test('turns busy at 1.5 times the cores, under 15% memory or with 3 simulators', async () => {
  expect(levelOf(reading({ load: [14.9, 0, 0] }), 'normal')).toBe('normal')
  expect(levelOf(reading({ load: [15, 0, 0] }), 'normal')).toBe('busy')
  expect(levelOf(reading({ memoryFree: 15 }), 'normal')).toBe('normal')
  expect(levelOf(reading({ memoryFree: 14 }), 'normal')).toBe('busy')
  expect(levelOf(reading({ simulators: sims(2) }), 'normal')).toBe('normal')
  expect(levelOf(reading({ simulators: sims(3) }), 'normal')).toBe('busy')
})

test('turns overloaded at 3 times the cores or under 8% memory', async () => {
  expect(levelOf(reading({ load: [29.9, 0, 0] }), 'normal')).toBe('busy')
  expect(levelOf(reading({ load: [30, 0, 0] }), 'normal')).toBe('overloaded')
  expect(levelOf(reading({ memoryFree: 8 }), 'normal')).toBe('busy')
  expect(levelOf(reading({ memoryFree: 7 }), 'normal')).toBe('overloaded')
  expect(levelOf(reading({ load: [200, 0, 0], simulators: sims(5) }), 'busy')).toBe('overloaded')
})

test('ignores memory when it could not be read', async () => {
  expect(levelOf(reading({ memoryFree: undefined }), 'normal')).toBe('normal')
  expect(levelOf(reading({ memoryFree: undefined, load: [15, 0, 0] }), 'busy')).toBe('busy')
})

test('leaves busy only well clear of every busy limit', async () => {
  // Below 15 but not below 0.8 x 15 = 12.
  expect(levelOf(reading({ load: [13, 0, 0] }), 'busy')).toBe('busy')
  expect(levelOf(reading({ load: [11.9, 0, 0] }), 'busy')).toBe('normal')
  // Memory must be back to 20% (15 + 5).
  expect(levelOf(reading({ memoryFree: 19 }), 'busy')).toBe('busy')
  expect(levelOf(reading({ memoryFree: 20 }), 'busy')).toBe('normal')
  // Fewer than 3 simulators.
  expect(levelOf(reading({ simulators: sims(3) }), 'busy')).toBe('busy')
  expect(levelOf(reading({ simulators: sims(2) }), 'busy')).toBe('normal')
  // A calm Mac does not hold a level it was never in.
  expect(levelOf(reading({ load: [13, 0, 0] }), 'normal')).toBe('normal')
})

test('leaves overloaded only well clear of its limits, then settles on busy or normal', async () => {
  // Below 30 but not below 0.8 x 30 = 24.
  expect(levelOf(reading({ load: [26, 0, 0] }), 'overloaded')).toBe('overloaded')
  // Under 24 but still over the busy line.
  expect(levelOf(reading({ load: [20, 0, 0] }), 'overloaded')).toBe('busy')
  // Memory must be back to 13% (8 + 5).
  expect(levelOf(reading({ memoryFree: 12 }), 'overloaded')).toBe('overloaded')
  expect(levelOf(reading({ memoryFree: 13 }), 'overloaded')).toBe('busy')
  // Clear of overloaded, and nearly clear of busy: busy holds until it is clear too.
  expect(levelOf(reading({ load: [13, 0, 0] }), 'overloaded')).toBe('busy')
  expect(levelOf(reading({ load: [5, 0, 0] }), 'overloaded')).toBe('normal')
})

test('does not flap around a threshold', async () => {
  let level: Level = 'normal'
  const seen: Level[] = []

  for (const load1 of [10, 14, 15, 14, 13, 12.5, 11, 14, 15]) {
    level = levelOf(reading({ load: [load1, 0, 0] }), level)
    seen.push(level)
  }

  expect(seen).toEqual(['normal', 'normal', 'busy', 'busy', 'busy', 'busy', 'normal', 'normal', 'busy'])
})

test('writes the status line, with a mark when busy or overloaded', async () => {
  const calm = reading({ load: [6.2, 0, 0], memoryFree: 23, simulators: sims(2) })
  expect(statusOf(calm, 'normal')).toBe('Mac load 6.2 / 10 cores · 23% memory free · 2 simulators')
  expect(statusOf(calm, 'busy')).toBe('▲ Mac load 6.2 / 10 cores · 23% memory free · 2 simulators')
  expect(statusOf(reading({ load: [6.2, 0, 0], memoryFree: 23 }), 'overloaded')).toBe(
    '◆ Mac load 6.2 / 10 cores · 23% memory free',
  )
  expect(statusOf(reading({ load: [6.2, 0, 0], simulators: sims(1) }), 'normal')).toBe(
    'Mac load 6.2 / 10 cores · 40% memory free · 1 simulator',
  )
  expect(statusOf(reading({ load: [6.2, 0, 0], memoryFree: undefined }), 'normal')).toBe('Mac load 6.2 / 10 cores')
})

test('keeps the status line under 70 characters at its longest', async () => {
  const worst = reading({ load: [212.46, 0, 0], cores: 12, memoryFree: 100, simulators: sims(12) })
  expect(statusOf(worst, 'overloaded').length).toBeLessThan(70)
})

test('toasts on entering busy, entering overloaded and escalating', async () => {
  const busy = reading({ load: [18, 0, 0], simulators: sims(3) })
  expect(toastOf(busy, 'normal', 'busy')).toBe('Mac is busy: load 18 on 10 cores, 3 simulators booted')

  const bogged = reading({ load: [34, 0, 0], memoryFree: 9 })
  const overloaded = 'Mac is overloaded: load 34 on 10 cores, 9% memory free. Shut down simulators or pause builds.'
  expect(toastOf(bogged, 'normal', 'overloaded')).toBe(overloaded)
  expect(toastOf(bogged, 'busy', 'overloaded')).toBe(overloaded)
})

test('says nothing when staying put or stepping down', async () => {
  const bogged = reading({ load: [34, 0, 0] })
  expect(toastOf(bogged, 'overloaded', 'overloaded')).toBe(undefined)
  expect(toastOf(bogged, 'busy', 'busy')).toBe(undefined)
  expect(toastOf(bogged, 'overloaded', 'busy')).toBe(undefined)
  expect(toastOf(bogged, 'busy', 'normal')).toBe(undefined)
  expect(toastOf(bogged, 'normal', 'normal')).toBe(undefined)
})

test('names only the causes that apply in the busy toast', async () => {
  expect(toastOf(reading({ load: [16, 0, 0] }), 'normal', 'busy')).toBe('Mac is busy: load 16 on 10 cores')
  expect(toastOf(reading({ memoryFree: 12 }), 'normal', 'busy')).toBe('Mac is busy: load 3 on 10 cores, 12% memory free')
})

test('details the load, the memory and each booted simulator', async () => {
  const text = detailsOf(
    reading({
      load: [6.2, 5.9, 5.6],
      memoryFree: 23,
      simulators: [
        { name: 'iPhone 17 Pro', runtime: 'iOS 26.0' },
        { name: 'iPad Air', runtime: 'iOS 18.2' },
      ],
    }),
    'busy',
  )
  expect(text).toBe(
    [
      'Mac load: busy',
      'Load: 6.2 (1 min), 5.9 (5 min), 5.6 (15 min), on 10 cores',
      'Busy from load 15, overloaded from 30',
      'Memory free: 23%',
      'Simulators booted: 2',
      '  iPhone 17 Pro (iOS 26.0)',
      '  iPad Air (iOS 18.2)',
      'Shut them all down: xcrun simctl shutdown all',
    ].join('\n'),
  )
})

test('gives no shutdown hint without simulators', async () => {
  const text = detailsOf(reading({ memoryFree: undefined, load: [212.4, 90.1, 55] }), 'overloaded')
  expect(text).toContain('Load: 212 (1 min), 90.1 (5 min), 55.0 (15 min)')
  expect(text).toContain('Memory free: unknown')
  expect(text).toContain('Simulators booted: none')
  expect(text).not.toContain('simctl')
})
