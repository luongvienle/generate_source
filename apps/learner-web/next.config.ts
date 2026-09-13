import { config as loadEnv } from 'dotenv';

// Next reads .env from this app's directory; the repository keeps a single
// .env at the root, so load it before the config is evaluated.
loadEnv({ path: '../../.env' });

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build artifact,
  // so Next must transpile them itself. `content` carries the lesson renderer
  // the reader shares with the admin preview (FR-EDIT-01).
  transpilePackages: [
    '@knowledge-explorer/shared',
    '@knowledge-explorer/database',
    '@knowledge-explorer/content',
  ],
};

export default nextConfig;
