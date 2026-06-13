import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // Fully static — no server. The bundle runs in a browser iframe sandbox and
    // the AI call goes browser->Claude direct. Host anywhere (Pages, shared host).
    adapter: adapter({
      fallback: 'index.html',
      pages: 'build',
      assets: 'build',
    }),
  },
};

export default config;
