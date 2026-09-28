// @ts-check
/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.commands.register({ name: 'never-kept', description: 'Registered before setup fails', template: '{{input}}' })
    throw new Error('boom from setup')
  },
}
