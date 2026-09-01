# PocketPlan

PocketPlan is a private, shared envelope-budget app for two people. Add income and expenses separately, switch between individual and household views, and give each monthly category a spending limit.

## Features

- Separate income and expense tracking for each partner
- Combined household dashboard
- Editable monthly envelopes and limits
- Month-by-month history
- Shared-PIN protection
- Durable SQLite-compatible D1 storage
- Responsive layout for phones and desktops

## Local development

```bash
npm install
npm run db:generate
npm run db:local
npm run dev
```

Open `http://localhost:3000`, enter both names, and create a shared PIN.

## Production

Build with `npm run build`. The app runs as a Cloudflare-compatible Worker via `npm start`, using the `DB` D1 binding and migrations under `drizzle/`.

Set `PUBLIC_SITE_URL` to the deployed HTTPS origin so social previews use the correct absolute URL.

## Privacy

The household PIN is stored as a SHA-256 hash. The PIN itself is kept only in the browser session and sent over HTTPS with API requests. Use a strong PIN and deploy behind HTTPS.

## License

MIT
