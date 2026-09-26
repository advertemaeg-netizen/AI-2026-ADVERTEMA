'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * Refreshes the server-rendered inbox whenever a visible conversation changes.
 * New messages bump the conversation's last_message_* columns via a trigger,
 * so watching conversations alone is enough. RLS scopes which rows arrive.
 */
export function InboxRealtime() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | undefined

    const channel = supabase
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {
        // Coalesce bursts (message insert + status change) into one refresh
        clearTimeout(timer)
        timer = setTimeout(() => router.refresh(), 500)
      })
      .subscribe()

    return () => {
      clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [router])

  return null
}
