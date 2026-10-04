/** Finish unmatched API requests before Vite's HTML fallback. Install last. */
export function apiNotFoundPlugin({ passthroughPaths = [] } = {}) {
  const install = (server) => {
    server.middlewares.use('/api', (req, res, next) => {
      // An embedding app can reserve routes for Vite's downstream proxy.
      if (passthroughPaths.some(path => req.url?.startsWith(path))) return next();
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Unknown API route' }));
    });
  };
  return {
    name: 'api-not-found',
    configureServer: install,
    configurePreviewServer: install,
  };
}
