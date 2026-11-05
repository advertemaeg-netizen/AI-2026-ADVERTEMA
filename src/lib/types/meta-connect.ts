/**
 * Where a Page and Instagram connect ended, as the channels page shows it
 * (?connect=<status>). Each maps to one string under `channels`.
 */
export const CONNECT_STATUS_MESSAGES = {
  connected: 'connect.connected',
  reconnected: 'connect.reconnected',
  connectedMessagesBlocked: 'connect.connectedMessagesBlocked',
  cancelled: 'connect.cancelled',
  expired: 'connect.expired',
  forbidden: 'connect.forbidden',
  missingPermission: 'connect.missingPermission',
  accountOnOtherClient: 'connect.accountOnOtherClient',
  subscribeFailed: 'connect.subscribeFailed',
  metaError: 'connect.metaError',
  empty: 'picker.empty',
  notShared: 'connect.reconnect.notShared',
  notConfigured: 'connection.notConfigured.description',
  limitReached: 'errors.limitReached',
  limitReachedTwo: 'connect.limitReachedTwo',
  subscriptionInactive: 'errors.subscriptionInactive',
  impersonating: 'errors.impersonating',
  unknown: 'errors.unknown',
} as const

export type ConnectStatus = keyof typeof CONNECT_STATUS_MESSAGES

/** The statuses that are good news (a success toast rather than an error) */
export const CONNECT_SUCCESS: readonly ConnectStatus[] = ['connected', 'reconnected']
/** Connected, with something the clinic must know */
export const CONNECT_WARNING: readonly ConnectStatus[] = ['connectedMessagesBlocked', 'subscribeFailed', 'cancelled']

export function isConnectStatus(value: unknown): value is ConnectStatus {
  return typeof value === 'string' && Object.hasOwn(CONNECT_STATUS_MESSAGES, value)
}

/** What a channel of one choice is, for the clinic picking */
export type PickerAvailability =
  /** Free to connect */
  | 'available'
  /** A channel of this client already has it: picking refreshes that channel */
  | 'connected'
  /** A channel of another client has it, active or paused: refused */
  | 'otherClient'

/** One choice as the picker renders it: ids and names only */
export type PickerOption = {
  pageId: string
  pageName: string
  /** null: the clinic did not offer this Page; Messenger is not a choice */
  messenger: PickerAvailability | null
  instagram: { username: string | null; availability: PickerAvailability } | null
}

export type PickerView = { pendingId: string; clientId: string; clientName: string; options: PickerOption[] }

/** The clinic's pick: one Page, and which of its channels */
export type PickerSelection = { pageId: string; messenger: boolean; instagram: boolean }

export type StartConnectResult = { ok: true; url: string } | { ok: false; status: ConnectStatus }
export type CompleteConnectResult = { ok: boolean; status: ConnectStatus }
