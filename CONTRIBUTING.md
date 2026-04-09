# Contributing to Schedule Planner

Thanks for your interest in contributing! Here's how to get started.

## Development

```bash
git clone https://github.com/interestingcodelol/schedule-planner.git
cd schedule-planner
npm install
npm run dev
```

## Running tests

```bash
npm test          # single run
npm run test:watch # watch mode
```

## Code style

- TypeScript strict mode
- Prettier for formatting (`npm run format`)
- ESLint for linting (`npm run lint`)

## Pull requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run `npm run typecheck && npm run lint && npm test` to verify
4. Open a PR with a clear description

## Privacy

Schedule Planner is a client-side-only tool. Please do not introduce:
- External API calls or telemetry
- Server-side dependencies
- Hardcoded personal data or employer-specific information
