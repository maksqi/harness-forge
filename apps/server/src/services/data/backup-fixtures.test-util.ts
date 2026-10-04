// Test helpers of the Phase 10 backup and restore tests (W10.6-T2): the `dataApp` of ./fixtures.test-util.ts (the fake
// chats service, the real files service, a recording event bus, a fake runner and the fake checkpoint service) with the
// C30 fake customization service (`createFakeCustomizationService`, personal definitions in memory, `customization.changed`
// on the app's event bus), plus definition builders. Close the apps with `closeCustomizedApps()` in `afterEach`.
import type { CustomizationKind } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import type { AppDeps } from '../../types.ts'
import type { CustomizationService } from '../customizations/types.ts'
import type { DataServiceOptions } from './index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointService } from '../../testing/fake-checkpoints.ts'
import { createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { createFakeChatRunner, createFakeChatsService, createRecordingEventBus } from '../../testing/fakes.ts'
import { createFilesService } from '../files/index.ts'
import { createDataService } from './index.ts'

export interface CustomizedDataApp {
  t: TestApp
  deps: AppDeps
  events: RecordingEventBus
  runs: FakeChatRunner
  /** The fake behind `deps.customizations` (before `wrap`). */
  customizations: FakeCustomizationService
}

export interface CustomizedDataAppOptions {
  data?: DataServiceOptions
  /** Wraps the fake customization service (e.g. a failing `exportBackup`). */
  wrap?: (service: FakeCustomizationService) => CustomizationService
}

const apps: TestApp[] = []

export async function customizedDataApp(options: CustomizedDataAppOptions = {}): Promise<CustomizedDataApp> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  let fake!: FakeCustomizationService
  const t = await createTestApp({
    start: false,
    overrides: { events, runs, checkpoints: createFakeCheckpointService() },
    factories: {
      chats: deps => createFakeChatsService(deps),
      data: deps => createDataService(deps, options.data),
      files: deps => createFilesService(deps),
      customizations: (deps) => {
        fake = createFakeCustomizationService({ events: deps.events })
        return options.wrap?.(fake) ?? fake
      },
    },
  })
  apps.push(t)
  return { t, deps: t.deps, events, runs, customizations: fake }
}

export async function closeCustomizedApps(): Promise<void> {
  for (const app of apps.splice(0))
    await app.close()
}

/** A valid personal definition of `kind`: frontmatter `name` and `description`, then the body. */
export function definition(kind: CustomizationKind, name: string, body = `The ${name} body.`): string {
  if (kind === 'command')
    return `---\nname: ${name}\ndescription: The ${name} command.\n---\n${body} $ARGUMENTS\n`
  return `---\nname: ${name}\ndescription: The ${name} ${kind}.\n---\n${body}\n`
}
