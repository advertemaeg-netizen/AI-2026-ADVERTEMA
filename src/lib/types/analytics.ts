import type { ChannelType } from './channels'
import type { LeadStatus } from './leads'

export const ANALYTICS_PRESETS = ['today', '7d', '30d', 'month', 'custom'] as const
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number]

export type AnalyticsRange = {
  preset: AnalyticsPreset
  /** Instants, [from, to) */
  from: string
  to: string
  /** Cairo calendar dates shown to the user, inclusive */
  fromDate: string
  toDate: string
  granularity: 'day' | 'week'
}

export type Kpis = {
  conversations: number
  leads: number
  /** leads ÷ conversations, null without conversations */
  conversionRate: number | null
  /** seconds from the visitor's first message to the first reply */
  avgResponseSeconds: number | null
  booked: number
  /** showed up ÷ resolved appointments, null until one is resolved */
  attendanceRate: number | null
}

export type ClientPerformance = {
  clientId: string
  clientName: string
  conversations: number
  leads: number
  booked: number
  showedUp: number
  conversionRate: number | null
  attendanceRate: number | null
}

export type AnalyticsData = {
  range: AnalyticsRange
  previous: { from: string; to: string }
  kpis: { current: Kpis; previous: Kpis }
  series: { date: string; conversations: number; leads: number }[]
  channels: { channel: ChannelType; conversations: number }[]
  peakHours: { hour: number; messages: number }[]
  leadStatuses: { status: LeadStatus; leads: number }[]
  funnel: { conversations: number; leads: number; booked: number; showedUp: number }
  response: {
    responded: number
    medianSeconds: number | null
    agentResponded: number
    agentAvgSeconds: number | null
  }
  /** Only for org admins looking at all clients */
  topClients: ClientPerformance[] | null
}
