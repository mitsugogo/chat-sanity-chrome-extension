import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  zip: {
    artifactTemplate: 'ChatSanity-{{packageVersion}}-{{browser}}.zip',
  },

  manifest: {
    name: 'ChatSanity',
    description: 'YouTube Live Chatを穏やかにするローカルフィルター',
    permissions: ['storage'],
    optional_host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    action: {
      default_title: 'ChatSanity',
    },
  },
});
