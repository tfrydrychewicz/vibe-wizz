/**
 * Provider registry — maps provider IDs to their implementations.
 *
 * To add a new provider:
 *   1. Create src/main/calendar/sync/providers/<name>.ts implementing CalendarProvider
 *   2. Import it here and add it to PROVIDERS
 */
import type { CalendarProvider } from './provider'
import { googleAppsScriptProvider }      from './providers/googleAppsScript'
import { googleAppsScriptRelayProvider } from './providers/googleAppsScriptRelay'
import { jsonbinProvider }               from './providers/jsonbin'
// import { icalProvider }      from './providers/ical'      // future
// import { googleApiProvider } from './providers/googleApi' // future
// import { outlookProvider }   from './providers/outlook'   // future

const PROVIDERS: Record<string, CalendarProvider> = {
  [googleAppsScriptProvider.id]:      googleAppsScriptProvider,
  [googleAppsScriptRelayProvider.id]: googleAppsScriptRelayProvider,
  [jsonbinProvider.id]:               jsonbinProvider,
}

/** Look up a provider by its stable ID. Returns undefined for unknown IDs. */
export function getProvider(id: string): CalendarProvider | undefined {
  return PROVIDERS[id]
}

/** All currently registered provider IDs (for UI display). */
export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS)
}
