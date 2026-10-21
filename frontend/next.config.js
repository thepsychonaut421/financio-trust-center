/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NODE_ENV === 'production' ? 'standalone' : undefined,
  reactStrictMode: true,
  async headers() {
    return ['/auth/callback', '/admin/:path*', '/access/:path*'].map(source => ({
      source,
      headers: [
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'private, no-store' },
      ],
    }));
  },
  typescript: {
    // Skip type checking in production build (types verified in dev)
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Configure images from external sources
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '4000',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
      {
        protocol: 'https',
        hostname: '*.up.railway.app',
      },
    ],
  },
};

module.exports = nextConfig;
