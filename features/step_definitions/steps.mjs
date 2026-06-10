// ESM wrapper so Cucumber loads this (no loader). We then load the TypeScript
// step file in the same process so it uses the same @cucumber/cucumber instance.
await import('./steps.ts')
