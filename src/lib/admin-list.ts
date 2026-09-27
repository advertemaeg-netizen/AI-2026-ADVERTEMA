import {
  DEFAULT_ORG_SORT,
  ORG_SORT_KEYS,
  ORG_STATUS_FILTERS,
  type OrgSort,
  type OrgSortKey,
  type OrgStatusFilter,
} from '@/lib/types/admin'

export type OrgListParams = { q?: string; sort: OrgSort; status?: OrgStatusFilter }

/** Normalizes the organizations table's URL params (?q, ?sort, ?dir, ?status). */
export function parseOrgListParams(params: Record<string, string | string[] | undefined>): OrgListParams {
  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' ? value : undefined
  }
  const q = one('q')?.trim()
  const key = one('sort')
  const dir = one('dir')
  const status = one('status')

  return {
    q: q ? q.slice(0, 100) : undefined,
    sort: (ORG_SORT_KEYS as readonly string[]).includes(key ?? '')
      ? { key: key as OrgSortKey, dir: dir === 'asc' ? 'asc' : 'desc' }
      : DEFAULT_ORG_SORT,
    status: (ORG_STATUS_FILTERS as readonly string[]).includes(status ?? '')
      ? (status as OrgStatusFilter)
      : undefined,
  }
}
