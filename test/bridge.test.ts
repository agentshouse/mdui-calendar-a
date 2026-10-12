import { expect, test } from 'vitest';
import { createHouseBridgeTestHost } from '@agentshouse/app-bridge/test-host';
import { houseRuntime } from '../src/data/house';

test('uses the exact host-injected bridge runtime without a legacy runtime global', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'houseBridge');
  const host = createHouseBridgeTestHost({ address: '/app/a_z.j' });
  try {
    expect(Object.hasOwn(globalThis, 'houseRuntime')).toBe(false);
    const first = houseRuntime();
    expect(houseRuntime()).toBe(first);
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const runtime = {} as Awaited<ReturnType<typeof houseRuntime>>;
    host.attachRuntime(runtime);
    expect(await first).toBe(runtime);
    expect(await houseRuntime()).toBe(runtime);
    expect(host.tabs).toEqual([{ title: 'Calendar' }]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'houseBridge', previous);
    else Reflect.deleteProperty(globalThis, 'houseBridge');
  }
});
