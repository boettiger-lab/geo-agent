export default {
  title: 'Geo-Agent',
  description: 'Map + AI Data Analyst — interactive MapLibre maps with LLM-powered data analysis.',
  base: '/geo-agent/',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Live Demo', link: 'https://boettiger-lab.github.io/geo-agent/', target: '_blank' },
      { text: 'GitHub', link: 'https://github.com/boettiger-lab/geo-agent', target: '_blank' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Quick Start', link: '/guide/quickstart' },
          { text: 'Configuration Reference', link: '/guide/configuration' },
          { text: 'Deployment', link: '/guide/deployment' },
        ],
      },
      {
        text: 'Internals',
        items: [
          { text: 'Agent Loop', link: '/guide/agent-loop' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/boettiger-lab/geo-agent' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },

    search: {
      provider: 'local',
    },
  },
}
