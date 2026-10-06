# Feed Reader: web

The React + Vite frontend. It talks to the backend over a small REST API under `/api` and holds no data of its own.

```bash
npm install
npm run dev     # http://localhost:5173, proxies /api to the backend on :3001
npm run build   # static files into dist/, which the backend serves
npm run lint    # Oxlint
```

See the [root README](../README.md) for the full picture.
