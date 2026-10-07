// What MarketplacesView tells its MarketplaceEntryRow children without a prop (the row's props are frozen from Gate
// P12-0b): whether the rows list several marketplaces (All), so each row names its marketplace in line 2 (docs/UI.md 8.13).
import type { InjectionKey, Ref } from 'vue'

export interface MarketplaceEntryContext {
  /** True on All: line 2 starts with the marketplace name. */
  showMarketplace: Readonly<Ref<boolean>>
}

export const MARKETPLACE_ENTRY_CONTEXT: InjectionKey<MarketplaceEntryContext> = Symbol('marketplace-entry-context')
