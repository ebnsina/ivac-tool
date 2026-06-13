import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // Vercel serverless (Node runtime — required for the bundle vm sandbox).
    // maxDuration covers the bundle execution + AI call; raise on Pro if needed.
    adapter: adapter({
      runtime: 'nodejs20.x',
      maxDuration: 10,
    }),
  },
};

export default config;
