import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build artifact,
  // so Next must transpile them itself.
  transpilePackages: ['@knowledge-explorer/shared', '@knowledge-explorer/database'],
};

export default nextConfig;
