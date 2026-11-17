const isDev = process.env.NODE_ENV === 'development';
const apiUrl = process.env.PANEL_API_URL ?? 'http://localhost:3000';

/**
 * En producción se exporta estático (`out/`) y lo sirve el mismo servidor Fastify.
 * En desarrollo, `next dev` reenvía /api al servidor.
 * @type {import('next').NextConfig}
 */
const config = isDev
  ? {
      async rewrites() {
        return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
      },
    }
  : { output: 'export', images: { unoptimized: true } };

export default { ...config, reactStrictMode: true, poweredByHeader: false, eslint: { ignoreDuringBuilds: true } };
